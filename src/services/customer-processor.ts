/**
 * Customer Processor Service
 *
 * Main business logic for processing Jotform submissions
 * and creating/updating customers in McLeod TMS
 */

import { getSalespersonId } from '../config/index.js';
import { getMcLeodClient } from './mcleod-client.js';
import { getDocumentHandler } from './document-handler.js';
import {
  logger,
  idempotencyStore,
  checkIdempotency,
  generateCustomerId,
  mapPaymentTerms,
  alertProcessingFailure,
  alertDocumentUploadFailure,
} from '../utils/index.js';
import type {
  NormalizedSubmission,
  McLeodCustomer,
  ProcessingResult,
} from '../types/index.js';

/**
 * Process a Jotform submission
 *
 * Main entry point for customer onboarding
 */
export async function processSubmission(
  submission: NormalizedSubmission
): Promise<ProcessingResult> {
  const log = logger.withSubmission(submission.submissionId);
  const op = log.startOperation('process_submission');

  try {
    // Check idempotency
    const idempotencyCheck = checkIdempotency(submission.submissionId);

    if (!idempotencyCheck.canProcess) {
      if (idempotencyCheck.existingCustomerId) {
        log.info('duplicate_submission_skipped', {
          existingCustomerId: idempotencyCheck.existingCustomerId,
        });

        op.end(true);
        return {
          success: true,
          customerId: idempotencyCheck.existingCustomerId,
          created: false,
          documentUploaded: false,
        };
      }

      // Currently processing by another request
      throw new Error('Submission is currently being processed');
    }

    // Start processing
    if (!idempotencyStore.startProcessing(submission.submissionId)) {
      throw new Error('Failed to acquire processing lock');
    }

    // Find or create customer
    const { customer, created } = await findOrCreateCustomer(submission, log);

    // Handle document upload (non-blocking)
    let documentUploaded = false;
    let documentLocation: string | undefined;

    try {
      const docHandler = getDocumentHandler();
      const docResult = await docHandler.uploadAgreement(
        submission.submissionId,
        customer.id,
        submission.company.legalName,
        submission.signature.signatureDate
      );

      documentUploaded = docResult.success;
      documentLocation = docResult.location;

      if (!docResult.success) {
        await alertDocumentUploadFailure(
          submission.submissionId,
          customer.id,
          submission.company.legalName,
          docResult.error || 'Unknown error'
        );
      }
    } catch (docError) {
      log.error(
        'document_upload_error',
        docError instanceof Error ? docError.message : 'Unknown error'
      );
    }

    // Mark as completed
    idempotencyStore.markCompleted(submission.submissionId, customer.id);

    op.end(true, undefined, {
      mcleodCustomerId: customer.id,
      created,
      documentUploaded,
    });

    return {
      success: true,
      customerId: customer.id,
      created,
      documentUploaded,
      documentLocation,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    idempotencyStore.markFailed(submission.submissionId, errorMessage);

    await alertProcessingFailure(
      submission.submissionId,
      submission.company.legalName,
      errorMessage
    );

    op.end(false, errorMessage);

    return {
      success: false,
      created: false,
      documentUploaded: false,
      error: errorMessage,
    };
  }
}

/**
 * Find existing customer or create new one
 */
async function findOrCreateCustomer(
  submission: NormalizedSubmission,
  log: ReturnType<typeof logger.withSubmission>
): Promise<{ customer: McLeodCustomer; created: boolean }> {
  const mcleodClient = getMcLeodClient();

  // Try to find by EIN first
  let existing = await mcleodClient.findCustomerByEIN(submission.company.ein);

  if (existing) {
    log.info('customer_found_by_ein', {
      mcleodCustomerId: existing.id,
      ein: submission.company.ein,
    });

    const updated = await updateExistingCustomer(existing, submission);
    return { customer: updated, created: false };
  }

  // Fallback: search by name + address
  existing = await mcleodClient.findCustomerByNameAddress(
    submission.company.legalName,
    submission.company.address.city,
    submission.company.address.state
  );

  if (existing) {
    log.info('customer_found_by_name_address', {
      mcleodCustomerId: existing.id,
      name: submission.company.legalName,
    });

    const updated = await updateExistingCustomer(existing, submission);
    return { customer: updated, created: false };
  }

  // Create new customer
  log.info('creating_new_customer', {
    name: submission.company.legalName,
    ein: submission.company.ein,
  });

  const newCustomer = await createNewCustomer(submission);
  return { customer: newCustomer, created: true };
}

/**
 * Create new customer in McLeod
 */
async function createNewCustomer(submission: NormalizedSubmission): Promise<McLeodCustomer> {
  const mcleodClient = getMcLeodClient();

  // Generate unique customer ID
  const baseId = generateCustomerId(submission.company.ein, submission.company.legalName);
  const customerId = await mcleodClient.generateUniqueCustomerId(baseId);

  // Look up salesperson
  const salespersonId = getSalespersonId(
    submission.salesperson.firstName,
    submission.salesperson.lastName
  );

  // Build customer record
  const customer: McLeodCustomer = {
    id: customerId,
    name: submission.company.legalName.toUpperCase(),
    dba_name: submission.company.dba || undefined,

    // Address
    address1: submission.company.address.street,
    address2: submission.company.address.street2 || undefined,
    city: submission.company.address.city.toUpperCase(),
    state: submission.company.address.state,
    zip_code: submission.company.address.zip,

    // Contact
    phone: submission.company.phone,
    email: submission.company.operationsEmail,

    // Tax/Regulatory
    federal_id: submission.company.ein,
    mc_number: submission.company.mcNumber || undefined,
    dot_number: submission.company.dotNumber || undefined,

    // Status - Always ACTIVE, but credit on HOLD
    status: 'ACTIVE',
    category: 'SHIPPER',

    // Credit - NO CREDIT until manual approval
    credit_limit: 0,
    credit_status: 'HOLD',
    credit_approved: false,

    // Payment
    payment_terms: mapPaymentTerms(submission.billing.paymentTerms),

    // Salesperson
    salesperson_id: salespersonId,

    // Contact fields (if McLeod uses embedded contacts)
    contact_name: `${submission.contacts.logistics.firstName} ${submission.contacts.logistics.lastName}`,
    contact_email: submission.contacts.logistics.email,
    contact_phone: submission.contacts.logistics.phone,

    // AP Contact (if McLeod has dedicated fields)
    ap_contact_name: `${submission.contacts.accountsPayable.firstName} ${submission.contacts.accountsPayable.lastName}`,
    ap_email: submission.contacts.accountsPayable.email,
    ap_phone: submission.contacts.accountsPayable.phone,

    // Notes with detailed onboarding info
    notes: buildCustomerNotes(submission),

    // Audit
    created_by: 'JOTFORM_API',
  };

  // Create in McLeod
  const response = await mcleodClient.createCustomer(customer);

  if (!response.success) {
    throw new Error(`Failed to create customer: ${response.error?.message}`);
  }

  return customer;
}

/**
 * Update existing customer with new submission data
 */
async function updateExistingCustomer(
  existing: McLeodCustomer,
  submission: NormalizedSubmission
): Promise<McLeodCustomer> {
  const mcleodClient = getMcLeodClient();

  // Build update payload - be careful not to overwrite important fields
  const updates: Partial<McLeodCustomer> = {
    // Update contact info
    email: submission.company.operationsEmail,
    phone: submission.company.phone,

    // Update address
    address1: submission.company.address.street,
    address2: submission.company.address.street2 || undefined,
    city: submission.company.address.city.toUpperCase(),
    state: submission.company.address.state,
    zip_code: submission.company.address.zip,

    // Add DBA if provided and not already set
    dba_name: submission.company.dba || existing.dba_name,

    // Update MC/DOT if provided
    mc_number: submission.company.mcNumber || existing.mc_number,
    dot_number: submission.company.dotNumber || existing.dot_number,

    // Update contacts
    contact_name: `${submission.contacts.logistics.firstName} ${submission.contacts.logistics.lastName}`,
    contact_email: submission.contacts.logistics.email,
    contact_phone: submission.contacts.logistics.phone,
    ap_contact_name: `${submission.contacts.accountsPayable.firstName} ${submission.contacts.accountsPayable.lastName}`,
    ap_email: submission.contacts.accountsPayable.email,
    ap_phone: submission.contacts.accountsPayable.phone,

    // Audit
    modified_by: 'JOTFORM_API',
  };

  // NEVER reduce credit limit or change status from ACTIVE
  // Only set credit fields if they're currently null/undefined
  if (existing.credit_limit === undefined || existing.credit_limit === null) {
    updates.credit_limit = 0;
    updates.credit_status = 'HOLD';
  }

  // Only update salesperson if not already set
  if (!existing.salesperson_id) {
    updates.salesperson_id = getSalespersonId(
      submission.salesperson.firstName,
      submission.salesperson.lastName
    );
  }

  // Update in McLeod
  const response = await mcleodClient.updateCustomer(existing.id, updates);

  if (!response.success) {
    throw new Error(`Failed to update customer: ${response.error?.message}`);
  }

  // Append note about update
  await mcleodClient.appendNote(
    existing.id,
    buildUpdateNote(submission)
  );

  // Return merged customer
  return {
    ...existing,
    ...updates,
  } as McLeodCustomer;
}

/**
 * Build comprehensive notes for new customer
 */
function buildCustomerNotes(submission: NormalizedSubmission): string {
  const signedDate = submission.signature.signatureDate
    ? submission.signature.signatureDate.toISOString().split('T')[0]
    : 'N/A';

  return `
════════════════════════════════════════════════════
⚠️  PENDING CREDIT APPROVAL
════════════════════════════════════════════════════

Created via Jotform onboarding on ${new Date().toISOString().split('T')[0]}
Jotform Submission ID: ${submission.submissionId}

CREDIT STATUS: NOT APPROVED
CREDIT LIMIT: $0.00

ACTION REQUIRED:
1. Billing team to run credit check
2. Update credit_limit to approved amount
3. Change credit_status to ACTIVE

────────────────────────────────────────────────────
LOGISTICS CONTACT
────────────────────────────────────────────────────
${submission.contacts.logistics.firstName} ${submission.contacts.logistics.lastName}
Email: ${submission.contacts.logistics.email}
Phone: ${submission.contacts.logistics.phone}

────────────────────────────────────────────────────
ACCOUNTS PAYABLE CONTACT
────────────────────────────────────────────────────
${submission.contacts.accountsPayable.firstName} ${submission.contacts.accountsPayable.lastName}
Email: ${submission.contacts.accountsPayable.email}
Phone: ${submission.contacts.accountsPayable.phone}

────────────────────────────────────────────────────
BILLING PREFERENCES
────────────────────────────────────────────────────
Payment Terms: ${submission.billing.paymentTerms}
Invoice Delivery: ${submission.billing.invoiceDelivery}
Required Documents: ${submission.billing.requirements || 'None specified'}
Payment Method: ${submission.billing.paymentMethod || 'Not specified'}

────────────────────────────────────────────────────
AGREEMENT
────────────────────────────────────────────────────
Signed: ${signedDate}
Salesperson: ${submission.salesperson.fullName}
`.trim();
}

/**
 * Build note for customer update
 */
function buildUpdateNote(submission: NormalizedSubmission): string {
  return `
JOTFORM UPDATE - ${new Date().toISOString().split('T')[0]}

New submission received (ID: ${submission.submissionId})
Contact and address information updated.
Salesperson: ${submission.salesperson.fullName}

Logistics: ${submission.contacts.logistics.firstName} ${submission.contacts.logistics.lastName} (${submission.contacts.logistics.email})
AP: ${submission.contacts.accountsPayable.firstName} ${submission.contacts.accountsPayable.lastName} (${submission.contacts.accountsPayable.email})
`.trim();
}
