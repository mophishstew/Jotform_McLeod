# Jotform → McLeod TMS Integration Specification

**Version:** 1.0 MVP
**Last Updated:** 2024-01-15
**Status:** Draft - Pending McLeod endpoint verification

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              JOTFORM                                        │
│  ┌─────────────┐                                                            │
│  │ Customer    │  1. Submit Form                                            │
│  │ Onboarding  │────────────────────────────────────────┐                   │
│  │ Form        │                                        │                   │
│  └─────────────┘                                        │                   │
│                                                         ▼                   │
│                                              ┌─────────────────────┐        │
│                                              │ Jotform Webhook     │        │
│                                              │ (POST to endpoint)  │        │
│                                              └─────────┬───────────┘        │
└─────────────────────────────────────────────────────────┼───────────────────┘
                                                          │
                                    2. Webhook POST       │
                                    (JSON payload)        │
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         INTEGRATION SERVICE                                 │
│                         (Azure Function / Cloudflare Worker)                │
│                                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │   Webhook    │──▶│   Payload    │──▶│   Customer   │──▶│   McLeod     │ │
│  │   Handler    │   │   Validator  │   │   Processor  │   │   Client     │ │
│  └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘ │
│         │                                     │                    │        │
│         │                                     │                    │        │
│         ▼                                     ▼                    │        │
│  ┌──────────────┐                     ┌──────────────┐             │        │
│  │ Idempotency  │                     │   Document   │             │        │
│  │ Store (KV)   │                     │   Handler    │             │        │
│  └──────────────┘                     └──────────────┘             │        │
│                                              │                     │        │
└──────────────────────────────────────────────┼─────────────────────┼────────┘
                                               │                     │
                         3. Upload PDF         │    4. SOAP API      │
                         (if supported)        │    Calls            │
                                               ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           McLEOD TMS                                        │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                    │
│  │  Customer    │   │  Document    │   │  Contact     │                    │
│  │  Service     │   │  Service     │   │  Service     │                    │
│  └──────────────┘   └──────────────┘   └──────────────┘                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                               │
                                               │ 5. Alerts (on failure)
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MONITORING                                          │
│  ┌──────────────┐   ┌──────────────┐                                       │
│  │    Slack     │   │   Logging    │                                       │
│  │   Alerts     │   │  (Console/   │                                       │
│  │              │   │   Azure)     │                                       │
│  └──────────────┘   └──────────────┘                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow (Numbered Steps)

| Step | Action | Source | Destination | Notes |
|------|--------|--------|-------------|-------|
| 1 | Customer submits onboarding form | Browser | Jotform | Signs agreement via Jotform Sign |
| 2 | Jotform sends webhook | Jotform | Integration Service | POST with JSON payload |
| 3 | Validate webhook signature | Integration Service | - | HMAC-SHA256 if configured |
| 4 | Check idempotency store | Integration Service | KV Store | Prevent duplicate processing |
| 5 | Search McLeod for existing customer | Integration Service | McLeod CustomerService | Search by EIN, then name+address |
| 6a | **If found:** Update customer | Integration Service | McLeod CustomerService | Preserve credit if > 0 |
| 6b | **If not found:** Create customer | Integration Service | McLeod CustomerService | credit_limit=0, credit_status=HOLD |
| 7 | Download signed PDF from Jotform | Integration Service | Jotform API | GET /submission/{id}/pdf |
| 8 | Upload PDF to McLeod (or fallback) | Integration Service | McLeod DocumentService | Store link in notes if upload fails |
| 9 | Update idempotency store | Integration Service | KV Store | Mark as completed |
| 10 | Send alert on failure | Integration Service | Slack | Include submission ID, error |

---

## Authentication + Secrets Handling

### Required Secrets

| Secret | Environment Variable | Purpose | Rotation |
|--------|---------------------|---------|----------|
| McLeod Username | `MCLEOD_USERNAME` | SOAP API auth | Quarterly |
| McLeod Password | `MCLEOD_PASSWORD` | SOAP API auth | Quarterly |
| McLeod API URL | `MCLEOD_API_URL` | SOAP endpoint base URL | Rarely |
| Jotform API Key | `JOTFORM_API_KEY` | Fetch submission PDF | Yearly |
| Jotform Webhook Secret | `JOTFORM_WEBHOOK_SECRET` | Validate webhook | On regeneration |
| Slack Webhook URL | `SLACK_WEBHOOK_URL` | Alert notifications | On regeneration |
| Azure Storage Connection | `AZURE_STORAGE_CONNECTION_STRING` | Document fallback | Yearly |

### Secrets Storage

| Environment | Storage | Access |
|-------------|---------|--------|
| Development | `.env` file (gitignored) | Local only |
| Staging | Azure Key Vault / CF Secrets | Service identity |
| Production | Azure Key Vault / CF Secrets | Service identity |

### McLeod Authentication Flow

```typescript
// WS-Security UsernameToken
const soapEnvelope = `
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
      <wsse:UsernameToken>
        <wsse:Username>${process.env.MCLEOD_USERNAME}</wsse:Username>
        <wsse:Password>${process.env.MCLEOD_PASSWORD}</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
  </soap:Header>
  <soap:Body>
    <!-- Request here -->
  </soap:Body>
</soap:Envelope>
`;
```

---

## Webhook Validation

### Jotform Webhook Signature

Jotform supports webhook signatures when configured:

```typescript
function validateJotformWebhook(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// In request handler:
const signature = request.headers['x-jotform-signature'];
if (!validateJotformWebhook(rawBody, signature, process.env.JOTFORM_WEBHOOK_SECRET)) {
  return new Response('Invalid signature', { status: 401 });
}
```

**Note:** If Jotform doesn't provide signatures, implement IP allowlisting as backup.

---

## McLeod API Calls

### Call 1: Search Customer by EIN

| Attribute | Value |
|-----------|-------|
| Service | `CustomerService` |
| Operation | `SearchCustomers` or `FindCustomer` |
| Method | SOAP POST |
| Required Fields | `federal_id` (EIN) |
| Returns | List of matching customers |

```xml
<!-- Request -->
<SearchCustomers>
  <criteria>
    <federal_id>123456789</federal_id>
  </criteria>
  <max_results>10</max_results>
</SearchCustomers>

<!-- Response -->
<SearchCustomersResponse>
  <customers>
    <customer>
      <id>BB3456789</id>
      <name>ACME LOGISTICS INC</name>
      <credit_limit>10000</credit_limit>
      <credit_status>ACTIVE</credit_status>
    </customer>
  </customers>
  <total_count>1</total_count>
</SearchCustomersResponse>
```

### Call 2: Create Customer

| Attribute | Value |
|-----------|-------|
| Service | `CustomerService` |
| Operation | `CreateCustomer` or `AddCustomer` |
| Method | SOAP POST |
| Required Fields | `id`, `name`, `address1`, `city`, `state`, `zip_code`, `status` |
| Returns | Created customer ID, success/failure |

```xml
<!-- Request -->
<CreateCustomer>
  <customer>
    <id>BB3456789</id>
    <name>ACME LOGISTICS INC</name>
    <dba_name>ACME TRANSPORT</dba_name>
    <address1>123 MAIN STREET</address1>
    <address2>SUITE 400</address2>
    <city>DALLAS</city>
    <state>TX</state>
    <zip_code>75201</zip_code>
    <phone>2145551234</phone>
    <email>ops@acme.com</email>
    <federal_id>123456789</federal_id>
    <status>ACTIVE</status>
    <category>SHIPPER</category>
    <credit_limit>0</credit_limit>
    <credit_status>HOLD</credit_status>
    <salesperson_id>LDYER</salesperson_id>
    <payment_terms>NET30</payment_terms>
    <notes>PENDING CREDIT APPROVAL - Created via Jotform onboarding...</notes>
  </customer>
</CreateCustomer>

<!-- Response -->
<CreateCustomerResponse>
  <result>
    <success>true</success>
    <customer_id>BB3456789</customer_id>
  </result>
</CreateCustomerResponse>
```

### Call 3: Update Customer

| Attribute | Value |
|-----------|-------|
| Service | `CustomerService` |
| Operation | `UpdateCustomer` or `ModifyCustomer` |
| Method | SOAP POST |
| Required Fields | `id` (existing), fields to update |
| Returns | Success/failure |

### Call 4: Upload Document (if supported)

| Attribute | Value |
|-----------|-------|
| Service | `DocumentService` or `ImageService` |
| Operation | `UploadDocument` or `AttachDocument` |
| Method | SOAP POST |
| Required Fields | `entity_type`, `entity_id`, `content` (base64), `filename` |
| Returns | Document ID |

---

## Error Handling + Retries + Alerts

### Retry Policy

| Error Type | Retry? | Max Attempts | Backoff |
|------------|--------|--------------|---------|
| Network timeout | Yes | 3 | Exponential (1s, 2s, 4s) |
| HTTP 5xx | Yes | 3 | Exponential |
| HTTP 429 (rate limit) | Yes | 5 | Exponential + Jitter |
| HTTP 4xx (client error) | No | 1 | - |
| Validation error | No | 1 | - |
| McLeod business error | No | 1 | - |

### Alert Triggers

| Condition | Alert Level | Channel |
|-----------|-------------|---------|
| Customer creation failed | Error | Slack #alerts |
| Document upload failed | Warning | Slack #alerts |
| All retries exhausted | Error | Slack #alerts + Email |
| Invalid webhook signature | Warning | Slack #security |
| Duplicate submission blocked | Info | Log only |

### Alert Format

```json
{
  "level": "error",
  "service": "jotform-mcleod-integration",
  "timestamp": "2024-01-15T10:30:00Z",
  "submission_id": "5432109876543210987",
  "company_name": "Acme Logistics Inc",
  "error": "McLeod API returned 500: Internal Server Error",
  "attempts": 3,
  "action_required": "Manual review needed"
}
```

---

## Logging + Audit Trail

### Structured Log Format

```typescript
interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  service: 'jotform-mcleod-integration';
  traceId: string;          // UUID per request
  submissionId: string;     // Jotform submission ID
  operation: string;        // 'webhook_received', 'search_customer', etc.
  duration_ms?: number;
  success: boolean;
  mcleod_customer_id?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

### Key Log Events

| Event | Level | When |
|-------|-------|------|
| `webhook_received` | Info | Webhook POST received |
| `signature_validated` | Debug | Signature check passed |
| `idempotency_check` | Debug | Checked idempotency store |
| `customer_search` | Info | McLeod search executed |
| `customer_found` | Info | Existing customer matched |
| `customer_created` | Info | New customer created |
| `customer_updated` | Info | Existing customer updated |
| `document_uploaded` | Info | Document stored successfully |
| `document_upload_failed` | Warn | Document upload failed (non-fatal) |
| `processing_complete` | Info | All steps completed |
| `processing_failed` | Error | Fatal error occurred |

---

## Test Plan

### Unit Tests

| Component | Test Cases |
|-----------|------------|
| Payload Validator | Valid payload, missing required fields, invalid EIN format, invalid state code |
| Field Mapper | All field transformations, phone normalization, EIN normalization |
| Salesperson Lookup | Known salespeople, unknown (fallback), case insensitivity |
| Customer ID Generator | From EIN, from name, collision handling |
| Idempotency Store | New submission, duplicate, stale entry |

### Integration Tests

| Test | Setup | Expected Result |
|------|-------|-----------------|
| New customer creation | Mock McLeod returning empty search | Customer created with credit=0 |
| Existing customer update | Mock McLeod returning 1 result | Customer updated, credit preserved |
| Duplicate submission | Same submission ID twice | Second request returns existing |
| McLeod unavailable | Mock 500 response | Retry 3x, then alert |
| Document upload fail | Mock doc service error | Customer created, warning logged |

### Manual Validation Checklist

- [ ] Submit test form in Jotform sandbox
- [ ] Verify customer appears in McLeod within 60 seconds
- [ ] Confirm credit_limit = 0
- [ ] Confirm credit_status = HOLD (or equivalent)
- [ ] Confirm salesperson assigned correctly
- [ ] Verify all fields mapped correctly
- [ ] Check document attached (or link in notes)
- [ ] Submit same form again - confirm no duplicate
- [ ] Disconnect McLeod - confirm Slack alert fires
- [ ] Check logs for complete audit trail

---

## Rollout Plan

### Phase 1: Sandbox Testing (Week 1)

1. Deploy to staging environment
2. Configure Jotform sandbox webhook
3. Connect to McLeod test/sandbox instance
4. Run full test suite
5. Fix any issues found
6. Document McLeod field name corrections

### Phase 2: Limited Production (Week 2)

1. Deploy to production environment (disabled)
2. Configure Jotform production webhook (pointing to prod)
3. Enable for 1-2 specific Blackbox contacts only
4. Monitor all submissions closely
5. Verify Billing team still receives email notification
6. Validate data in McLeod production

### Phase 3: Full Rollout (Week 3)

1. Enable for all Blackbox contacts
2. Monitor for 48 hours
3. Address any edge cases
4. Remove rate limiting / testing restrictions
5. Document any manual cleanup needed

### Rollback Plan

1. **Immediate:** Disable webhook in Jotform (< 1 min)
2. **Short-term:** Revert Azure Function to previous version
3. **Data cleanup:** Identify customers created during incident, flag for review

---

## MVP Scope vs Phase 2

### MVP (This Implementation)

| Feature | Included |
|---------|----------|
| Webhook handler | Yes |
| Customer create/update | Yes |
| EIN-based matching | Yes |
| Name+address fallback matching | Yes |
| Credit limit = 0 | Yes |
| Salesperson assignment | Yes |
| Basic document handling | Yes (Azure Blob fallback) |
| Slack alerts | Yes |
| Structured logging | Yes |
| Idempotency (in-memory) | Yes |

### Phase 2 (Future)

| Feature | Priority |
|---------|----------|
| Persistent idempotency store (Redis) | High |
| SharePoint document integration | Medium |
| Direct McLeod document upload | Medium |
| Contact records (separate from customer) | Medium |
| Auto credit check integration | Low |
| Customer portal / status page | Low |
| Metrics dashboard | Low |

---

## Appendix: Configuration Reference

### Environment Variables

```bash
# McLeod TMS
MCLEOD_API_URL=https://mcleod.company.com/webservices
MCLEOD_USERNAME=api_user
MCLEOD_PASSWORD=secure_password

# Jotform
JOTFORM_API_KEY=your_jotform_api_key
JOTFORM_WEBHOOK_SECRET=webhook_secret_for_signature

# Alerts
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz

# Document Storage (fallback)
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...

# Feature Flags
ENABLE_DOCUMENT_UPLOAD=true
ENABLE_SLACK_ALERTS=true
LOG_LEVEL=info
```

### Salesperson Mapping Table

```typescript
const SALESPERSON_MAP: Record<string, string> = {
  "Larry Dyer": "LDYER",
  "John Smith": "JSMITH",
  // Add all sales team members
  "_DEFAULT": "HOUSE"
};
```
