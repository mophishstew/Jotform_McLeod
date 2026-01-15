# McLeod TMS Web Services - Endpoint Discovery Plan

## Overview

McLeod LoadMaster/PowerBroker TMS exposes functionality via SOAP-based Web Services. This document outlines the discovery plan for identifying the correct services and operations needed for customer onboarding automation.

---

## 1. Required Service Operations

### 1.1 Customer Create/Update

| Service Name (Likely) | Operation | Purpose |
|----------------------|-----------|---------|
| `CustomerService` | `CreateCustomer` / `AddCustomer` | Create new customer record |
| `CustomerService` | `UpdateCustomer` / `ModifyCustomer` | Update existing customer |
| `CustomerService` | `UpsertCustomer` | Create or update (if available) |
| `CustomerService` | `GetCustomer` / `FindCustomer` | Retrieve customer by ID |
| `CustomerService` | `SearchCustomers` / `QueryCustomers` | Search by criteria (EIN, name, etc.) |

**Discovery Actions:**
1. Check WSDL at: `https://{mcleod-host}/webservices/CustomerService?wsdl`
2. Review McLeod Web Services documentation for "Customer" operations
3. Look for `customer.xsd` schema file in documentation

### 1.2 Customer Search by EIN/Tax ID

| Endpoint Pattern | Notes |
|-----------------|-------|
| `CustomerService.FindCustomerByTaxId` | Ideal - direct lookup |
| `CustomerService.SearchCustomers` with `federal_id` filter | Common pattern |
| `CustomerService.GetCustomerList` with criteria | Fallback if no direct search |

**Key Questions to Answer:**
- Does McLeod index `federal_id` (EIN/Tax ID) for search?
- Can we search by partial name + address as fallback?
- What's the maximum result set size?

### 1.3 Document/Attachment Upload

| Service Name (Likely) | Operation | Purpose |
|----------------------|-----------|---------|
| `DocumentService` | `UploadDocument` / `AttachDocument` | Attach file to entity |
| `DocumentService` | `CreateDocument` | Create document record |
| `ImageService` | `UploadImage` / `AttachImage` | Alternative for binary files |
| `CustomerService` | `AddCustomerDocument` | If embedded in customer service |

**Discovery Actions:**
1. Check if McLeod has `DocumentService` or `ImageService` WSDL
2. Review if documents are linked via `customer_id` or separate entity
3. Determine supported file types (PDF likely supported)
4. Check max file size limits

### 1.4 Contact Management

| Service Name (Likely) | Operation | Purpose |
|----------------------|-----------|---------|
| `ContactService` | `CreateContact` / `AddContact` | Create contact record |
| `CustomerService` | `AddCustomerContact` | Add contact linked to customer |

**Note:** McLeod may store contacts as:
- Embedded fields on customer (primary contact)
- Separate `contact` table linked by `customer_id`
- Custom fields or notes

---

## 2. Expected Request/Response Patterns

### 2.1 Customer Create Request (Expected Structure)

```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <Authentication>
      <Username>{username}</Username>
      <Password>{password}</Password>
      <!-- OR API Key / Token -->
    </Authentication>
  </soap:Header>
  <soap:Body>
    <CreateCustomer xmlns="http://mcleod.com/webservices/customer">
      <customer>
        <id>{REQUIRED: Unique customer ID}</id>
        <name>{Legal Company Name}</name>
        <dba_name>{DBA if any}</dba_name>
        <address1>{Street Address}</address1>
        <address2>{Street Address Line 2}</address2>
        <city>{City}</city>
        <state>{State}</state>
        <zip_code>{Postal Code}</zip_code>
        <phone>{Main Phone}</phone>
        <federal_id>{EIN/Tax ID}</federal_id>
        <mc_number>{MC Number}</mc_number>
        <dot_number>{DOT Number}</dot_number>
        <credit_limit>0</credit_limit>
        <credit_status>HOLD</credit_status>
        <salesperson_id>{Salesperson ID}</salesperson_id>
        <category>{Customer Type}</category>
        <status>ACTIVE</status>
        <!-- Contacts may be nested or separate -->
        <contacts>
          <contact type="LOGISTICS">
            <name>{First Last}</name>
            <email>{email}</email>
            <phone>{phone}</phone>
          </contact>
          <contact type="ACCOUNTS_PAYABLE">
            <name>{First Last}</name>
            <email>{email}</email>
            <phone>{phone}</phone>
          </contact>
        </contacts>
      </customer>
    </CreateCustomer>
  </soap:Body>
</soap:Envelope>
```

### 2.2 Customer Search Request

```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <Authentication>...</Authentication>
  </soap:Header>
  <soap:Body>
    <SearchCustomers xmlns="http://mcleod.com/webservices/customer">
      <criteria>
        <federal_id>{EIN}</federal_id>
        <!-- OR -->
        <name>{Company Name}</name>
        <city>{City}</city>
        <state>{State}</state>
      </criteria>
      <max_results>10</max_results>
    </SearchCustomers>
  </soap:Body>
</soap:Envelope>
```

### 2.3 Expected Response

```xml
<soap:Envelope>
  <soap:Body>
    <CreateCustomerResponse>
      <result>
        <success>true</success>
        <customer_id>CUST123456</customer_id>
        <message>Customer created successfully</message>
      </result>
    </CreateCustomerResponse>
  </soap:Body>
</soap:Envelope>
```

---

## 3. Authentication Methods

McLeod Web Services typically support:

| Method | Description | Preference |
|--------|-------------|------------|
| **Basic Auth** | Username/password in HTTP header | Common for SOAP |
| **WS-Security** | Username token in SOAP header | More secure |
| **API Key** | Custom header or token | If supported |
| **OAuth 2.0** | Token-based | Newer installations |

**Discovery Actions:**
1. Check McLeod admin console for Web Services credentials
2. Review WSDL security policy elements
3. Test with SoapUI using different auth methods

---

## 4. Customer ID Generation Strategy

### The Problem
McLeod typically requires a unique `customer.id` (alphanumeric, often 6-15 chars). This ID is:
- User-visible in the UI
- Used as primary key
- Cannot be changed after creation

### Recommended Strategy

**Primary Approach: EIN-based ID**
```
Format: BB{EIN-last-7}
Example: EIN 12-3456789 → BB3456789
```

**Collision Handling:**
```
If BB3456789 exists:
  Try BB3456789A
  Try BB3456789B
  ... up to BB3456789Z
  Then BB3456789-001, BB3456789-002, etc.
```

**Fallback (No EIN):**
```
Format: BB{YYYYMMDD}{SEQ}
Example: BB20240115001
```

---

## 5. Required Fields Analysis

Based on typical McLeod customer schemas:

| Field | Required | Default if Empty |
|-------|----------|-----------------|
| `id` | **YES** | Must generate |
| `name` | **YES** | From Legal Company Name |
| `address1` | **YES** | From Jotform |
| `city` | **YES** | From Jotform |
| `state` | **YES** | From Jotform |
| `zip_code` | **YES** | From Jotform |
| `phone` | Usually | From Main Phone |
| `status` | **YES** | "ACTIVE" |
| `category` | Often | "SHIPPER" or configurable |
| `credit_limit` | No | 0 |
| `credit_status` | No | "HOLD" or "PENDING" |
| `salesperson_id` | No | From mapping table |

---

## 6. Action Items for Discovery

### Immediate (Before Coding)
- [ ] Obtain McLeod Web Services documentation from vendor/admin
- [ ] Get WSDL URLs for available services
- [ ] Obtain test credentials for sandbox environment
- [ ] Confirm customer ID format requirements
- [ ] Verify which fields are actually required

### During Development
- [ ] Test each endpoint with SoapUI first
- [ ] Capture actual request/response XML samples
- [ ] Document any deviations from expected patterns

### Post-Discovery Updates
- [ ] Update field mapping table with actual McLeod field names
- [ ] Adjust code to match actual SOAP envelope structure
- [ ] Configure proper WS-Security if required

---

## 7. Alternative: McLeod REST API

Some newer McLeod installations offer REST APIs alongside SOAP:

```
GET  /api/v1/customers?federal_id={ein}
POST /api/v1/customers
PUT  /api/v1/customers/{id}
POST /api/v1/customers/{id}/documents
```

**Check with McLeod admin if REST API is available** - it would significantly simplify integration.

---

## Next Steps

1. **Contact McLeod administrator** to obtain:
   - Web Services documentation
   - WSDL URLs
   - Test/sandbox credentials
   - Customer ID format rules

2. **Test connectivity** with a simple GetCustomer call

3. **Update this document** with actual endpoint details

4. **Proceed to implementation** once endpoints are confirmed
