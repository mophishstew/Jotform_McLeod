# Jotform → McLeod TMS Integration

Automated customer onboarding from Jotform submissions to McLeod TMS.

## Overview

This service receives Jotform webhook submissions and creates/updates customer records in McLeod TMS with:

- **Zero credit limit** (pending manual approval)
- **Credit status set to HOLD**
- Salesperson assignment based on form selection
- Contact information (Logistics + AP)
- Agreement document storage
- Idempotent processing (no duplicate customers)

## Architecture

```
Jotform → Webhook → Azure Function → McLeod TMS
                         ↓
                  Document Storage
                  (McLeod/Azure Blob)
                         ↓
                   Slack Alerts
```

## Quick Start

### Prerequisites

- Node.js 18+
- Azure Functions Core Tools v4
- McLeod TMS Web Services access
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
cp local.settings.json.example local.settings.json

# Edit configuration
# Fill in your McLeod, Jotform, and Slack credentials
```

### Local Development

```bash
# Build TypeScript
npm run build

# Start Azure Functions locally
npm start

# Test webhook endpoint
curl -X POST http://localhost:7071/api/webhook/jotform \
  -H "Content-Type: application/json" \
  -d @test/sample-payload.json
```

### Running Tests

```bash
npm test
```

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `MCLEOD_API_URL` | McLeod Web Services base URL |
| `MCLEOD_USERNAME` | McLeod API username |
| `MCLEOD_PASSWORD` | McLeod API password |
| `JOTFORM_API_KEY` | Jotform API key |

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `JOTFORM_WEBHOOK_SECRET` | - | Webhook signature secret |
| `SLACK_WEBHOOK_URL` | - | Slack incoming webhook URL |
| `ENABLE_SLACK_ALERTS` | `false` | Enable Slack notifications |
| `ENABLE_DOCUMENT_UPLOAD` | `true` | Enable document storage |
| `LOG_LEVEL` | `info` | Logging level |

See `.env.example` for complete list.

## API Endpoints

### POST /api/webhook/jotform

Receives Jotform webhook payload and processes customer onboarding.

**Response:**
```json
{
  "success": true,
  "customerId": "BB3456789",
  "created": true,
  "documentUploaded": true
}
```

### GET /api/health

Health check endpoint.

## Jotform Setup

1. **Configure Webhook:**
   - Go to Jotform Form Builder → Settings → Integrations → Webhooks
   - Add webhook URL: `https://your-function.azurewebsites.net/api/webhook/jotform`
   - Enable webhook secret for security

2. **Required Form Fields:**
   - Legal Company Name
   - DBA
   - Address (Street, City, State, Zip)
   - Main Phone
   - Operations Email
   - EIN/Tax ID
   - MC/DOT Number (optional)
   - Logistics Contact (Name, Email, Phone)
   - AP Contact (Name, Email, Phone)
   - Payment Terms
   - Invoice Delivery Preference
   - Blackbox Contact (First Name, Last Name)
   - Signature (Jotform Sign)

## McLeod Integration

### Customer ID Generation

Customer IDs are generated as: `BB` + last 7 digits of EIN

Example: EIN `12-3456789` → Customer ID `BB3456789`

### Credit Settings

All new customers are created with:
- `credit_limit`: 0
- `credit_status`: HOLD
- Notes: "PENDING CREDIT APPROVAL"

### Salesperson Mapping

Update `src/config/index.ts` with your sales team:

```typescript
const SALESPERSON_MAP = {
  "Larry Dyer": "LDYER",
  "John Smith": "JSMITH",
  // Add your team
  "_DEFAULT": "HOUSE"
};
```

## Document Storage

Signed agreements are stored in order of preference:

1. **McLeod Document Service** (if available)
2. **Azure Blob Storage** (fallback)
3. **Jotform URL in notes** (last resort)

## Deployment

### Azure Functions

```bash
# Build
npm run build

# Deploy using Azure CLI
az functionapp deployment source config-zip \
  -g <resource-group> \
  -n <function-app-name> \
  --src dist.zip

# Or use VS Code Azure Functions extension
```

### Environment Variables in Azure

Set application settings in Azure Portal or via CLI:

```bash
az functionapp config appsettings set \
  --name <function-app-name> \
  --resource-group <resource-group> \
  --settings MCLEOD_API_URL=https://... MCLEOD_USERNAME=...
```

## Monitoring

### Logs

- Local: Console output
- Azure: Application Insights

### Alerts

Failures trigger Slack notifications including:
- Submission ID
- Company name
- Error message
- Action required

## Troubleshooting

### Common Issues

1. **Webhook signature validation fails**
   - Verify `JOTFORM_WEBHOOK_SECRET` matches Jotform settings
   - Or set `ENABLE_WEBHOOK_VALIDATION=false` for testing

2. **McLeod connection fails**
   - Verify `MCLEOD_API_URL` is correct
   - Check credentials
   - Ensure IP is whitelisted in McLeod

3. **Duplicate customer ID**
   - System auto-appends suffix (A, B, C...)
   - Check logs for collision handling

## Project Structure

```
├── docs/                    # Documentation
│   ├── 01-MCLEOD-ENDPOINT-DISCOVERY.md
│   ├── 02-FIELD-MAPPING-TABLE.md
│   ├── 03-IDEMPOTENCY-AND-MATCHING.md
│   ├── 04-CREDIT-HANDLING.md
│   ├── 05-DOCUMENT-HANDLING.md
│   └── 06-INTEGRATION-SPEC.md
├── src/
│   ├── config/             # Configuration
│   ├── handlers/           # Azure Function handlers
│   ├── services/           # Business logic
│   │   ├── mcleod-client.ts    # McLeod API client (TODO: implement)
│   │   ├── jotform-client.ts   # Jotform API client
│   │   ├── document-handler.ts # Document storage
│   │   └── customer-processor.ts # Main processing logic
│   ├── types/              # TypeScript types
│   ├── utils/              # Utilities
│   └── index.ts            # Entry point
├── .env.example            # Environment template
├── host.json               # Azure Functions config
├── package.json
└── tsconfig.json
```

## TODO Before Production

- [ ] Verify McLeod WSDL and update field names
- [ ] Implement actual SOAP calls in `mcleod-client.ts`
- [ ] Update Jotform field mappings in `types/jotform.ts`
- [ ] Add all salespeople to mapping table
- [ ] Configure Azure Blob Storage (if using)
- [ ] Set up Application Insights
- [ ] Test in sandbox environment
- [ ] Review with Billing team

## Support

For issues, contact the integration team or file an issue in this repository.
