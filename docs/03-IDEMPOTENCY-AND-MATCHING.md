# Idempotency and Customer Matching Logic

## Overview

This document defines how we ensure:
1. **Idempotency**: The same Jotform submission processed multiple times produces the same result
2. **Deduplication**: We don't create duplicate customers in McLeod
3. **Matching**: We correctly identify existing customers for updates

---

## 1. Idempotency Strategy

### 1.1 Jotform Submission ID

Every Jotform submission has a unique `submission_id`. This is our primary idempotency key.

```
Submission ID: 5432109876543210987
```

### 1.2 Idempotency Store

We maintain an idempotency store to track processed submissions:

```typescript
interface IdempotencyRecord {
  submissionId: string;          // Jotform submission ID
  mcleodCustomerId: string;      // Created/updated McLeod customer ID
  status: 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  errorMessage?: string;
  attempts: number;
}
```

### 1.3 Processing Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Webhook Received                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│   Check Idempotency Store for submission_id                  │
└─────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
      ┌──────────┐     ┌──────────────┐  ┌─────────────┐
      │ Not Found │     │ Processing   │  │ Completed   │
      └──────────┘     └──────────────┘  └─────────────┘
            │                 │                 │
            ▼                 ▼                 ▼
      ┌──────────┐     ┌──────────────┐  ┌─────────────┐
      │ Process  │     │ Check if     │  │ Return      │
      │ New      │     │ stale (>5min)│  │ existing    │
      └──────────┘     └──────────────┘  │ customer_id │
                              │          └─────────────┘
                    ┌─────────┴─────────┐
                    ▼                   ▼
              ┌──────────┐        ┌──────────┐
              │ Stale:   │        │ Active:  │
              │ Retry    │        │ Return   │
              └──────────┘        │ 409      │
                                  └──────────┘
```

### 1.4 MVP Implementation (In-Memory)

For MVP, use in-memory Map with TTL:

```typescript
const idempotencyStore = new Map<string, IdempotencyRecord>();

// Clean up old entries every hour
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [key, record] of idempotencyStore) {
    if (record.createdAt.getTime() < oneHourAgo) {
      idempotencyStore.delete(key);
    }
  }
}, 60 * 60 * 1000);
```

### 1.5 Production Implementation (Persistent)

For production, use:

| Option | Pros | Cons |
|--------|------|------|
| **Redis** | Fast, TTL support, atomic ops | Additional infrastructure |
| **Database Table** | Durable, queryable | Slower, need cleanup job |
| **Azure Table Storage** | Cheap, serverless | Limited query |
| **Cloudflare KV** | Built-in for Workers | Eventually consistent |

**Recommended:** Redis or Database table

---

## 2. Customer Matching Logic

### 2.1 Matching Priority

We use a tiered matching strategy:

```
Priority 1: EIN/Tax ID (federal_id) - EXACT MATCH
   ↓ (if not found or no EIN)
Priority 2: Legal Company Name + Full Address - EXACT MATCH
   ↓ (if not found)
Priority 3: Legal Company Name + City + State - FUZZY MATCH
   ↓ (if not found)
Result: CREATE NEW CUSTOMER
```

### 2.2 Primary Key: EIN/Tax ID

**Why EIN is the best match key:**
- Unique to each legal entity
- Doesn't change with address/name changes
- Required on Jotform (should always have it)

**Search Logic:**
```typescript
async function findCustomerByEIN(ein: string): Promise<Customer | null> {
  const normalizedEIN = ein.replace(/\D/g, '');

  // McLeod API call
  const results = await mcleodApi.searchCustomers({
    federal_id: normalizedEIN
  });

  if (results.length === 1) {
    return results[0];
  }

  if (results.length > 1) {
    // Multiple matches - log warning, return first active
    logger.warn(`Multiple customers with EIN ${normalizedEIN}`);
    return results.find(c => c.status === 'ACTIVE') || results[0];
  }

  return null;
}
```

### 2.3 Fallback: Name + Address

**When to use:**
- EIN search returns no results
- EIN field is empty (shouldn't happen, but handle gracefully)

**Search Logic:**
```typescript
async function findCustomerByNameAddress(
  name: string,
  address: {
    street: string;
    city: string;
    state: string;
    zip: string;
  }
): Promise<Customer | null> {
  const normalizedName = name.trim().toUpperCase();
  const normalizedCity = address.city.trim().toUpperCase();
  const normalizedState = address.state.trim().toUpperCase();

  const results = await mcleodApi.searchCustomers({
    name: normalizedName,
    city: normalizedCity,
    state: normalizedState
  });

  // Exact match on name + city + state + zip
  const exactMatch = results.find(c =>
    c.name.toUpperCase() === normalizedName &&
    c.zip_code === address.zip.replace(/\D/g, '').slice(0, 5)
  );

  if (exactMatch) {
    return exactMatch;
  }

  // Fuzzy match on name (handle minor variations)
  const fuzzyMatch = results.find(c =>
    isSimilarName(c.name, normalizedName)
  );

  return fuzzyMatch || null;
}

function isSimilarName(a: string, b: string): boolean {
  // Simple similarity check
  const normalize = (s: string) => s.replace(/[^A-Z0-9]/g, '');
  const na = normalize(a.toUpperCase());
  const nb = normalize(b.toUpperCase());

  // Check if one contains the other (handles "Inc" vs "Inc." etc)
  return na.includes(nb) || nb.includes(na) || na === nb;
}
```

### 2.4 Complete Matching Flow

```typescript
async function findOrCreateCustomer(
  jotformData: JotformSubmission
): Promise<{ customer: Customer; created: boolean }> {

  // 1. Check idempotency store
  const existing = idempotencyStore.get(jotformData.submissionId);
  if (existing?.status === 'completed') {
    const customer = await mcleodApi.getCustomer(existing.mcleodCustomerId);
    return { customer, created: false };
  }

  // 2. Try to find by EIN
  const ein = jotformData.ein?.replace(/\D/g, '');
  if (ein && ein.length === 9) {
    const byEIN = await findCustomerByEIN(ein);
    if (byEIN) {
      logger.info(`Found existing customer by EIN: ${byEIN.id}`);
      return { customer: await updateCustomer(byEIN, jotformData), created: false };
    }
  }

  // 3. Try to find by Name + Address
  const byNameAddress = await findCustomerByNameAddress(
    jotformData.legalName,
    {
      street: jotformData.address.street,
      city: jotformData.address.city,
      state: jotformData.address.state,
      zip: jotformData.address.zip
    }
  );

  if (byNameAddress) {
    logger.info(`Found existing customer by name/address: ${byNameAddress.id}`);
    return { customer: await updateCustomer(byNameAddress, jotformData), created: false };
  }

  // 4. Create new customer
  logger.info(`No existing customer found, creating new`);
  const newCustomer = await createCustomer(jotformData);
  return { customer: newCustomer, created: true };
}
```

---

## 3. Customer ID Generation

### 3.1 The Challenge

McLeod requires a unique `customer.id` that:
- Is typically 6-15 alphanumeric characters
- Is visible to users in UI
- Cannot be changed after creation
- Must be unique across all customers

### 3.2 ID Generation Strategy

```typescript
function generateCustomerId(ein: string, companyName: string): string {
  // Primary: Use EIN (most unique)
  if (ein && ein.length === 9) {
    // Format: BB + last 7 digits of EIN
    // "BB" prefix identifies Blackbox-created customers
    return `BB${ein.slice(2)}`;  // e.g., EIN 12-3456789 → BB3456789
  }

  // Fallback: Use company name + random suffix
  const namePrefix = companyName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);

  const dateSuffix = new Date()
    .toISOString()
    .slice(2, 10)
    .replace(/-/g, '');  // YYMMDD

  return `${namePrefix}${dateSuffix}`;  // e.g., ACMELO240115
}
```

### 3.3 Collision Handling

```typescript
async function generateUniqueCustomerId(
  ein: string,
  companyName: string
): Promise<string> {
  const baseId = generateCustomerId(ein, companyName);

  // Check if base ID exists
  const existing = await mcleodApi.getCustomer(baseId);
  if (!existing) {
    return baseId;
  }

  // Add suffix for collision
  const suffixes = ['A','B','C','D','E','F','G','H','I','J'];
  for (const suffix of suffixes) {
    const candidateId = `${baseId}${suffix}`;
    const exists = await mcleodApi.getCustomer(candidateId);
    if (!exists) {
      return candidateId;
    }
  }

  // Numeric suffix as last resort
  for (let i = 1; i <= 99; i++) {
    const candidateId = `${baseId}${i.toString().padStart(2, '0')}`;
    const exists = await mcleodApi.getCustomer(candidateId);
    if (!exists) {
      return candidateId;
    }
  }

  throw new Error(`Cannot generate unique ID for ${companyName}`);
}
```

---

## 4. Update vs Create Decision

### 4.1 When to Update

If we find an existing customer, we update with new data:

```typescript
async function updateCustomer(
  existing: Customer,
  newData: JotformSubmission
): Promise<Customer> {
  // Fields to update (preserve existing values where appropriate)
  const updates = {
    // Always update contact info
    operations_email: newData.operationsEmail,
    phone: newData.mainPhone,

    // Update address if changed
    address1: newData.address.street,
    address2: newData.address.street2,
    city: newData.address.city,
    state: newData.address.state,
    zip_code: newData.address.zip,

    // Add DBA if provided
    dba_name: newData.dba || existing.dba_name,

    // Preserve existing credit settings if already approved
    // Only set to 0/HOLD if currently null/undefined
    credit_limit: existing.credit_limit ?? 0,
    credit_status: existing.credit_status ?? 'HOLD',

    // Append to notes (don't overwrite)
    notes: appendNotes(existing.notes, formatJotformNotes(newData))
  };

  return mcleodApi.updateCustomer(existing.id, updates);
}
```

### 4.2 Update Safety Rules

| Field | Update Behavior |
|-------|----------------|
| `name` | **NEVER** change (could break references) |
| `federal_id` | **NEVER** change |
| `id` | **CANNOT** change |
| `credit_limit` | Only if null/0 (don't reduce approved credit) |
| `credit_status` | Only if null (don't revert approval) |
| `salesperson_id` | Update only if currently null |
| `address` | Always update to latest |
| `contacts` | Add/update, don't delete existing |
| `notes` | Append, never overwrite |

---

## 5. Error Handling and Recovery

### 5.1 Transient Failures

```typescript
async function processWithRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (isTransientError(error) && attempt < maxAttempts) {
        logger.warn(`Attempt ${attempt} failed, retrying in ${delayMs}ms`);
        await sleep(delayMs * attempt); // Exponential backoff
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

function isTransientError(error: any): boolean {
  // Network errors, timeouts, 5xx errors
  return (
    error.code === 'ECONNRESET' ||
    error.code === 'ETIMEDOUT' ||
    error.status >= 500 ||
    error.message?.includes('timeout')
  );
}
```

### 5.2 Partial Failure Recovery

If customer creation succeeds but document upload fails:

```typescript
async function processSubmission(data: JotformSubmission): Promise<void> {
  let customerId: string | null = null;

  try {
    // Step 1: Create/Update customer
    const { customer, created } = await findOrCreateCustomer(data);
    customerId = customer.id;

    // Step 2: Upload document (can fail independently)
    try {
      await uploadAgreementDocument(customer.id, data.signedAgreementUrl);
    } catch (docError) {
      // Log but don't fail the whole operation
      logger.error(`Document upload failed for ${customer.id}`, docError);

      // Store URL in notes as fallback
      await mcleodApi.appendNote(customer.id,
        `Agreement document upload failed. URL: ${data.signedAgreementUrl}`
      );
    }

    // Step 3: Update idempotency store
    idempotencyStore.set(data.submissionId, {
      submissionId: data.submissionId,
      mcleodCustomerId: customer.id,
      status: 'completed',
      createdAt: new Date(),
      completedAt: new Date(),
      attempts: 1
    });

  } catch (error) {
    // Mark as failed in idempotency store
    idempotencyStore.set(data.submissionId, {
      submissionId: data.submissionId,
      mcleodCustomerId: customerId,
      status: 'failed',
      createdAt: new Date(),
      errorMessage: error.message,
      attempts: 1
    });

    throw error;
  }
}
```

---

## 6. Audit Trail

Every operation is logged with:

```typescript
interface AuditLog {
  timestamp: Date;
  submissionId: string;
  operation: 'SEARCH' | 'CREATE' | 'UPDATE' | 'UPLOAD_DOC';
  mcleodCustomerId?: string;
  matchMethod?: 'EIN' | 'NAME_ADDRESS' | 'NONE';
  success: boolean;
  errorMessage?: string;
  requestPayload?: object;  // Sanitized (no secrets)
  responsePayload?: object;
}
```

---

## Summary

| Component | Strategy |
|-----------|----------|
| **Idempotency Key** | Jotform `submission_id` |
| **Primary Match** | EIN/Tax ID (exact) |
| **Fallback Match** | Company Name + City + State |
| **Customer ID** | `BB` + EIN last 7 digits |
| **Collision Handling** | Append A-Z, then 01-99 |
| **Update Policy** | Never reduce credit, append notes |
| **Failure Handling** | Retry transient, alert on permanent |
