# Jotform to McLeod Field Mapping Table

## Overview

This document maps Jotform submission fields to McLeod TMS customer record fields. Fields marked "UNKNOWN" require validation against actual McLeod schema.

---

## 1. Company Information Fields

| Jotform Field Name | Example Value | McLeod Field | Transform/Validation | Required | Notes |
|-------------------|---------------|--------------|---------------------|----------|-------|
| Legal Company Name | "Acme Logistics Inc" | `name` | Trim, max 100 chars | **Y** | Primary company name |
| DBA (If Any) | "Acme Transport" | `dba_name` or `name2` | Trim, max 100 chars | N | May need alt field name |
| Address - Street Address | "123 Main Street" | `address1` | Trim, max 60 chars | **Y** | |
| Address - Street Address Line 2 | "Suite 400" | `address2` | Trim, max 60 chars | N | |
| Address - City | "Dallas" | `city` | Trim, uppercase? | **Y** | Check McLeod format |
| Address - State / Province | "TX" | `state` | 2-letter code, uppercase | **Y** | Validate against state list |
| Address - Postal / Zip Code | "75201" | `zip_code` | Format: 5 or 9 digits | **Y** | Strip non-numeric? |
| Main Phone Number | "(214) 555-1234" | `phone` or `phone1` | Strip to digits, format | **Y** | Check required format |
| Operations Contact E-mail | "ops@acme.com" | `email` or `operations_email` | Lowercase, validate | **Y** | May go to primary email |
| EIN OR Tax ID | "12-3456789" | `federal_id` | Strip hyphens, 9 digits | **Y*** | *Used for matching |
| MC or DOT Number | "MC-123456" | `mc_number` / `dot_number` | Parse MC vs DOT, strip prefix | N | May need separate fields |

---

## 2. Contact Information Fields

### Logistics Contact

| Jotform Field Name | Example Value | McLeod Field | Transform/Validation | Required | Notes |
|-------------------|---------------|--------------|---------------------|----------|-------|
| Logistics Contact - First Name | "John" | `contact.first_name` or NOTES | Trim | **Y** | See storage options below |
| Logistics Contact - Last Name | "Smith" | `contact.last_name` or NOTES | Trim | **Y** | |
| Logistics Contact E-mail | "john@acme.com" | `contact.email` or NOTES | Lowercase, validate | **Y** | |
| Logistics Contact Phone Number | "(214) 555-5678" | `contact.phone` or NOTES | Strip to digits | **Y** | |

### Accounts Payable Contact

| Jotform Field Name | Example Value | McLeod Field | Transform/Validation | Required | Notes |
|-------------------|---------------|--------------|---------------------|----------|-------|
| AP Contact - First Name | "Jane" | `ap_contact.first_name` or NOTES | Trim | **Y** | |
| AP Contact - Last Name | "Doe" | `ap_contact.last_name` or NOTES | Trim | **Y** | |
| AP E-mail Address | "ap@acme.com" | `ap_email` or `contact.email` | Lowercase, validate | **Y** | May have dedicated field |
| AP Phone Number | "(214) 555-9012" | `ap_phone` or `contact.phone` | Strip to digits | **Y** | |

### Contact Storage Options

McLeod may support contacts in different ways:

| Option | McLeod Structure | Recommendation |
|--------|-----------------|----------------|
| **A. Dedicated Contact Table** | Separate `contact` records linked to customer | Preferred - create 2 contacts |
| **B. Customer Contact Fields** | `contact_name`, `contact_email`, `contact_phone` on customer | Use for primary (Logistics) |
| **C. Notes Field** | Store in `notes` or `comments` field | Fallback if no contact support |
| **D. Custom Fields** | `custom_field_1`, `custom_field_2`, etc. | If available |

**Recommended Approach:**
1. Store **Logistics Contact** in primary contact fields on customer
2. Store **AP Contact** in dedicated AP fields if they exist, otherwise in notes
3. Create separate contact records if Contact Service is available

---

## 3. Billing/Payment Fields

| Jotform Field Name | Example Value | McLeod Field | Transform/Validation | Required | Notes |
|-------------------|---------------|--------------|---------------------|----------|-------|
| Preferred Payment Terms | "Net 30" | `payment_terms` or `terms_code` | Map to McLeod code | **Y** | See mapping below |
| Invoice Delivery Preference | "Email" | `invoice_method` or NOTES | Map to code | **Y** | |
| Required Invoice Documents | "BOL, POD" | NOTES or `custom_field` | Store as text | **Y** | Likely notes field |
| Preferred Payment Method | "ACH" | `payment_method` or NOTES | Map to code | N | |

### Payment Terms Mapping

| Jotform Value | McLeod Code (Typical) |
|--------------|----------------------|
| "Net 15" | `NET15` |
| "Net 30" | `NET30` |
| "Net 45" | `NET45` |
| "Net 60" | `NET60` |
| "Due on Receipt" | `DOR` or `COD` |
| "Prepaid" | `PREPAID` |

---

## 4. Salesperson Assignment

| Jotform Field Name | Example Value | McLeod Field | Transform/Validation | Required | Notes |
|-------------------|---------------|--------------|---------------------|----------|-------|
| Blackbox Contact - First Name | "Larry" | (lookup key) | Combine with last name | **Y** | Used for salesperson lookup |
| Blackbox Contact - Last Name | "Dyer" | (lookup key) | Combine with first name | **Y** | |
| (Derived) | "LDYER" | `salesperson_id` | Lookup from mapping table | **Y** | See mapping table below |

### Salesperson Mapping Table

```javascript
const SALESPERSON_MAP = {
  // Format: "FirstName LastName" -> "SALESPERSON_ID"
  "Larry Dyer": "LDYER",
  "John Smith": "JSMITH",
  "Sarah Johnson": "SJOHNSON",
  "Mike Wilson": "MWILSON",
  // Add all Blackbox sales team members here

  // Default fallback
  "_DEFAULT": "HOUSE"  // House account or unassigned
};
```

**Lookup Logic:**
1. Combine first + last name (trim, normalize case)
2. Look up in mapping table
3. If not found, use `_DEFAULT` and flag for review

---

## 5. System/Credit Fields (Not from Jotform)

| McLeod Field | Default Value | Notes |
|--------------|--------------|-------|
| `id` | Generated (see ID strategy) | Required, unique |
| `status` | `"ACTIVE"` | Customer status |
| `category` | `"SHIPPER"` | Or `"BROKER_CUSTOMER"` |
| `credit_limit` | `0` | No credit until approved |
| `credit_status` | `"HOLD"` or `"PENDING"` | Credit on hold |
| `credit_approved` | `false` | If boolean field exists |
| `created_date` | Current timestamp | Auto-set |
| `created_by` | `"JOTFORM_API"` | For audit |
| `notes` | See template below | Include pending credit note |

### Notes Field Template

```
=== JOTFORM ONBOARDING ===
Submitted: {submission_date}
Status: PENDING CREDIT APPROVAL

LOGISTICS CONTACT:
{first} {last}
{email}
{phone}

ACCOUNTS PAYABLE:
{first} {last}
{email}
{phone}

BILLING PREFERENCES:
Terms: {payment_terms}
Invoice Method: {invoice_method}
Required Docs: {required_docs}
Payment Method: {payment_method}

AGREEMENT:
Signed: {signature_date}
Document: {document_link_or_id}
```

---

## 6. Document/Attachment Fields

| Jotform Field | Description | McLeod Storage | Notes |
|--------------|-------------|----------------|-------|
| Signature | Jotform Sign signature data | Document attachment | PDF generated by Jotform |
| Date | Signature date | Document metadata | Include in filename |
| (Derived PDF URL) | URL to signed agreement | Document or notes | See document handling |

---

## 7. Field Validation Rules

### Phone Number Normalization
```javascript
function normalizePhone(phone) {
  // Input: "(214) 555-1234" or "214-555-1234" or "2145551234"
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return digits; // or format as needed
  }
  if (digits.length === 11 && digits[0] === '1') {
    return digits.slice(1);
  }
  throw new Error(`Invalid phone: ${phone}`);
}
```

### EIN/Tax ID Normalization
```javascript
function normalizeEIN(ein) {
  // Input: "12-3456789" or "123456789"
  const digits = ein.replace(/\D/g, '');
  if (digits.length !== 9) {
    throw new Error(`Invalid EIN: ${ein}`);
  }
  return digits; // Store without hyphen
}
```

### State Code Validation
```javascript
const VALID_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
  'DC','PR','VI' // Include territories
];

function validateState(state) {
  const normalized = state.toUpperCase().trim();
  if (!VALID_STATES.includes(normalized)) {
    throw new Error(`Invalid state: ${state}`);
  }
  return normalized;
}
```

---

## 8. Fields Requiring McLeod Schema Verification

The following mappings need to be verified against actual McLeod schema:

| Jotform Concept | Assumed McLeod Field | Verify |
|----------------|---------------------|--------|
| DBA Name | `dba_name` or `name2` | Check exact field name |
| Operations Email | `email` | May have specific field |
| AP Email | `ap_email` | May not exist |
| MC/DOT Number | Separate or combined | Check structure |
| Payment Terms | `payment_terms` or `terms_code` | Check valid codes |
| Credit Status | `credit_status` | Check valid values (HOLD/PENDING/ACTIVE) |
| Contact structure | Embedded vs separate | Check if Contact Service exists |

---

## Next Steps

1. **Obtain McLeod XSD/WSDL** to verify exact field names
2. **Update assumed fields** with actual McLeod schema names
3. **Test field mappings** in sandbox environment
4. **Adjust transformations** based on McLeod validation errors
