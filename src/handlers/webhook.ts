/**
 * Jotform Webhook Handler
 *
 * Azure Function HTTP trigger that receives Jotform webhook payloads
 * and processes customer onboarding requests
 */

import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getConfig } from '../config/index.js';
import { processSubmission } from '../services/customer-processor.js';
import {
  logger,
  validateWebhookSignature,
  validateJotformPayload,
  normalizeSubmission,
} from '../utils/index.js';

/**
 * Main webhook handler
 */
async function webhookHandler(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const log = logger;
  log.setTraceId(context.invocationId);

  const op = log.startOperation('webhook_received');

  try {
    // Get raw body for signature validation
    const rawBody = await request.text();

    // Validate webhook signature if enabled
    const config = getConfig();
    if (config.features.webhookValidation && config.jotform.webhookSecret) {
      const signature = request.headers.get('x-jotform-signature') || '';

      if (!validateWebhookSignature(rawBody, signature, config.jotform.webhookSecret)) {
        log.warn('invalid_webhook_signature', 'Webhook signature validation failed');

        op.end(false, 'Invalid signature');
        return {
          status: 401,
          jsonBody: { error: 'Invalid webhook signature' },
        };
      }

      log.debug('webhook_signature_valid');
    }

    // Parse payload
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      log.error('invalid_json_payload', 'Failed to parse JSON payload');

      op.end(false, 'Invalid JSON');
      return {
        status: 400,
        jsonBody: { error: 'Invalid JSON payload' },
      };
    }

    // Validate payload structure
    const validation = validateJotformPayload(payload);
    if (!validation.valid || !validation.payload) {
      log.error('invalid_payload_structure', `Validation errors: ${validation.errors?.join(', ')}`);

      op.end(false, 'Validation failed');
      return {
        status: 400,
        jsonBody: {
          error: 'Invalid payload structure',
          details: validation.errors,
        },
      };
    }

    // Normalize submission data
    const submission = normalizeSubmission(validation.payload);

    log.info('processing_submission', {
      submissionId: submission.submissionId,
      companyName: submission.company.legalName,
      ein: submission.company.ein,
      salesperson: submission.salesperson.fullName,
    });

    // Process the submission
    const result = await processSubmission(submission);

    if (result.success) {
      op.end(true, undefined, {
        mcleodCustomerId: result.customerId,
        created: result.created,
        documentUploaded: result.documentUploaded,
      });

      return {
        status: 200,
        jsonBody: {
          success: true,
          customerId: result.customerId,
          created: result.created,
          documentUploaded: result.documentUploaded,
          documentLocation: result.documentLocation,
        },
      };
    } else {
      op.end(false, result.error);

      return {
        status: 500,
        jsonBody: {
          success: false,
          error: result.error,
        },
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.error('webhook_handler_error', errorMessage);

    op.end(false, errorMessage);

    return {
      status: 500,
      jsonBody: {
        success: false,
        error: 'Internal server error',
      },
    };
  }
}

/**
 * Health check endpoint
 */
async function healthCheck(
  _request: HttpRequest,
  _context: InvocationContext
): Promise<HttpResponseInit> {
  return {
    status: 200,
    jsonBody: {
      status: 'healthy',
      service: 'jotform-mcleod-integration',
      timestamp: new Date().toISOString(),
    },
  };
}

// Register Azure Function HTTP triggers
app.http('jotform-webhook', {
  methods: ['POST'],
  route: 'webhook/jotform',
  handler: webhookHandler,
});

app.http('health', {
  methods: ['GET'],
  route: 'health',
  handler: healthCheck,
});

// Export for testing
export { webhookHandler, healthCheck };
