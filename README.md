# Jotform → McLeod TMS Integration

Automated customer onboarding from Jotform submissions to McLeod TMS via REST API.

## Overview

This service receives Jotform webhook submissions and creates/updates customer records in McLeod TMS with:

- **Zero credit limit** (pending manual approval)
- **Credit status set to TENTATIVE** (T) — do not extend terms
- Salesperson assignment based on form selection
- Contact information (Logistics + AP) via ContactService
- Agreement document storage via ImagingService
- Idempotent processing (no duplicate customers)
- "PENDING CREDIT APPROVAL" comment via CommentService

**IMPORTANT:** McLeod uses REST API (NOT SOAP). All endpoints are under `/ws/api`.

## Architecture

```
Jotform → Webhook → Azure Function → McLeod REST API
                         ↓             (/ws/api)
                    Idempotency          ↓
                    (Azure Table)   CustomerService
                         ↓          ContactService
                  Document Storage  CommentService
                  (McLeod Imaging   ImagingService
                   / Azure Blob)
                         ↓
                   Slack Alerts
```

## Quick Start

### Prerequisites

- Node.js 18+
- Azure Functions Core Tools v4
- McLeod TMS REST API access (under `/ws/api`)
- Jotform API key

### Installation

```bash
# Clone repository
git clone <repo-url>
cd jotform-mcleod-integration

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit configuration - fill in your credentials
```

### Local Development

```bash
# Build TypeScript
npm run build

# Start Azure Functions locally
npm start

# OR run standalone local server
npm run start:local
```

### Test Webhook Endpoint

```bash
# Health check
curl http://localhost:7071/api/health

# Submit test payload
curl -X POST http://localhost:7071/api/webhook/jotform \
  -H "Content-Type: application/json" \
  -d @test/sample-payload.json
```

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `MCLEOD_BASE_URL` | McLeod REST API base URL (e.g., `https://tms.mcleodhosted.com/ws/api`) |
| `MCLEOD_AUTH_MODE` | Auth mode: `token`, `basic`, or `login` |
| `MCLEOD_USERNAME` | McLeod API username (for basic/login) |
| `MCLEOD_PASSWORD` | McLeod API password (for basic/login) |
| `MCLEOD_TOKEN` | Pre-existing token (for token auth mode) |

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCLEOD_ANYWHERE_COMPANY_ID` | `TMS` | Company ID for multi-tenant |
| `MCLEOD_AGREEMENT_DOCUMENT_TYPE_ID` | `AGREEMENT` | Doc type for uploads |
| `JOTFORM_API_KEY` | - | Jotform API key |
| `JOTFORM_WEBHOOK_SECRET` | - | Webhook signature secret |
| `SLACK_WEBHOOK_URL` | - | Slack incoming webhook URL |
| `ENABLE_SLACK_ALERTS` | `false` | Enable Slack notifications |
| `ENABLE_DOCUMENT_UPLOAD` | `true` | Enable document storage |
| `AZURE_TABLE_CONNECTION_STRING` | - | Azure Table for idempotency |
| `AZURE_BLOB_CONNECTION_STRING` | - | Azure Blob for doc fallback |
| `LOG_LEVEL` | `info` | Logging level |

See `.env.example` for complete list.

## API Endpoints

### POST /api/webhook/jotform

Receives Jotform webhook payload and processes customer onboarding.

**Request:** Jotform webhook JSON payload

**Response:**
```json
{
  "success": true,
  "customerId": "BB3456789",
  "created": true,
  "documentUploaded": true,
  "documentLocation": "McLeod Imaging: DOC123456"
}
```

### GET /api/health

Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "service": "jotform-mcleod-integration",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## McLeod REST API Integration

### Endpoints Used

Per the McLeod API documentation:

| Service | Endpoint | Method | Purpose |
|---------|----------|--------|---------|
| CustomerService | `/customers/new` | GET | Get default RowCustomer template |
| CustomerService | `/customers/search` | GET | Search by EIN or name |
| CustomerService | `/customers/{id}` | GET | Get customer by ID |
| CustomerService | `/customers/create` | PUT | Create new customer |
| CustomerService | `/customers/update` | PUT | Update existing customer |
| ContactService | `/contacts/C/{customerId}` | GET | Get customer contacts |
| ContactService | `/contacts/create` | PUT | Create contact |
| CommentService | `/comments/create` | PUT | Create customer comment |
| ImagingService | `/images/C/{customerId}/{docType}` | POST | Upload PDF |
| UserService | `/users/login` | POST | Get auth token |

### Authentication

Three modes supported:

1. **Token Mode:** Use pre-existing long-lived token
   ```
   MCLEOD_AUTH_MODE=token
   MCLEOD_TOKEN=your_token
   ```

2. **Basic Mode:** Basic Auth on every request
   ```
   MCLEOD_AUTH_MODE=basic
   MCLEOD_USERNAME=user
   MCLEOD_PASSWORD=pass
   ```

3. **Login Mode (Recommended):** Get Bearer token via `/users/login`
   ```
   MCLEOD_AUTH_MODE=login
   MCLEOD_USERNAME=user
   MCLEOD_PASSWORD=pass
   ```

### Customer Matching Logic

The integration uses a multi-step matching strategy based on verified working endpoints:

1. **Deterministic ID Lookup:** `GET /customers?q={customerId}` - Checks if the generated customer ID already exists
2. **Name + Address Search:** `GET /customers/search?customer.name=...&customer.city=...&customer.state_id=...`
3. **General Query Fallback:** `GET /customers?q={legalName}` with city/state verification

**NOTE:** EIN matching via `customer.federal_id` is disabled until the field is verified in `GET /customers/new`.

**IMPORTANT:** McLeod uses `state_id` (not `state`) based on verified live response.

If found → UPDATE. If not found → CREATE.

### Credit Settings

Credit status codes in this McLeod instance:
- **A** = Approved (credit approved, can extend terms)
- **D** = Denied (credit denied, do not extend terms)
- **T** = Tentative (pending approval, do not extend terms)

All new customers from Jotform are created with:
- `credit_limit`: 0
- `credit_status`: T (Tentative)
- Comment: "PENDING CREDIT APPROVAL — DO NOT EXTEND TERMS"

**Important:** When updating existing customers, the integration will NOT overwrite `credit_status` or `credit_limit` if the customer is already Approved (A).

### Salesperson Mapping

Update `src/config/index.ts` with your sales team:

```typescript
const SALESPERSON_MAP = {
  "Larry Dyer": "LDYER",
  "John Smith": "JSMITH",
  // Add your team
  "_DEFAULT": "UNASSIGNED"
};
```

Unknown salespeople trigger a Slack alert.

## Document Storage

Signed agreements are stored in order of preference:

1. **McLeod Imaging** (`POST /images/C/{customerId}/{documentTypeId}`)
2. **Azure Blob Storage** (fallback)
3. **Jotform URL in customer comment** (last resort)

## Sandbox Validation Checklist

Before production deployment, validate these scenarios:

### Authentication Tests
- [ ] **Test 1:** Verify `/users/login` returns token with valid credentials
- [ ] **Test 2:** Verify authenticated requests work with Bearer token
- [ ] **Test 3:** Verify 401 triggers token refresh and retry

### Customer Operations
- [ ] **Test 4:** `GET /customers/new` returns valid RowCustomer template - check for federal_id field
- [ ] **Test 5:** `GET /customers?q={customerId}` returns matching customer (deterministic ID lookup)
- [ ] **Test 6:** Search by name+city+state_id returns matching customer
- [ ] **Test 7:** `PUT /customers/create` successfully creates new customer
- [ ] **Test 8:** `PUT /customers/update` preserves credit if already Approved (A)
- [ ] **Test 9:** Verify credit_limit=0 and credit_status=T on new customers
- [ ] **Test 9a:** Verify EIN field name in /customers/new response (to enable EIN matching later)

### Contact Operations
- [ ] **Test 10:** `PUT /contacts/create` successfully creates Logistics contact
- [ ] **Test 11:** `PUT /contacts/create` successfully creates AP contact

### Comment Operations
- [ ] **Test 12:** `PUT /comments/create` adds "PENDING CREDIT APPROVAL" comment

### Document Operations
- [ ] **Test 13:** `POST /images/C/{id}/{docType}` uploads PDF successfully
- [ ] **Test 14:** Verify fallback to Azure Blob when McLeod Imaging fails

### Idempotency Tests
- [ ] **Test 15:** Duplicate submission returns existing customer, no new creation
- [ ] **Test 16:** Azure Table Storage correctly stores/retrieves idempotency records

### Alert Tests
- [ ] **Test 17:** Processing failure sends Slack alert
- [ ] **Test 18:** Unknown salesperson sends Slack alert
- [ ] **Test 19:** Document upload failure sends Slack alert

## Local Test Instructions

### 1. Setup Environment

```bash
cp .env.example .env
# Edit .env with your sandbox credentials
```

### 2. Run Tests

```bash
# Run unit tests
npm test

# Run integration tests (requires sandbox credentials)
MCLEOD_BASE_URL=https://sandbox.mcleod.com/ws/api \
MCLEOD_AUTH_MODE=login \
MCLEOD_USERNAME=testuser \
MCLEOD_PASSWORD=testpass \
npm run test:integration
```

### 3. Manual Testing with cURL

```bash
# Get auth token
curl -X POST https://your-mcleod.com/ws/api/users/login \
  -u "username:password" \
  -H "Content-Type: application/json"

# Get customer defaults
curl -X GET https://your-mcleod.com/ws/api/customers/new \
  -H "Authorization: Bearer YOUR_TOKEN"

# Search by EIN
curl -X GET "https://your-mcleod.com/ws/api/customers/search?customer.federal_id=123456789" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Create customer (example)
curl -X PUT https://your-mcleod.com/ws/api/customers/create \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "TEST001",
    "name": "TEST COMPANY",
    "address1": "123 TEST ST",
    "city": "DALLAS",
    "state": "TX",
    "zip_code": "75201",
    "credit_limit": 0,
    "credit_status": "T"
  }'

# Test webhook locally
curl -X POST http://localhost:7071/api/webhook/jotform \
  -H "Content-Type: application/json" \
  -d @test/sample-payload.json
```

## Deployment

### Azure Functions

```bash
# Build
npm run build

# Deploy using Azure CLI
func azure functionapp publish <function-app-name>

# Or deploy using VS Code Azure Functions extension
```

### Environment Variables in Azure

```bash
az functionapp config appsettings set \
  --name <function-app-name> \
  --resource-group <resource-group> \
  --settings \
    MCLEOD_BASE_URL=https://tms.mcleodhosted.com/ws/api \
    MCLEOD_AUTH_MODE=login \
    MCLEOD_USERNAME=api_user \
    MCLEOD_PASSWORD=@Microsoft.KeyVault(SecretUri=...) \
    AZURE_TABLE_CONNECTION_STRING=@Microsoft.KeyVault(...) \
    ENABLE_SLACK_ALERTS=true \
    SLACK_WEBHOOK_URL=https://hooks.slack.com/...
```

## Monitoring

### Logs

- Local: Console output (JSON structured logs)
- Azure: Application Insights

### Alerts

Failures trigger Slack notifications including:
- Submission ID
- Company name
- Error message
- McLeod endpoint that failed
- Action required

## Troubleshooting

### Common Issues

1. **401 Unauthorized**
   - Verify credentials are correct
   - Check auth mode setting
   - Ensure IP is whitelisted in McLeod

2. **Customer search returns empty**
   - Verify query parameter format (`customer.federal_id`)
   - Check if EIN format matches (no hyphens)

3. **Document upload fails**
   - Verify `MCLEOD_AGREEMENT_DOCUMENT_TYPE_ID` exists in McLeod
   - Check file size limits
   - Falls back to Azure Blob automatically

4. **Duplicate customer created**
   - Check if idempotency store is configured
   - Set `AZURE_TABLE_CONNECTION_STRING` for production

## Project Structure

```
├── src/
│   ├── config/             # Configuration + salesperson map
│   ├── handlers/           # Azure Function handlers
│   ├── services/
│   │   ├── mcleod-client.ts    # McLeod REST API client
│   │   ├── jotform-client.ts   # Jotform API client
│   │   ├── document-handler.ts # Document storage (Imaging/Blob)
│   │   └── customer-processor.ts # Main processing logic
│   ├── types/              # TypeScript types (RowCustomer, etc.)
│   └── utils/              # Logging, alerting, idempotency
├── test/
│   └── sample-payload.json # Test webhook payload
├── .env.example            # Environment template
├── package.json
└── tsconfig.json
```

## Support

For issues, contact the integration team or file an issue in this repository.
