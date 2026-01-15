# Credit Handling Strategy for MVP

## Overview

The business requirement is clear: **No credit awarded at onboarding**. The Billing team must manually review and approve credit after receiving the Jotform submission email.

This document defines exactly how we configure McLeod to enforce this.

---

## 1. McLeod Credit Fields (Expected)

Based on typical McLeod TMS customer schema:

| Field | Type | Description | Our Setting |
|-------|------|-------------|-------------|
| `credit_limit` | Decimal | Maximum credit amount | `0` |
| `credit_status` | String/Code | Credit approval status | `HOLD` or `PENDING` |
| `credit_approved` | Boolean | Whether credit is approved | `false` |
| `credit_approved_by` | String | Who approved credit | `null` |
| `credit_approved_date` | Date | When credit was approved | `null` |
| `credit_terms` | String/Code | Payment terms code | From Jotform |
| `credit_notes` | Text | Notes about credit | See below |

**Note:** Exact field names may vary. Verify against actual McLeod schema.

---

## 2. Safe Default Values

### 2.1 Primary Settings

```typescript
const CREDIT_DEFAULTS = {
  // Zero credit limit - no invoices can exceed this
  credit_limit: 0,

  // Status codes (check McLeod for valid values)
  // Try in order until one works:
  credit_status_options: ['HOLD', 'PENDING', 'REVIEW', 'NEW'],

  // Boolean flag if available
  credit_approved: false,

  // Explanation for Billing team
  credit_notes: 'PENDING CREDIT APPROVAL - Created via Jotform onboarding'
};
```

### 2.2 Credit Status Code Discovery

Before deployment, determine valid values for `credit_status`:

```typescript
// Query McLeod for valid credit status codes
// This might be in a lookup table like 'credit_status_codes'

// Common McLeod credit status values:
const POSSIBLE_CREDIT_STATUSES = [
  'ACTIVE',    // Approved, can invoice
  'HOLD',      // On hold, cannot invoice
  'PENDING',   // Awaiting approval
  'REVIEW',    // Under review
  'SUSPENDED', // Previously approved, now suspended
  'COD',       // Cash on delivery only
  'PREPAID',   // Must prepay
  'NEW'        // New customer, not yet reviewed
];
```

### 2.3 Fallback Strategy

If McLeod doesn't support credit status codes that prevent invoicing:

| Scenario | Solution |
|----------|----------|
| Only `ACTIVE` status works | Use `ACTIVE` but with `credit_limit=0` |
| No credit status field | Set `credit_limit=0` and add note |
| Credit limit not enforced | Use notes field + require manual override |

---

## 3. Implementation

### 3.1 Customer Creation Payload

```typescript
function buildCustomerPayload(data: JotformData): McLeodCustomer {
  return {
    // ... other fields ...

    // CREDIT FIELDS - No credit until manual approval
    credit_limit: 0,
    credit_status: 'HOLD',  // Or 'PENDING' - verify valid code
    credit_approved: false,

    // Clear audit trail
    credit_notes: `PENDING CREDIT APPROVAL
Created: ${new Date().toISOString()}
Source: Jotform Onboarding
Submission ID: ${data.submissionId}

Requested Terms: ${data.paymentTerms}
Payment Method: ${data.paymentMethod}

ACTION REQUIRED: Billing team must review and approve credit.`,

    // Payment terms from Jotform (for reference when approving)
    payment_terms: mapPaymentTerms(data.paymentTerms),
  };
}
```

### 3.2 Notes Template

The notes field should make it VERY clear that credit is pending:

```
═══════════════════════════════════════════════════
⚠️  PENDING CREDIT APPROVAL
═══════════════════════════════════════════════════

This customer was created via Jotform onboarding on {date}.

CREDIT STATUS: NOT APPROVED
CREDIT LIMIT: $0.00

REQUESTED PAYMENT TERMS: {terms}
PREFERRED PAYMENT METHOD: {method}
INVOICE DELIVERY: {delivery_method}
REQUIRED DOCUMENTS: {doc_requirements}

ACTION REQUIRED:
1. Billing team to run credit check
2. Update credit_limit to approved amount
3. Change credit_status to ACTIVE
4. Remove this notice from notes

───────────────────────────────────────────────────
AGREEMENT SIGNED: {signature_date}
AGREEMENT DOCUMENT: {document_link}
───────────────────────────────────────────────────
```

---

## 4. Handling Existing Customers

### 4.1 Update Rules for Credit Fields

When updating an existing customer (found by EIN/name match):

```typescript
function updateCreditFields(
  existing: McLeodCustomer,
  newData: JotformData
): Partial<McLeodCustomer> {
  const updates: Partial<McLeodCustomer> = {};

  // NEVER reduce existing credit limit
  if (existing.credit_limit > 0) {
    // Customer already has approved credit - don't touch it
    console.log(`Customer ${existing.id} has existing credit limit: ${existing.credit_limit}`);
    // Just append a note about the new submission
    updates.notes = appendNote(existing.notes,
      `New Jotform submission received ${new Date().toISOString()}. ` +
      `Existing credit preserved.`
    );
  } else {
    // No existing credit - ensure it stays at 0
    updates.credit_limit = 0;
    updates.credit_status = existing.credit_status || 'HOLD';
  }

  // NEVER change credit_status from ACTIVE to HOLD
  if (existing.credit_status === 'ACTIVE') {
    console.log(`Customer ${existing.id} has active credit status - preserving`);
  }

  return updates;
}
```

### 4.2 Decision Matrix

| Existing credit_limit | Existing credit_status | Action |
|----------------------|----------------------|--------|
| null/undefined | null/undefined | Set to 0, HOLD |
| 0 | null/undefined | Keep 0, set HOLD |
| 0 | HOLD/PENDING | No change |
| > 0 | ACTIVE | **Preserve** - don't reduce |
| > 0 | HOLD | **Preserve** limit, keep HOLD |
| null | ACTIVE | Set 0 (unusual case, log warning) |

---

## 5. Credit Approval Workflow (Manual - Post-MVP)

The manual workflow for Billing team remains unchanged:

```
1. Receive Jotform notification email (existing behavior)
2. Pull credit report for customer
3. Review agreement and business info
4. Determine appropriate credit limit
5. In McLeod:
   a. Find customer by name or ID
   b. Update credit_limit to approved amount
   c. Change credit_status to ACTIVE
   d. Update credit_notes with approval details
   e. Save
```

### 5.1 Future Enhancement (Phase 2)

Potential automation for Phase 2:

```
- Auto-pull credit report via API (D&B, Experian)
- Store credit score in custom field
- Auto-approve if score > threshold
- Create approval queue in SharePoint/Teams
- Send approval notification back to customer
```

---

## 6. Validation and Testing

### 6.1 Pre-Deployment Checks

1. **Verify credit_status codes:**
   ```sql
   -- Check McLeod for valid credit status values
   SELECT DISTINCT credit_status FROM customer
   WHERE credit_status IS NOT NULL;
   ```

2. **Test credit enforcement:**
   - Create customer with credit_limit=0, credit_status=HOLD
   - Attempt to create an invoice/load
   - Verify it's blocked or flagged

3. **Test existing customer preservation:**
   - Find customer with credit_limit > 0
   - Submit Jotform with same EIN
   - Verify credit_limit is NOT reduced

### 6.2 Test Cases

| Test | Input | Expected Result |
|------|-------|-----------------|
| New customer | New EIN | credit_limit=0, credit_status=HOLD |
| Existing no credit | Same EIN, credit=0 | credit_limit=0, credit_status=HOLD |
| Existing with credit | Same EIN, credit=10000 | credit_limit=10000 (unchanged) |
| Missing EIN | No EIN in form | credit_limit=0, credit_status=HOLD |

---

## 7. Error Scenarios

### 7.1 Invalid Credit Status Code

```typescript
async function setCustomerCredit(
  customerId: string,
  creditLimit: number,
  creditStatus: string
): Promise<void> {
  const validStatuses = ['HOLD', 'PENDING', 'REVIEW', 'NEW', 'ACTIVE'];

  try {
    await mcleodApi.updateCustomer(customerId, {
      credit_limit: creditLimit,
      credit_status: creditStatus
    });
  } catch (error) {
    if (error.message?.includes('invalid') ||
        error.message?.includes('credit_status')) {
      // Try fallback statuses
      for (const fallback of validStatuses) {
        try {
          await mcleodApi.updateCustomer(customerId, {
            credit_limit: creditLimit,
            credit_status: fallback
          });
          console.log(`Used fallback credit status: ${fallback}`);
          return;
        } catch (e) {
          continue;
        }
      }
    }
    throw error;
  }
}
```

### 7.2 Credit Limit Not Accepted

Some McLeod configurations may have minimum credit limits:

```typescript
// If McLeod rejects credit_limit=0
const fallbacks = [
  { credit_limit: 0 },
  { credit_limit: 0.01 },  // Penny limit
  { credit_limit: 1 },     // $1 limit
];

for (const attempt of fallbacks) {
  try {
    await mcleodApi.updateCustomer(customerId, attempt);
    break;
  } catch (e) {
    continue;
  }
}
```

---

## Summary

| Aspect | MVP Approach |
|--------|--------------|
| **credit_limit** | Always set to `0` |
| **credit_status** | Set to `HOLD` or `PENDING` |
| **Existing credit** | NEVER reduce |
| **Notes** | Clear "PENDING APPROVAL" message |
| **Approval process** | Manual (unchanged from today) |
| **Enforcement** | McLeod should block invoicing for $0 credit |
