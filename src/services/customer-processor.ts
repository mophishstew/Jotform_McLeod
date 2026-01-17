/**
 * Customer Processor Service
 *
 * Main business logic for processing Jotform submissions
 * and creating/updating customers in McLeod TMS via REST API.
 *
 * MVP Flow:
 * 1. Receive normalized submission
 * 2. Check idempotency
 * 3. Search for existing customer (by EIN, then by name+city+state)
 * 4. Create or update customer in McLeod
 * 5. Create contacts (Logistics + AP)
 * 6. Upload agreement PDF
 * 7. Add "PENDING CREDIT APPROVAL" comment
 */

import { getSalespersonId, isSalespersonFound, getConfig } from '../config/index.js';
import { getMcLeodClient } from './mcleod-client.js';
import { getDocumentHandler } from './document-handler.js';
import {
  logger,
  idempotencyStore,
  checkIdempotency,
  generateContentHash,
  generateCustomerId,
  mapPaymentTerms,
  alertProcessingFailure,
  alertDocumentUploadFailure,
  alertSalespersonNotFound,
} from '../utils/index.js';
import type {
  NormalizedSubmission,
  ProcessingResult,
} from '../types/index.js';
import type { RowCustomer, RowContact, RowComment } from '../types/mcleod.js';

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
    // Generate content hash for deduplication
    const contentHash = generateContentHash(
      submission.company.ein,
      submission.company.legalName,
      submission.company.address.city,
      submission.company.address.state
    );

    // Check idempotency
    const idempotencyCheck = await checkIdempotency(submission.submissionId);

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
    const acquired = await idempotencyStore.startProcessing(submission.submissionId, contentHash);
    if (!acquired) {
      throw new Error('Failed to acquire processing lock');
    }

    // Find or create customer
    const { customerId, created } = await findOrCreateCustomer(submission, log);

    // Create contacts (non-blocking failures)
    await createContacts(customerId, submission, log);

    // Add "PENDING CREDIT APPROVAL" comment
    await addPendingCreditComment(customerId, submission, log);

    // Handle document upload (non-blocking)
    let documentUploaded = false;
    let documentLocation: string | undefined;

    const config = getConfig();
    if (config.features.documentUpload && submission.signature.signed) {
      try {
        const docHandler = getDocumentHandler();
        const docResult = await docHandler.uploadAgreement(
          submission.submissionId,
          customerId,
          submission.company.legalName,
          submission.signature.signatureDate
        );

        documentUploaded = docResult.success;
        documentLocation = docResult.location;

        if (!docResult.success) {
          await alertDocumentUploadFailure(
            submission.submissionId,
            customerId,
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
    }

    // Mark as completed
    await idempotencyStore.markCompleted(submission.submissionId, customerId);

    op.end(true, undefined, {
      mcleodCustomerId: customerId,
      created,
      documentUploaded,
    });

    return {
      success: true,
      customerId,
      created,
      documentUploaded,
      documentLocation,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await idempotencyStore.markFailed(submission.submissionId, errorMessage);

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
): Promise<{ customerId: string; created: boolean }> {
  const mcleodClient = getMcLeodClient();

  // Try to find by EIN first (most reliable)
  log.info('searching_by_ein', { ein: submission.company.ein });

  try {
    const einResult = await mcleodClient.searchCustomers({
      'customer.federal_id': submission.company.ein,
    });

    if (einResult.customers.length > 0) {
      const existing = einResult.customers[0];
      log.info('customer_found_by_ein', {
        mcleodCustomerId: existing.id,
        ein: submission.company.ein,
      });

      await updateExistingCustomer(existing.id!, submission, log);
      return { customerId: existing.id!, created: false };
    }
  } catch (searchError) {
    log.warn('ein_search_failed', searchError instanceof Error ? searchError.message : 'Unknown');
  }

  // Fallback: search by name + city + state
  log.info('searching_by_name_address', {
    name: submission.company.legalName,
    city: submission.company.address.city,
    state: submission.company.address.state,
  });

  try {
    const nameResult = await mcleodClient.searchCustomers({
      'customer.name': submission.company.legalName,
      'customer.city': submission.company.address.city,
      'customer.state': submission.company.address.state,
    });

    if (nameResult.customers.length > 0) {
      // Find exact match
      const normalizedName = submission.company.legalName.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const exactMatch = nameResult.customers.find((c) => {
        const customerName = (c.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        return customerName === normalizedName;
      });

      if (exactMatch) {
        log.info('customer_found_by_name_address', {
          mcleodCustomerId: exactMatch.id,
          name: submission.company.legalName,
        });

        await updateExistingCustomer(exactMatch.id!, submission, log);
        return { customerId: exactMatch.id!, created: false };
      }
    }
  } catch (searchError) {
    log.warn('name_search_failed', searchError instanceof Error ? searchError.message : 'Unknown');
  }

  // Create new customer
  log.info('creating_new_customer', {
    name: submission.company.legalName,
    ein: submission.company.ein,
  });

  const customerId = await createNewCustomer(submission, log);
  return { customerId, created: true };
}

/**
 * Create new customer in McLeod
 */
async function createNewCustomer(
  submission: NormalizedSubmission,
  log: ReturnType<typeof logger.withSubmission>
): Promise<string> {
  const mcleodClient = getMcLeodClient();

  // Get default customer template from McLeod
  let customerDefaults: RowCustomer;
  try {
    customerDefaults = await mcleodClient.getCustomerDefaults();
    log.info('got_customer_defaults', { fieldCount: Object.keys(customerDefaults).length });
  } catch (defaultsError) {
    log.warn('get_defaults_failed', 'Using minimal customer structure');
    customerDefaults = {
      name: '',
      address1: '',
      city: '',
      state: '',
      zip_code: '',
    };
  }

  // Generate unique customer ID
  const baseId = generateCustomerId(submission.company.ein, submission.company.legalName);
  const customerId = await mcleodClient.generateUniqueCustomerId(baseId);

  // Look up salesperson
  const salespersonId = getSalespersonId(
    submission.salesperson.firstName,
    submission.salesperson.lastName
  );

  // Alert if salesperson not found
  if (!isSalespersonFound(salespersonId)) {
    log.warn('salesperson_not_found', submission.salesperson.fullName);
    await alertSalespersonNotFound(
      submission.submissionId,
      submission.company.legalName,
      submission.salesperson.fullName
    );
  }

  // Build customer record starting from defaults
  const customer: RowCustomer = {
    ...customerDefaults,

    // Customer ID
    id: customerId,

    // Company info
    name: submission.company.legalName.toUpperCase(),
    name2: submission.company.dba || undefined,
    address1: submission.company.address.street,
    address2: submission.company.address.street2 || undefined,
    city: submission.company.address.city.toUpperCase(),
    state: submission.company.address.state,
    zip_code: submission.company.address.zip,
    country_code: 'USA',

    // Contact
    phone1: submission.company.phone,
    email: submission.company.operationsEmail,

    // Tax/Regulatory
    federal_id: submission.company.ein,
    ic_number: submission.company.mcNumber || undefined,

    // Status - Active but no credit
    status: 'A',

    // Credit - TENTATIVE (pending approval, do not extend terms)
    credit_limit: 0,
    credit_status: 'T', // Tentative - pending credit approval

    // Payment terms
    terms: mapPaymentTerms(submission.billing.paymentTerms),

    // Salesperson
    salesperson_id: salespersonId,

    // Primary contact name
    contact_name: `${submission.contacts.logistics.firstName} ${submission.contacts.logistics.lastName}`,

    // Audit
    entered_user_id: 'JOTFORM_API',
  };

  // Create in McLeod
  const response = await mcleodClient.createCustomer(customer);

  if (!response.success) {
    throw new Error(`Failed to create customer: ${response.error?.message}`);
  }

  log.info('customer_created', {
    mcleodCustomerId: customerId,
    salespersonId,
    creditLimit: 0,
  });

  return customerId;
}

/**
 * Update existing customer with new submission data
 */
async function updateExistingCustomer(
  customerId: string,
  submission: NormalizedSubmission,
  log: ReturnType<typeof logger.withSubmission>
): Promise<void> {
  const mcleodClient = getMcLeodClient();

  // Get existing customer to preserve important fields
  const existing = await mcleodClient.getCustomerById(customerId);
  if (!existing) {
    throw new Error(`Customer ${customerId} not found for update`);
  }

  // Build update - preserve credit settings, only update contact/address info
  const updatePayload: RowCustomer = {
    ...existing,
    id: customerId,

    // Update contact info
    email: submission.company.operationsEmail,
    phone1: submission.company.phone,

    // Update address
    address1: submission.company.address.street,
    address2: submission.company.address.street2 || undefined,
    city: submission.company.address.city.toUpperCase(),
    state: submission.company.address.state,
    zip_code: submission.company.address.zip,

    // Add DBA if provided and not already set
    name2: submission.company.dba || existing.name2,

    // Update MC number if provided
    ic_number: submission.company.mcNumber || existing.ic_number,

    // Update primary contact
    contact_name: `${submission.contacts.logistics.firstName} ${submission.contacts.logistics.lastName}`,
  };

  // Only update salesperson if not already set
  if (!existing.salesperson_id) {
    const salespersonId = getSalespersonId(
      submission.salesperson.firstName,
      submission.salesperson.lastName
    );
    updatePayload.salesperson_id = salespersonId;

    if (!isSalespersonFound(salespersonId)) {
      await alertSalespersonNotFound(
        submission.submissionId,
        submission.company.legalName,
        submission.salesperson.fullName
      );
    }
  }

  // Credit handling logic:
  // - If customer is already Approved (A), NEVER change credit_status or credit_limit
  // - If not Approved, preserve existing values (don't reduce or change without approval)
  const isApproved = existing.credit_status === 'A';

  if (isApproved) {
    // Customer has approved credit - preserve everything
    updatePayload.credit_limit = existing.credit_limit;
    updatePayload.credit_status = existing.credit_status;
    log.info('credit_preserved_approved', {
      customerId,
      creditLimit: existing.credit_limit,
      creditStatus: 'A',
    });
  } else {
    // Not approved - preserve existing settings (don't overwrite with Tentative)
    updatePayload.credit_limit = existing.credit_limit;
    updatePayload.credit_status = existing.credit_status;
    log.info('credit_preserved_pending', {
      customerId,
      creditLimit: existing.credit_limit,
      creditStatus: existing.credit_status,
    });
  }

  // Update in McLeod
  const response = await mcleodClient.updateCustomer(updatePayload);

  if (!response.success) {
    throw new Error(`Failed to update customer: ${response.error?.message}`);
  }

  log.info('customer_updated', {
    mcleodCustomerId: customerId,
    preservedCreditLimit: existing.credit_limit,
    preservedCreditStatus: existing.credit_status,
    wasApproved: isApproved,
  });
}

/**
 * Create contacts for the customer
 */
async function createContacts(
  customerId: string,
  submission: NormalizedSubmission,
  log: ReturnType<typeof logger.withSubmission>
): Promise<void> {
  const mcleodClient = getMcLeodClient();

  // Create Logistics contact
  const logisticsContact: RowContact = {
    row_type: 'C',
    parent_row_id: customerId,
    first_name: submission.contacts.logistics.firstName,
    last_name: submission.contacts.logistics.lastName,
    name: `${submission.contacts.logistics.firstName} ${submission.contacts.logistics.lastName}`,
    email: submission.contacts.logistics.email,
    phone: submission.contacts.logistics.phone,
    contact_type_id: 'LOGISTICS',
    is_primary: true,
  };

  try {
    const logResult = await mcleodClient.createContact(logisticsContact);
    if (logResult.success) {
      log.info('logistics_contact_created', { contactId: logResult.data?.contactId });
    } else {
      log.warn('logistics_contact_failed', logResult.error?.message || 'Unknown');
    }
  } catch (contactError) {
    log.warn('logistics_contact_error', contactError instanceof Error ? contactError.message : 'Unknown');
  }

  // Create AP contact
  const apContact: RowContact = {
    row_type: 'C',
    parent_row_id: customerId,
    first_name: submission.contacts.accountsPayable.firstName,
    last_name: submission.contacts.accountsPayable.lastName,
    name: `${submission.contacts.accountsPayable.firstName} ${submission.contacts.accountsPayable.lastName}`,
    email: submission.contacts.accountsPayable.email,
    phone: submission.contacts.accountsPayable.phone,
    contact_type_id: 'AP',
    is_primary: false,
  };

  try {
    const apResult = await mcleodClient.createContact(apContact);
    if (apResult.success) {
      log.info('ap_contact_created', { contactId: apResult.data?.contactId });
    } else {
      log.warn('ap_contact_failed', apResult.error?.message || 'Unknown');
    }
  } catch (contactError) {
    log.warn('ap_contact_error', contactError instanceof Error ? contactError.message : 'Unknown');
  }
}

/**
 * Add "PENDING CREDIT APPROVAL" comment to customer
 */
async function addPendingCreditComment(
  customerId: string,
  submission: NormalizedSubmission,
  log: ReturnType<typeof logger.withSubmission>
): Promise<void> {
  const mcleodClient = getMcLeodClient();

  const signedDate = submission.signature.signatureDate
    ? submission.signature.signatureDate.toISOString().split('T')[0]
    : 'N/A';

  const commentText = `
════════════════════════════════════════════════════
⚠️  PENDING CREDIT APPROVAL — DO NOT EXTEND TERMS
════════════════════════════════════════════════════

Created via Jotform onboarding on ${new Date().toISOString().split('T')[0]}
Jotform Submission ID: ${submission.submissionId}

CREDIT STATUS: T (Tentative)
CREDIT LIMIT: $0.00

ACTION REQUIRED:
1. Billing team to run credit check
2. Update credit_limit to approved amount
3. Change credit_status to A (Approved)

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

  const comment: RowComment = {
    row_type: 'C',
    parent_row_id: customerId,
    comment: commentText,
    comment_type: 'JOTFORM',
    entered_user_id: 'JOTFORM_API',
  };

  try {
    const result = await mcleodClient.createComment(comment);
    if (result.success) {
      log.info('pending_credit_comment_added', { commentId: result.data?.commentId });
    } else {
      log.warn('pending_credit_comment_failed', result.error?.message || 'Unknown');
    }
  } catch (commentError) {
    log.warn('pending_credit_comment_error', commentError instanceof Error ? commentError.message : 'Unknown');
  }
}
