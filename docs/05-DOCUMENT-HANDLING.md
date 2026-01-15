# Document Handling Strategy

## Overview

Each Jotform submission includes a signed shipper/broker agreement (via Jotform Sign). This document must be stored and linked to the customer record in McLeod TMS.

---

## 1. Jotform Sign Document Access

### 1.1 How Jotform Provides the Signed Document

When a form with Jotform Sign is submitted:

1. **Submission Data** contains signature metadata:
   ```json
   {
     "signature_field": {
       "signature_url": "https://www.jotform.com/sign/...",
       "signed_at": "2024-01-15T10:30:00Z",
       "signer_name": "John Smith",
       "signer_ip": "192.168.1.1"
     }
   }
   ```

2. **PDF Document** is generated and available via:
   - Direct URL in webhook payload (if configured)
   - Jotform API: `GET /submission/{id}/pdf`
   - Jotform Sign download link

### 1.2 Retrieving the PDF

```typescript
async function getSignedAgreementPdf(
  submissionId: string
): Promise<{ buffer: Buffer; filename: string }> {
  // Option 1: Direct PDF download from Jotform
  const response = await fetch(
    `https://api.jotform.com/submission/${submissionId}/pdf`,
    {
      headers: {
        'APIKEY': process.env.JOTFORM_API_KEY
      }
    }
  );

  const buffer = Buffer.from(await response.arrayBuffer());
  const filename = `Agreement_${submissionId}.pdf`;

  return { buffer, filename };
}
```

---

## 2. Storage Options

### Plan A: Direct Upload to McLeod (Preferred)

**If McLeod supports document attachments:**

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Jotform    │────▶│  Integration │────▶│   McLeod     │
│  (PDF URL)   │     │   Service    │     │  Document    │
└──────────────┘     └──────────────┘     │   Service    │
                                          └──────────────┘
```

**McLeod Document Service (Expected):**
```typescript
async function uploadToMcLeod(
  customerId: string,
  pdfBuffer: Buffer,
  filename: string
): Promise<string> {
  // SOAP request to McLeod DocumentService
  const response = await mcleodApi.uploadDocument({
    entity_type: 'CUSTOMER',
    entity_id: customerId,
    document_type: 'AGREEMENT',  // Or 'CONTRACT', 'SIGNED_AGREEMENT'
    filename: filename,
    content_type: 'application/pdf',
    content: pdfBuffer.toString('base64'),
    description: 'Shipper/Broker Agreement - Jotform Sign'
  });

  return response.document_id;
}
```

**Advantages:**
- Document stored with customer in McLeod
- Visible in McLeod UI
- No external dependencies

**Disadvantages:**
- Requires McLeod document support
- May have file size limits

### Plan B: SharePoint/OneDrive Storage

**If McLeod doesn't support document uploads:**

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Jotform    │────▶│  Integration │────▶│  SharePoint  │
│  (PDF URL)   │     │   Service    │     │  /OneDrive   │
└──────────────┘     └──────────────┘     └──────┬───────┘
                            │                     │
                            │  Store link         │
                            ▼                     │
                     ┌──────────────┐             │
                     │   McLeod     │◀────────────┘
                     │   (Notes/    │   (SharePoint URL)
                     │   Custom)    │
                     └──────────────┘
```

**SharePoint Upload:**
```typescript
async function uploadToSharePoint(
  pdfBuffer: Buffer,
  filename: string,
  customerName: string
): Promise<string> {
  const graph = getGraphClient();

  // Upload to designated folder
  const folderPath = `/Customer Agreements/${sanitizeFolderName(customerName)}`;

  // Ensure folder exists
  await ensureFolder(graph, folderPath);

  // Upload file
  const response = await graph
    .api(`/sites/{site-id}/drive/root:${folderPath}/${filename}:/content`)
    .put(pdfBuffer);

  // Get sharing link
  const shareLink = await graph
    .api(`/sites/{site-id}/drive/items/${response.id}/createLink`)
    .post({
      type: 'view',
      scope: 'organization'
    });

  return shareLink.link.webUrl;
}
```

**Store Link in McLeod:**
```typescript
async function storeDocumentLink(
  customerId: string,
  documentUrl: string
): Promise<void> {
  // Option 1: Custom field (if available)
  await mcleodApi.updateCustomer(customerId, {
    custom_field_1: documentUrl,  // Or 'agreement_url'
  });

  // Option 2: Notes field (always available)
  await mcleodApi.appendNote(customerId,
    `SIGNED AGREEMENT: ${documentUrl}`
  );
}
```

**Advantages:**
- Works regardless of McLeod document support
- Leverages existing SharePoint infrastructure
- Better for large files

**Disadvantages:**
- Requires Microsoft Graph API setup
- Document not directly visible in McLeod

### Plan C: Azure Blob Storage (Fallback)

**Simplest cloud storage option:**

```typescript
async function uploadToAzureBlob(
  pdfBuffer: Buffer,
  filename: string
): Promise<string> {
  const blobServiceClient = BlobServiceClient.fromConnectionString(
    process.env.AZURE_STORAGE_CONNECTION_STRING
  );

  const containerClient = blobServiceClient
    .getContainerClient('customer-agreements');

  const blobClient = containerClient.getBlockBlobClient(filename);

  await blobClient.upload(pdfBuffer, pdfBuffer.length, {
    blobHTTPHeaders: { blobContentType: 'application/pdf' }
  });

  // Generate SAS URL (long-lived for McLeod access)
  const sasUrl = generateSasUrl(blobClient, {
    expiresOn: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year
  });

  return sasUrl;
}
```

**Advantages:**
- Simple to implement
- Cost-effective
- No additional infrastructure

**Disadvantages:**
- Not integrated with existing document management
- SAS URLs can expire

---

## 3. Document Metadata

### 3.1 Filename Convention

```typescript
function generateFilename(
  submissionId: string,
  customerName: string,
  signedDate: Date
): string {
  const sanitizedName = customerName
    .replace(/[^a-zA-Z0-9]/g, '_')
    .substring(0, 30);

  const dateStr = signedDate.toISOString().split('T')[0]; // YYYY-MM-DD

  return `Agreement_${sanitizedName}_${dateStr}_${submissionId}.pdf`;
}

// Example: Agreement_Acme_Logistics_Inc_2024-01-15_5432109876543210987.pdf
```

### 3.2 Document Properties

```typescript
interface DocumentMetadata {
  filename: string;
  document_type: 'SHIPPER_BROKER_AGREEMENT';
  uploaded_date: Date;
  signed_date: Date;
  signer_name: string;
  source: 'JOTFORM_SIGN';
  jotform_submission_id: string;
  customer_id: string;
  customer_name: string;
  file_size_bytes: number;
  content_type: 'application/pdf';
}
```

---

## 4. Implementation Flow

### 4.1 Complete Document Handling Flow

```typescript
async function handleAgreementDocument(
  submissionId: string,
  customerId: string,
  customerName: string,
  signedDate: Date
): Promise<{ success: boolean; location: string; method: string }> {

  // Step 1: Download PDF from Jotform
  const { buffer, filename } = await getSignedAgreementPdf(submissionId);

  const finalFilename = generateFilename(submissionId, customerName, signedDate);

  // Step 2: Try Plan A - McLeod direct upload
  try {
    const docId = await uploadToMcLeod(customerId, buffer, finalFilename);
    return {
      success: true,
      location: `McLeod Document ID: ${docId}`,
      method: 'MCLEOD_DIRECT'
    };
  } catch (mcleodError) {
    console.log('McLeod upload failed, trying SharePoint:', mcleodError.message);
  }

  // Step 3: Try Plan B - SharePoint
  if (process.env.SHAREPOINT_ENABLED === 'true') {
    try {
      const sharePointUrl = await uploadToSharePoint(buffer, finalFilename, customerName);
      await storeDocumentLink(customerId, sharePointUrl);
      return {
        success: true,
        location: sharePointUrl,
        method: 'SHAREPOINT'
      };
    } catch (spError) {
      console.log('SharePoint upload failed, trying Azure Blob:', spError.message);
    }
  }

  // Step 4: Plan C - Azure Blob Storage
  try {
    const blobUrl = await uploadToAzureBlob(buffer, finalFilename);
    await storeDocumentLink(customerId, blobUrl);
    return {
      success: true,
      location: blobUrl,
      method: 'AZURE_BLOB'
    };
  } catch (blobError) {
    console.error('All document upload methods failed:', blobError);
  }

  // Step 5: Last resort - store Jotform URL in notes
  const jotformUrl = `https://www.jotform.com/submission/${submissionId}`;
  await mcleodApi.appendNote(customerId,
    `AGREEMENT DOCUMENT - Upload failed. View at: ${jotformUrl}`
  );

  return {
    success: false,
    location: jotformUrl,
    method: 'JOTFORM_LINK_ONLY'
  };
}
```

### 4.2 Error Handling

```typescript
async function safeDocumentUpload(
  submissionId: string,
  customerId: string,
  customerName: string,
  signedDate: Date
): Promise<void> {
  try {
    const result = await handleAgreementDocument(
      submissionId,
      customerId,
      customerName,
      signedDate
    );

    if (result.success) {
      console.log(`Document stored via ${result.method}: ${result.location}`);
    } else {
      // Alert but don't fail the customer creation
      await sendSlackAlert({
        level: 'warning',
        message: `Document upload failed for customer ${customerId}`,
        details: `Fallback link stored: ${result.location}`
      });
    }
  } catch (error) {
    // Document upload is non-critical - customer should still be created
    console.error('Document handling completely failed:', error);

    await sendSlackAlert({
      level: 'error',
      message: `Document handling failed for submission ${submissionId}`,
      error: error.message
    });

    // Store note that document needs manual handling
    try {
      await mcleodApi.appendNote(customerId,
        `⚠️ MANUAL ACTION REQUIRED: Agreement document failed to upload. ` +
        `Retrieve from Jotform submission ${submissionId}`
      );
    } catch (noteError) {
      console.error('Even note update failed:', noteError);
    }
  }
}
```

---

## 5. McLeod Document Service Discovery

### 5.1 Questions to Answer

1. Does McLeod have a `DocumentService` or `ImageService`?
2. What document types are supported (AGREEMENT, CONTRACT, etc.)?
3. Is there a max file size?
4. Are documents viewable in McLeod customer UI?
5. Is there a document search/retrieval API?

### 5.2 Test Procedure

```bash
# Check for DocumentService WSDL
curl "https://{mcleod-host}/webservices/DocumentService?wsdl"

# Check for ImageService WSDL
curl "https://{mcleod-host}/webservices/ImageService?wsdl"

# Check for CustomerDocumentService
curl "https://{mcleod-host}/webservices/CustomerDocumentService?wsdl"
```

### 5.3 Alternative: McLeod Images/Documents Table

Some McLeod installations store documents in an `images` or `documents` table:

```sql
-- Check for document table structure
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('images', 'documents', 'customer_documents')
ORDER BY table_name, ordinal_position;
```

If direct table access is available:
```sql
INSERT INTO images (
  entity_type, entity_id, image_type, description,
  filename, content_type, content, created_date
) VALUES (
  'CUSTOMER', '{customer_id}', 'AGREEMENT', 'Jotform Agreement',
  '{filename}', 'application/pdf', '{base64_content}', GETDATE()
);
```

---

## 6. SharePoint Configuration (if needed)

### 6.1 Required Azure AD App Registration

```
Application (client) ID: {app-id}
Directory (tenant) ID: {tenant-id}

API Permissions:
- Sites.ReadWrite.All (Application)
- Files.ReadWrite.All (Application)

Client Secret: {stored in Key Vault}
```

### 6.2 SharePoint Site Structure

```
/sites/BlackboxLogistics
  /Shared Documents
    /Customer Agreements
      /{Customer Name}
        /Agreement_Acme_2024-01-15.pdf
```

---

## 7. Summary

| Priority | Method | When to Use |
|----------|--------|-------------|
| **Plan A** | McLeod Document Service | If McLeod supports document uploads |
| **Plan B** | SharePoint/OneDrive | If using Microsoft 365, McLeod doesn't support docs |
| **Plan C** | Azure Blob Storage | Simple fallback, no M365 |
| **Last Resort** | Jotform URL in Notes | All uploads failed |

**MVP Recommendation:**
1. Start with Plan A (attempt McLeod upload)
2. Implement Plan C (Azure Blob) as fallback
3. Add Plan B (SharePoint) in Phase 2 if needed

**Non-Blocking Strategy:**
Document upload failures should **never** prevent customer creation. The customer record is the critical deliverable; document storage is important but can be handled manually if automation fails.
