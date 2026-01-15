/**
 * McLeod TMS customer types
 * These types represent the McLeod customer schema
 *
 * TODO: Update field names to match actual McLeod schema after WSDL review
 */

/**
 * McLeod customer record structure
 * Field names are based on typical McLeod schema - verify against actual WSDL
 */
export interface McLeodCustomer {
  // Primary identifier - required, unique, cannot change after creation
  id: string;

  // Company information
  name: string;                    // Legal company name
  dba_name?: string;               // DBA / alternate name (may be name2)
  address1: string;
  address2?: string;
  city: string;
  state: string;                   // 2-letter state code
  zip_code: string;

  // Contact information
  phone?: string;                  // Main phone (may be phone1)
  phone2?: string;                 // Secondary phone
  fax?: string;
  email?: string;                  // Primary email (operations)

  // Tax/regulatory
  federal_id?: string;             // EIN/Tax ID (9 digits, no hyphen)
  mc_number?: string;              // Motor Carrier number
  dot_number?: string;             // DOT number

  // Status and classification
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'PENDING';
  category?: string;               // SHIPPER, BROKER_CUSTOMER, etc.
  customer_type?: string;

  // Credit
  credit_limit: number;
  credit_status?: 'ACTIVE' | 'HOLD' | 'PENDING' | 'REVIEW' | 'COD' | 'PREPAID';
  credit_approved?: boolean;
  credit_approved_by?: string;
  credit_approved_date?: string;

  // Payment
  payment_terms?: string;          // NET30, NET45, etc.
  payment_method?: string;

  // Assignment
  salesperson_id?: string;         // Salesperson code

  // Contact fields (if not using separate contact records)
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;

  // AP Contact (if McLeod has dedicated fields)
  ap_contact_name?: string;
  ap_email?: string;
  ap_phone?: string;

  // Notes and metadata
  notes?: string;
  comments?: string;
  created_date?: string;
  created_by?: string;
  modified_date?: string;
  modified_by?: string;

  // Custom fields (if available in McLeod)
  custom_field_1?: string;
  custom_field_2?: string;
  custom_field_3?: string;
}

/**
 * Customer search criteria
 */
export interface McLeodSearchCriteria {
  id?: string;
  name?: string;
  federal_id?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  phone?: string;
  email?: string;
  status?: string;
}

/**
 * Search results
 */
export interface McLeodSearchResult {
  customers: McLeodCustomer[];
  totalCount: number;
  hasMore: boolean;
}

/**
 * Document attachment
 */
export interface McLeodDocument {
  document_id?: string;
  entity_type: 'CUSTOMER' | 'ORDER' | 'LOAD';
  entity_id: string;
  document_type: string;          // AGREEMENT, CONTRACT, POD, BOL, etc.
  filename: string;
  content_type: string;           // application/pdf, image/png, etc.
  content?: string;               // Base64 encoded
  description?: string;
  uploaded_date?: string;
  uploaded_by?: string;
}

/**
 * Contact record (if McLeod uses separate contact table)
 */
export interface McLeodContact {
  contact_id?: string;
  customer_id: string;
  contact_type: 'PRIMARY' | 'LOGISTICS' | 'ACCOUNTS_PAYABLE' | 'BILLING' | 'OTHER';
  first_name: string;
  last_name: string;
  title?: string;
  email?: string;
  phone?: string;
  fax?: string;
  is_primary?: boolean;
}

/**
 * API response wrapper
 */
export interface McLeodApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: string;
  };
}

/**
 * Valid credit status codes - verify against actual McLeod configuration
 */
export const MCLEOD_CREDIT_STATUS = {
  ACTIVE: 'ACTIVE',
  HOLD: 'HOLD',
  PENDING: 'PENDING',
  REVIEW: 'REVIEW',
  COD: 'COD',
  PREPAID: 'PREPAID',
  SUSPENDED: 'SUSPENDED',
} as const;

/**
 * Valid customer status codes
 */
export const MCLEOD_CUSTOMER_STATUS = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  SUSPENDED: 'SUSPENDED',
  PENDING: 'PENDING',
} as const;

/**
 * Payment terms mapping - verify codes against McLeod lookup tables
 */
export const MCLEOD_PAYMENT_TERMS: Record<string, string> = {
  'Net 15': 'NET15',
  'Net 30': 'NET30',
  'Net 45': 'NET45',
  'Net 60': 'NET60',
  'Due on Receipt': 'DOR',
  'Cash on Delivery': 'COD',
  'Prepaid': 'PREPAID',
};
