/**
 * Validation and transformation utilities
 */

import crypto from 'crypto';
import type { JotformWebhookPayload, NormalizedSubmission } from '../types/index.js';
import { JotformWebhookPayloadSchema } from '../types/jotform.js';
import { getSalespersonId } from '../config/index.js';

/**
 * Valid US state codes
 */
const VALID_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR', 'VI', // Include territories
]);

/**
 * Validate Jotform webhook signature
 */
export function validateWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  if (!signature || !secret) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Validate and parse Jotform payload
 */
export function validateJotformPayload(data: unknown): {
  valid: boolean;
  payload?: JotformWebhookPayload;
  errors?: string[];
} {
  const result = JotformWebhookPayloadSchema.safeParse(data);

  if (result.success) {
    return { valid: true, payload: result.data };
  }

  const errors = result.error.errors.map(
    (e) => `${e.path.join('.')}: ${e.message}`
  );

  return { valid: false, errors };
}

/**
 * Normalize phone number to 10 digits
 */
export function normalizePhone(phone: string): string {
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '');

  // Handle 11-digit numbers starting with 1 (country code)
  if (digits.length === 11 && digits[0] === '1') {
    return digits.slice(1);
  }

  // Validate 10-digit number
  if (digits.length === 10) {
    return digits;
  }

  throw new Error(`Invalid phone number: ${phone}`);
}

/**
 * Normalize EIN/Tax ID to 9 digits without hyphen
 */
export function normalizeEIN(ein: string): string {
  // Remove all non-digit characters
  const digits = ein.replace(/\D/g, '');

  if (digits.length !== 9) {
    throw new Error(`Invalid EIN: ${ein}`);
  }

  return digits;
}

/**
 * Validate and normalize state code
 */
export function normalizeState(state: string): string {
  const normalized = state.trim().toUpperCase();

  // Handle full state names (common variations)
  const stateNameMap: Record<string, string> = {
    'TEXAS': 'TX',
    'CALIFORNIA': 'CA',
    'FLORIDA': 'FL',
    'NEW YORK': 'NY',
    'ILLINOIS': 'IL',
    // Add more as needed
  };

  const mappedState = stateNameMap[normalized] || normalized;

  if (!VALID_STATES.has(mappedState)) {
    throw new Error(`Invalid state code: ${state}`);
  }

  return mappedState;
}

/**
 * Normalize zip code (5 or 9 digits)
 */
export function normalizeZip(zip: string): string {
  // Remove all non-alphanumeric characters
  const cleaned = zip.replace(/[^0-9]/g, '');

  // Accept 5 or 9 digit zip codes
  if (cleaned.length === 5 || cleaned.length === 9) {
    return cleaned;
  }

  // If we get something like 752011234, return first 5
  if (cleaned.length > 5) {
    return cleaned.slice(0, 5);
  }

  throw new Error(`Invalid zip code: ${zip}`);
}

/**
 * Parse MC/DOT number
 */
export function parseMcDotNumber(value: string): { mc?: string; dot?: string } {
  if (!value || value.trim() === '') {
    return {};
  }

  const cleaned = value.trim().toUpperCase();

  // Extract MC number
  const mcMatch = cleaned.match(/MC[#\-\s]*(\d+)/i);
  const mc = mcMatch ? mcMatch[1] : undefined;

  // Extract DOT number
  const dotMatch = cleaned.match(/DOT[#\-\s]*(\d+)/i);
  const dot = dotMatch ? dotMatch[1] : undefined;

  // If no prefix, try to determine by length
  if (!mc && !dot) {
    const digits = cleaned.replace(/\D/g, '');
    if (digits.length > 0) {
      // MC numbers are typically 6 digits, DOT can vary
      // Default to MC if ambiguous
      return { mc: digits };
    }
  }

  return { mc, dot };
}

/**
 * Normalize full Jotform payload to internal format
 */
export function normalizeSubmission(payload: JotformWebhookPayload): NormalizedSubmission {
  const mcDot = parseMcDotNumber(payload.q_mc_dot_number);

  return {
    submissionId: payload.submissionID,
    formId: payload.formID,
    submittedAt: payload.submittedAt ? new Date(payload.submittedAt) : new Date(),

    company: {
      legalName: payload.q_company_legal_name.trim(),
      dba: payload.q_company_dba?.trim() || '',
      address: {
        street: payload.q_address_street.trim(),
        street2: payload.q_address_street2?.trim() || '',
        city: payload.q_address_city.trim(),
        state: normalizeState(payload.q_address_state),
        zip: normalizeZip(payload.q_address_zip),
      },
      phone: normalizePhone(payload.q_main_phone),
      operationsEmail: payload.q_operations_email.toLowerCase().trim(),
      ein: normalizeEIN(payload.q_ein_tax_id),
      mcNumber: mcDot.mc || '',
      dotNumber: mcDot.dot || '',
    },

    contacts: {
      logistics: {
        firstName: payload.q_logistics_first_name.trim(),
        lastName: payload.q_logistics_last_name.trim(),
        email: payload.q_logistics_email.toLowerCase().trim(),
        phone: normalizePhone(payload.q_logistics_phone),
      },
      accountsPayable: {
        firstName: payload.q_ap_first_name.trim(),
        lastName: payload.q_ap_last_name.trim(),
        email: payload.q_ap_email.toLowerCase().trim(),
        phone: normalizePhone(payload.q_ap_phone),
      },
    },

    billing: {
      paymentTerms: payload.q_payment_terms.trim(),
      invoiceDelivery: payload.q_invoice_delivery.trim(),
      requirements: payload.q_billing_requirements?.trim() || '',
      paymentMethod: payload.q_payment_method?.trim() || '',
    },

    salesperson: {
      firstName: payload.q_blackbox_contact_first.trim(),
      lastName: payload.q_blackbox_contact_last.trim(),
      fullName: `${payload.q_blackbox_contact_first.trim()} ${payload.q_blackbox_contact_last.trim()}`,
    },

    signature: {
      signed: !!payload.q_signature,
      signatureDate: payload.q_signature_date ? new Date(payload.q_signature_date) : null,
    },
  };
}

/**
 * Generate deterministic customer ID from EIN
 */
export function generateCustomerId(ein: string, companyName: string): string {
  // Primary: Use EIN (most unique)
  if (ein && ein.length === 9) {
    // Format: BB + last 7 digits of EIN
    // "BB" prefix identifies Blackbox-created customers
    return `BB${ein.slice(2)}`;
  }

  // Fallback: Use company name + date
  const namePrefix = companyName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);

  const dateSuffix = new Date()
    .toISOString()
    .slice(2, 10)
    .replace(/-/g, '');

  return `${namePrefix}${dateSuffix}`;
}

/**
 * Map payment terms to McLeod code
 */
export function mapPaymentTerms(terms: string): string {
  const mapping: Record<string, string> = {
    'net 15': 'NET15',
    'net 30': 'NET30',
    'net 45': 'NET45',
    'net 60': 'NET60',
    'due on receipt': 'DOR',
    'cash on delivery': 'COD',
    'prepaid': 'PREPAID',
  };

  const normalized = terms.toLowerCase().trim();
  return mapping[normalized] || 'NET30'; // Default to NET30
}
