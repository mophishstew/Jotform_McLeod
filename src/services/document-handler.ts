/**
 * Document handling service
 *
 * Handles storage of signed agreement PDFs
 *
 * Strategy:
 * Plan A: Upload directly to McLeod Imaging via ImagingService REST endpoint
 *         POST /images/C/{customerId}/{documentTypeId}
 *
 * Plan B: Store in Azure Blob Storage and add link to customer comment
 *
 * Plan C: Store Jotform URL in customer comment (last resort)
 */

import { getConfig } from '../config/index.js';
import { getMcLeodClient } from './mcleod-client.js';
import { getJotformClient } from './jotform-client.js';
import { logger, sanitizeFilename, formatDate } from '../utils/index.js';

/**
 * Document upload result
 */
export interface DocumentUploadResult {
  success: boolean;
  location: string;
  method: 'MCLEOD_IMAGING' | 'AZURE_BLOB' | 'JOTFORM_LINK';
  documentId?: string;
  error?: string;
}

/**
 * Document handler service
 */
export class DocumentHandler {
  /**
   * Upload signed agreement document
   *
   * Attempts multiple storage backends in order of preference
   */
  async uploadAgreement(
    submissionId: string,
    customerId: string,
    customerName: string,
    signedDate: Date | null
  ): Promise<DocumentUploadResult> {
    const config = getConfig();

    if (!config.features.documentUpload) {
      logger.info('document_upload_disabled');
      return {
        success: false,
        location: '',
        method: 'JOTFORM_LINK',
        error: 'Document upload feature is disabled',
      };
    }

    // Generate filename
    const filename = this.generateFilename(submissionId, customerName, signedDate);

    // Download PDF from Jotform first (needed for both Plan A and B)
    let pdfBuffer: Buffer | null = null;
    try {
      const jotformClient = getJotformClient();
      const { buffer } = await jotformClient.getSubmissionPdf(submissionId);
      pdfBuffer = buffer;
      logger.info('pdf_downloaded_from_jotform', { submissionId, fileSize: buffer.length });
    } catch (downloadError) {
      logger.warn(
        'pdf_download_failed',
        downloadError instanceof Error ? downloadError.message : 'Unknown error',
        { submissionId }
      );
      // Continue - we can still use Jotform link as fallback
    }

    // Plan A: McLeod Imaging direct upload
    if (pdfBuffer) {
      try {
        const result = await this.uploadToMcLeodImaging(
          customerId,
          pdfBuffer,
          filename
        );
        if (result.success) {
          return result;
        }
      } catch (error) {
        logger.warn(
          'mcleod_imaging_upload_failed',
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
    }

    // Plan B: Azure Blob Storage
    if (pdfBuffer && config.azure.blobConnectionString) {
      try {
        const result = await this.uploadToAzureBlob(
          submissionId,
          customerId,
          pdfBuffer,
          filename
        );
        if (result.success) {
          return result;
        }
      } catch (error) {
        logger.warn(
          'azure_blob_upload_failed',
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
    }

    // Plan C: Store Jotform URL in customer comment
    const jotformClient = getJotformClient();
    const jotformUrl = jotformClient.getSubmissionViewUrl(submissionId);

    try {
      await this.storeDocumentLinkInComment(customerId, jotformUrl, submissionId);
    } catch (error) {
      logger.error(
        'store_document_link_failed',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }

    return {
      success: false,
      location: jotformUrl,
      method: 'JOTFORM_LINK',
      error: 'All upload methods failed, stored Jotform URL in comment',
    };
  }

  /**
   * Plan A: Upload document to McLeod Imaging
   *
   * Uses POST /images/C/{customerId}/{documentTypeId}
   */
  private async uploadToMcLeodImaging(
    customerId: string,
    pdfBuffer: Buffer,
    filename: string
  ): Promise<DocumentUploadResult> {
    const op = logger.startOperation('upload_to_mcleod_imaging');
    const config = getConfig();

    try {
      const mcleodClient = getMcLeodClient();
      const documentTypeId = config.mcleod.agreementDocumentTypeId;

      const response = await mcleodClient.uploadCustomerAgreementPdf(
        customerId,
        documentTypeId,
        pdfBuffer
      );

      if (response.success && response.data) {
        op.end(true, undefined, {
          documentId: response.data.documentId,
          filename,
        });

        return {
          success: true,
          location: `McLeod Imaging: ${response.data.documentId}`,
          method: 'MCLEOD_IMAGING',
          documentId: response.data.documentId,
        };
      }

      throw new Error(response.error?.message || 'McLeod Imaging upload failed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      op.end(false, errorMessage);

      return {
        success: false,
        location: '',
        method: 'MCLEOD_IMAGING',
        error: errorMessage,
      };
    }
  }

  /**
   * Plan B: Upload document to Azure Blob Storage
   */
  private async uploadToAzureBlob(
    submissionId: string,
    customerId: string,
    pdfBuffer: Buffer,
    filename: string
  ): Promise<DocumentUploadResult> {
    const op = logger.startOperation('upload_to_azure_blob');
    const config = getConfig();

    try {
      // Dynamic import Azure SDK
      const { BlobServiceClient } = await import('@azure/storage-blob');

      const blobServiceClient = BlobServiceClient.fromConnectionString(
        config.azure.blobConnectionString
      );

      const containerClient = blobServiceClient.getContainerClient(
        config.azure.blobContainerName
      );

      // Ensure container exists
      await containerClient.createIfNotExists({
        access: 'blob',
      });

      // Upload blob
      const blobName = `${customerId}/${filename}`;
      const blobClient = containerClient.getBlockBlobClient(blobName);

      await blobClient.upload(pdfBuffer, pdfBuffer.length, {
        blobHTTPHeaders: {
          blobContentType: 'application/pdf',
        },
        metadata: {
          customerId,
          submissionId,
          uploadedAt: new Date().toISOString(),
        },
      });

      const blobUrl = blobClient.url;

      // Store link in McLeod comment
      await this.storeDocumentLinkInComment(customerId, blobUrl, submissionId);

      op.end(true, undefined, { blobUrl, blobName });

      return {
        success: true,
        location: blobUrl,
        method: 'AZURE_BLOB',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      op.end(false, errorMessage);

      return {
        success: false,
        location: '',
        method: 'AZURE_BLOB',
        error: errorMessage,
      };
    }
  }

  /**
   * Store document link in McLeod customer comment
   */
  private async storeDocumentLinkInComment(
    customerId: string,
    documentUrl: string,
    submissionId: string
  ): Promise<void> {
    const mcleodClient = getMcLeodClient();

    const comment = `
────────────────────────────────────────────────────
SIGNED AGREEMENT DOCUMENT
────────────────────────────────────────────────────
Jotform Submission ID: ${submissionId}
Document Location: ${documentUrl}
Uploaded: ${new Date().toISOString()}

Note: Document was stored externally.
Access the URL above to view/download.
────────────────────────────────────────────────────
`.trim();

    await mcleodClient.appendNote(customerId, comment);
  }

  /**
   * Generate filename for document
   */
  private generateFilename(
    submissionId: string,
    customerName: string,
    signedDate: Date | null
  ): string {
    const sanitizedName = sanitizeFilename(customerName);
    const dateStr = signedDate ? formatDate(signedDate) : formatDate(new Date());

    return `Agreement_${sanitizedName}_${dateStr}_${submissionId}.pdf`;
  }
}

/**
 * Singleton instance
 */
let handlerInstance: DocumentHandler | null = null;

export function getDocumentHandler(): DocumentHandler {
  if (!handlerInstance) {
    handlerInstance = new DocumentHandler();
  }
  return handlerInstance;
}

/**
 * Reset handler (for testing)
 */
export function resetDocumentHandler(): void {
  handlerInstance = null;
}
