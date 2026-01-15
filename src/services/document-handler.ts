/**
 * Document handling service
 *
 * Handles storage of signed agreement PDFs
 * Tries multiple storage backends in order of preference:
 * 1. McLeod document upload (if supported)
 * 2. Azure Blob Storage (fallback)
 * 3. Jotform URL in notes (last resort)
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
  method: 'MCLEOD_DIRECT' | 'AZURE_BLOB' | 'JOTFORM_LINK';
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
   * Attempts multiple storage backends in order
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

    // Try Plan A: McLeod direct upload
    try {
      const result = await this.uploadToMcLeod(submissionId, customerId, filename);
      if (result.success) {
        return result;
      }
    } catch (error) {
      logger.warn(
        'mcleod_document_upload_failed',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }

    // Try Plan B: Azure Blob Storage
    if (config.azure.storageConnectionString) {
      try {
        const result = await this.uploadToAzureBlob(submissionId, customerId, filename);
        if (result.success) {
          return result;
        }
      } catch (error) {
        logger.warn(
          'azure_document_upload_failed',
          error instanceof Error ? error.message : 'Unknown error'
        );
      }
    }

    // Plan C: Store Jotform URL in notes
    const jotformClient = getJotformClient();
    const jotformUrl = jotformClient.getSubmissionViewUrl(submissionId);

    try {
      await this.storeDocumentLinkInNotes(customerId, jotformUrl);
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
      error: 'All upload methods failed, stored Jotform URL in notes',
    };
  }

  /**
   * Upload document directly to McLeod
   */
  private async uploadToMcLeod(
    submissionId: string,
    customerId: string,
    filename: string
  ): Promise<DocumentUploadResult> {
    const op = logger.startOperation('upload_to_mcleod');

    try {
      // Download PDF from Jotform
      const jotformClient = getJotformClient();
      const { buffer } = await jotformClient.getSubmissionPdf(submissionId);

      // Upload to McLeod
      const mcleodClient = getMcLeodClient();
      const response = await mcleodClient.uploadDocument({
        entity_type: 'CUSTOMER',
        entity_id: customerId,
        document_type: 'AGREEMENT',
        filename,
        content_type: 'application/pdf',
        content: buffer.toString('base64'),
        description: 'Shipper/Broker Agreement - Jotform Sign',
      });

      if (response.success && response.data) {
        op.end(true, undefined, { documentId: response.data.documentId });
        return {
          success: true,
          location: `McLeod Document ID: ${response.data.documentId}`,
          method: 'MCLEOD_DIRECT',
          documentId: response.data.documentId,
        };
      }

      throw new Error(response.error?.message || 'McLeod upload failed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      op.end(false, errorMessage);
      return {
        success: false,
        location: '',
        method: 'MCLEOD_DIRECT',
        error: errorMessage,
      };
    }
  }

  /**
   * Upload document to Azure Blob Storage
   *
   * TODO: Implement actual Azure Blob upload
   */
  private async uploadToAzureBlob(
    submissionId: string,
    customerId: string,
    filename: string
  ): Promise<DocumentUploadResult> {
    const op = logger.startOperation('upload_to_azure_blob');

    try {
      // TODO: Implement Azure Blob Storage upload
      /*
      const config = getConfig();
      const { BlobServiceClient } = await import('@azure/storage-blob');

      const blobServiceClient = BlobServiceClient.fromConnectionString(
        config.azure.storageConnectionString
      );

      const containerClient = blobServiceClient.getContainerClient(
        config.azure.containerName
      );

      // Ensure container exists
      await containerClient.createIfNotExists({
        access: 'blob',
      });

      // Download PDF from Jotform
      const jotformClient = getJotformClient();
      const { buffer } = await jotformClient.getSubmissionPdf(submissionId);

      // Upload to blob
      const blobClient = containerClient.getBlockBlobClient(filename);
      await blobClient.upload(buffer, buffer.length, {
        blobHTTPHeaders: { blobContentType: 'application/pdf' },
      });

      // Get blob URL
      const blobUrl = blobClient.url;

      // Store link in McLeod notes
      await this.storeDocumentLinkInNotes(customerId, blobUrl);

      op.end(true, undefined, { blobUrl });
      return {
        success: true,
        location: blobUrl,
        method: 'AZURE_BLOB',
      };
      */

      // Placeholder - throw to indicate not implemented
      throw new Error('Azure Blob upload not implemented');
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
   * Store document link in McLeod customer notes
   */
  private async storeDocumentLinkInNotes(
    customerId: string,
    documentUrl: string
  ): Promise<void> {
    const mcleodClient = getMcLeodClient();

    await mcleodClient.appendNote(
      customerId,
      `SIGNED AGREEMENT DOCUMENT:\n${documentUrl}`
    );
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
