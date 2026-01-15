/**
 * Jotform API Client
 *
 * Handles communication with Jotform API for fetching submissions and PDFs
 */

import { getConfig } from '../config/index.js';
import { logger, withRetry } from '../utils/index.js';

const JOTFORM_API_BASE = 'https://api.jotform.com';

/**
 * Jotform API Client
 */
export class JotformClient {
  private readonly apiKey: string;

  constructor() {
    const config = getConfig();
    this.apiKey = config.jotform.apiKey;
  }

  /**
   * Fetch submission details by ID
   */
  async getSubmission(submissionId: string): Promise<Record<string, unknown>> {
    const op = logger.startOperation('jotform_get_submission');

    try {
      const response = await withRetry(async () => {
        const res = await fetch(`${JOTFORM_API_BASE}/submission/${submissionId}`, {
          headers: {
            'APIKEY': this.apiKey,
          },
        });

        if (!res.ok) {
          throw new Error(`Jotform API error: ${res.status} ${res.statusText}`);
        }

        return res.json();
      });

      op.end(true, undefined, { submissionId });
      return response as Record<string, unknown>;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      op.end(false, errorMessage);
      throw error;
    }
  }

  /**
   * Download signed agreement PDF for a submission
   *
   * Jotform generates PDFs for form submissions with signatures
   */
  async getSubmissionPdf(submissionId: string): Promise<{ buffer: Buffer; filename: string }> {
    const op = logger.startOperation('jotform_get_pdf');

    try {
      const response = await withRetry(async () => {
        const res = await fetch(`${JOTFORM_API_BASE}/submission/${submissionId}/pdf`, {
          headers: {
            'APIKEY': this.apiKey,
          },
        });

        if (!res.ok) {
          throw new Error(`Jotform PDF download error: ${res.status} ${res.statusText}`);
        }

        return res;
      });

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const filename = `Agreement_${submissionId}.pdf`;

      op.end(true, undefined, { submissionId, fileSize: buffer.length });

      return { buffer, filename };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      op.end(false, errorMessage);
      throw error;
    }
  }

  /**
   * Get direct URL to the submission PDF
   *
   * Some integrations may prefer URL over downloading the file
   */
  getSubmissionPdfUrl(submissionId: string): string {
    // Note: This URL requires authentication
    // For public access, you may need to use a different endpoint
    return `${JOTFORM_API_BASE}/submission/${submissionId}/pdf?apiKey=${this.apiKey}`;
  }

  /**
   * Get Jotform submission view URL (for fallback/manual access)
   */
  getSubmissionViewUrl(submissionId: string): string {
    return `https://www.jotform.com/submission/${submissionId}`;
  }
}

/**
 * Singleton Jotform client instance
 */
let clientInstance: JotformClient | null = null;

export function getJotformClient(): JotformClient {
  if (!clientInstance) {
    clientInstance = new JotformClient();
  }
  return clientInstance;
}
