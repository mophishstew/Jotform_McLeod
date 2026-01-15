/**
 * Jotform submission types
 * These types represent the webhook payload from Jotform
 */

import { z } from 'zod';

/**
 * Raw Jotform webhook payload structure
 * Field names match Jotform's actual field IDs/names
 */
export const JotformWebhookPayloadSchema = z.object({
  // Submission metadata
  submissionID: z.string(),
  formID: z.string(),
  formTitle: z.string().optional(),
  submittedAt: z.string().optional(),

  // Company Information
  // Note: Jotform field names vary - update these to match your actual form field names/IDs
  q_company_legal_name: z.string().min(1, 'Legal company name is required'),
  q_company_dba: z.string().optional().default(''),

  // Address fields (Jotform may send as single object or separate fields)
  q_address_street: z.string().min(1, 'Street address is required'),
  q_address_street2: z.string().optional().default(''),
  q_address_city: z.string().min(1, 'City is required'),
  q_address_state: z.string().min(2, 'State is required'),
  q_address_zip: z.string().min(5, 'Zip code is required'),

  // Contact info
  q_main_phone: z.string().min(10, 'Phone number is required'),
  q_operations_email: z.string().email('Valid operations email is required'),
  q_ein_tax_id: z.string().min(9, 'EIN/Tax ID is required'),
  q_mc_dot_number: z.string().optional().default(''),

  // Logistics Contact
  q_logistics_first_name: z.string().min(1, 'Logistics contact first name is required'),
  q_logistics_last_name: z.string().min(1, 'Logistics contact last name is required'),
  q_logistics_email: z.string().email('Valid logistics contact email is required'),
  q_logistics_phone: z.string().min(10, 'Logistics contact phone is required'),

  // Accounts Payable Contact
  q_ap_first_name: z.string().min(1, 'AP contact first name is required'),
  q_ap_last_name: z.string().min(1, 'AP contact last name is required'),
  q_ap_email: z.string().email('Valid AP email is required'),
  q_ap_phone: z.string().min(10, 'AP phone is required'),

  // Billing preferences
  q_payment_terms: z.string().min(1, 'Payment terms are required'),
  q_invoice_delivery: z.string().min(1, 'Invoice delivery preference is required'),
  q_billing_requirements: z.string().optional().default(''),
  q_payment_method: z.string().optional().default(''),

  // Blackbox Contact (Salesperson)
  q_blackbox_contact_first: z.string().min(1, 'Blackbox contact first name is required'),
  q_blackbox_contact_last: z.string().min(1, 'Blackbox contact last name is required'),

  // Signature (Jotform Sign)
  q_signature: z.string().optional(),
  q_signature_date: z.string().optional(),
});

export type JotformWebhookPayload = z.infer<typeof JotformWebhookPayloadSchema>;

/**
 * Normalized submission data after transformation
 */
export interface NormalizedSubmission {
  submissionId: string;
  formId: string;
  submittedAt: Date;

  company: {
    legalName: string;
    dba: string;
    address: {
      street: string;
      street2: string;
      city: string;
      state: string;
      zip: string;
    };
    phone: string;
    operationsEmail: string;
    ein: string;
    mcNumber: string;
    dotNumber: string;
  };

  contacts: {
    logistics: {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
    };
    accountsPayable: {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
    };
  };

  billing: {
    paymentTerms: string;
    invoiceDelivery: string;
    requirements: string;
    paymentMethod: string;
  };

  salesperson: {
    firstName: string;
    lastName: string;
    fullName: string;
  };

  signature: {
    signed: boolean;
    signatureDate: Date | null;
  };
}

/**
 * Alternative schema for when Jotform sends nested address object
 */
export const JotformAddressSchema = z.object({
  addr_line1: z.string().optional(),
  addr_line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postal: z.string().optional(),
});

/**
 * Field name mapping - customize these based on your actual Jotform form
 * The keys are our internal names, values are the actual Jotform field names/IDs
 */
export const JOTFORM_FIELD_MAP: Record<string, string> = {
  // Update these with actual Jotform field names from your form
  // You can find these by examining webhook payloads or in Jotform form builder

  'company.legalName': 'q_company_legal_name',
  'company.dba': 'q_company_dba',
  'address.street': 'q_address_street',
  'address.street2': 'q_address_street2',
  'address.city': 'q_address_city',
  'address.state': 'q_address_state',
  'address.zip': 'q_address_zip',
  'company.phone': 'q_main_phone',
  'company.email': 'q_operations_email',
  'company.ein': 'q_ein_tax_id',
  'company.mcDot': 'q_mc_dot_number',

  'logistics.firstName': 'q_logistics_first_name',
  'logistics.lastName': 'q_logistics_last_name',
  'logistics.email': 'q_logistics_email',
  'logistics.phone': 'q_logistics_phone',

  'ap.firstName': 'q_ap_first_name',
  'ap.lastName': 'q_ap_last_name',
  'ap.email': 'q_ap_email',
  'ap.phone': 'q_ap_phone',

  'billing.terms': 'q_payment_terms',
  'billing.invoiceDelivery': 'q_invoice_delivery',
  'billing.requirements': 'q_billing_requirements',
  'billing.paymentMethod': 'q_payment_method',

  'salesperson.firstName': 'q_blackbox_contact_first',
  'salesperson.lastName': 'q_blackbox_contact_last',

  'signature': 'q_signature',
  'signatureDate': 'q_signature_date',
};
