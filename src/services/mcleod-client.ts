/**
 * McLeod TMS REST API Client
 *
 * CRITICAL: McLeod uses REST API, NOT SOAP.
 * All endpoints are under /ws/api
 *
 * Authentication:
 * - POST /users/login with Basic Auth returns a token
 * - Use Authorization: Bearer {token} for subsequent requests
 *
 * Customer endpoints:
 * - GET  /customers/new           - Get default RowCustomer template
 * - GET  /customers/{id}          - Get customer by ID
 * - GET  /customers/search        - Search customers with query params
 * - POST /customers/create        - Create new customer (body: RowCustomer) - uses POST!
 * - PUT  /customers/update        - Update customer (body: RowCustomer with id)
 *
 * Contact endpoints (per mcleod-api-reference.md):
 * - GET  /contacts/C/{customerId} - Get contacts for customer
 * - PUT  /contacts/create         - Create contact (body: RowContact)
 *
 * Comment endpoints:
 * - PUT  /comments/create         - Create comment (body: RowComment)
 *
 * Imaging endpoints (per mcleod-api-reference.md):
 * - POST /images/C/{customerId}/{documentTypeId} - Upload document
 */

import { getConfig } from '../config/index.js';
import { logger, withRetry, sleep } from '../utils/index.js';
import type {
  RowCustomer,
  RowContact,
  RowComment,
  CustomerSearchParams,
  CustomerSearchResult,
  McLeodApiResponse,
  LoginResponse,
  McLeodCustomer,
  McLeodSearchCriteria,
  McLeodSearchResult,
  McLeodDocument,
} from '../types/index.js';

/**
 * HTTP methods supported
 */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * McLeod REST API Client
 */
export class McLeodClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeout: number;
  private readonly authMode: 'token' | 'basic' | 'login';
  private readonly companyId: string;

  // Token caching
  private token: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor() {
    const config = getConfig();
    this.baseUrl = config.mcleod.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.username = config.mcleod.username;
    this.password = config.mcleod.password;
    this.timeout = config.mcleod.timeout;
    this.authMode = config.mcleod.authMode;
    this.companyId = config.mcleod.companyId;

    // If token provided via env, use it directly
    if (config.mcleod.token) {
      this.token = config.mcleod.token;
      this.tokenExpiresAt = Date.now() + (24 * 60 * 60 * 1000); // Assume 24h for env token
    }
  }

  /**
   * Get or refresh authentication token
   */
  private async getAuthToken(): Promise<string> {
    // If using basic auth, return empty (auth header built differently)
    if (this.authMode === 'basic') {
      return '';
    }

    // Check if token is still valid (with 5 min buffer)
    if (this.token && this.tokenExpiresAt > Date.now() + 300000) {
      return this.token;
    }

    // If auth mode is 'token' and we have a token from env, use it
    if (this.authMode === 'token' && this.token) {
      return this.token;
    }

    // Login to get new token
    const op = logger.startOperation('mcleod_login');
    try {
      const credentials = Buffer.from(`${this.username}:${this.password}`).toString('base64');

      const response = await fetch(`${this.baseUrl}/users/login`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(this.companyId && { 'X-Company-Id': this.companyId }),
        },
        signal: AbortSignal.timeout(this.timeout),
      });

      if (!response.ok) {
        throw new Error(`Login failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as LoginResponse;
      this.token = data.token;
      // Default to 1 hour if no expiry provided
      this.tokenExpiresAt = Date.now() + ((data.expiresIn || 3600) * 1000);

      op.end(true);
      return this.token;
    } catch (error) {
      op.end(false, error instanceof Error ? error.message : 'Login failed');
      throw error;
    }
  }

  /**
   * Build authorization header
   */
  private async getAuthHeader(): Promise<Record<string, string>> {
    if (this.authMode === 'basic') {
      const credentials = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      return { 'Authorization': `Basic ${credentials}` };
    }

    const token = await this.getAuthToken();
    return { 'Authorization': `Bearer ${token}` };
  }

  /**
   * Make an HTTP request to McLeod API with retries
   */
  private async request<T>(
    method: HttpMethod,
    endpoint: string,
    body?: unknown,
    contentType: string = 'application/json'
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    return withRetry(
      async () => {
        const authHeader = await this.getAuthHeader();

        const headers: Record<string, string> = {
          ...authHeader,
          'Accept': 'application/json',
          ...(this.companyId && { 'X-Company-Id': this.companyId }),
        };

        if (body && contentType !== 'application/pdf') {
          headers['Content-Type'] = contentType;
        }

        const response = await fetch(url, {
          method,
          headers,
          body: body ? (contentType === 'application/json' ? JSON.stringify(body) : body as BodyInit) : undefined,
          signal: AbortSignal.timeout(this.timeout),
        });

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
          await sleep(retryAfter * 1000);
          throw new Error('Rate limited, retrying');
        }

        // Handle auth errors - refresh token and retry
        if (response.status === 401 && this.authMode !== 'basic') {
          this.token = null;
          this.tokenExpiresAt = 0;
          throw new Error('Auth expired, retrying');
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`McLeod API error ${response.status}: ${errorText}`);
        }

        // Handle empty responses
        const text = await response.text();
        if (!text) {
          return {} as T;
        }

        return JSON.parse(text) as T;
      },
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        shouldRetry: (error) => {
          if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            return (
              msg.includes('rate limited') ||
              msg.includes('auth expired') ||
              msg.includes('429') ||
              msg.includes('5') ||
              msg.includes('timeout') ||
              msg.includes('network') ||
              msg.includes('econnreset')
            );
          }
          return false;
        },
      }
    );
  }

  // ============================================
  // CustomerService REST Endpoints
  // ============================================

  /**
   * GET /customers/new - Get default RowCustomer template
   * Start with this to get the correct field structure
   */
  async getCustomerDefaults(): Promise<RowCustomer> {
    const op = logger.startOperation('mcleod_get_customer_defaults');
    try {
      const result = await this.request<RowCustomer>('GET', '/customers/new');
      op.end(true);
      return result;
    } catch (error) {
      op.end(false, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * GET /customers/search - Search customers by criteria
   * Query params can use prefixes like customer.federal_id or no prefix
   */
  async searchCustomers(params: CustomerSearchParams): Promise<CustomerSearchResult> {
    const op = logger.startOperation('mcleod_search_customers');
    try {
      // Build query string
      const queryParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== '') {
          queryParams.append(key, value);
        }
      }

      const endpoint = `/customers/search?${queryParams.toString()}`;
      const result = await this.request<RowCustomer[]>('GET', endpoint);

      // Response is typically an array of customers
      const customers = Array.isArray(result) ? result : [];

      op.end(true, undefined, { count: customers.length });
      return {
        customers,
        totalCount: customers.length,
        hasMore: false, // Pagination would need additional handling
      };
    } catch (error) {
      op.end(false, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * GET /customers?q={query} - Search customers by general query
   * This is the confirmed working endpoint for searching by customer ID or name
   * Use this for deterministic ID lookups and name-based searches
   */
  async searchCustomersByQuery(query: string): Promise<CustomerSearchResult> {
    const op = logger.startOperation('mcleod_search_customers_by_query');
    try {
      const endpoint = `/customers?q=${encodeURIComponent(query)}`;
      const result = await this.request<RowCustomer[]>('GET', endpoint);

      // Response is typically an array of customers
      const customers = Array.isArray(result) ? result : [];

      op.end(true, undefined, { query, count: customers.length });
      return {
        customers,
        totalCount: customers.length,
        hasMore: false,
      };
    } catch (error) {
      op.end(false, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * GET /customers/{id} - Get customer by ID
   * Returns null if customer doesn't exist (404 or empty response)
   */
  async getCustomerById(customerId: string): Promise<RowCustomer | null> {
    const op = logger.startOperation('mcleod_get_customer_by_id');
    try {
      const result = await this.request<RowCustomer>('GET', `/customers/${encodeURIComponent(customerId)}`);

      // McLeod may return 200 with empty object instead of 404
      // Check if we got actual customer data
      if (!result || !result.id || Object.keys(result).length === 0) {
        op.end(true, undefined, { customerId, found: false });
        return null;
      }

      op.end(true, undefined, { customerId, found: true });
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        op.end(true, undefined, { customerId, found: false });
        return null;
      }
      op.end(false, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * Create new customer in McLeod
   *
   * IMPORTANT: Uses POST not PUT for creation.
   * - POST /customers or POST /customers/create - Creates new customer
   * - PUT is typically for updates where client specifies ID
   *
   * When no ID is provided, McLeod auto-generates based on name/city/state
   * Format: first 3 letters of name + first 2 of city + first of state
   */
  async createCustomer(customer: RowCustomer): Promise<McLeodApiResponse<{ customerId: string }>> {
    const op = logger.startOperation('mcleod_create_customer');
    try {
      // Log the full request payload for debugging
      logger.info('mcleod_create_request', {
        hasId: !!customer.id,
        name: customer.name,
        city: customer.city,
        state_id: customer.state_id,
        fieldCount: Object.keys(customer).length,
      });

      // Use POST for creating new customers (not PUT)
      // This is critical - PUT may just validate without persisting
      const result = await this.request<RowCustomer>('POST', '/customers/create', customer);

      // Log full response to see what McLeod actually returned
      logger.info('mcleod_create_response', {
        sentId: customer.id,
        returnedId: result.id,
        returnedName: result.name,
        returnedFields: Object.keys(result),
        fullResponse: JSON.stringify(result).slice(0, 500), // First 500 chars
      });

      // McLeod may return a different ID than what we sent (auto-generated)
      const customerId = result.id || customer.id || '';

      op.end(true, undefined, { customerId, sentId: customer.id, returnedId: result.id });
      return {
        success: true,
        data: { customerId },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('mcleod_create_error', errorMessage);
      op.end(false, errorMessage);
      return {
        success: false,
        error: {
          code: 'CREATE_FAILED',
          message: errorMessage,
        },
      };
    }
  }

  /**
   * PUT /customers/update - Update existing customer
   * Body must include customer.id
   */
  async updateCustomer(customer: RowCustomer): Promise<McLeodApiResponse<void>> {
    const op = logger.startOperation('mcleod_update_customer');
    try {
      if (!customer.id) {
        throw new Error('Customer ID is required for update');
      }

      await this.request<RowCustomer>('PUT', '/customers/update', customer);

      op.end(true, undefined, { customerId: customer.id });
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      op.end(false, errorMessage);
      return {
        success: false,
        error: {
          code: 'UPDATE_FAILED',
          message: errorMessage,
        },
      };
    }
  }

  // ============================================
  // ContactService REST Endpoints
  // ============================================

  /**
   * GET /contacts/C/{customerId} - Get contacts for a customer
   * RowType "C" indicates customer contacts
   */
  async getContacts(customerId: string): Promise<RowContact[]> {
    const op = logger.startOperation('mcleod_get_contacts');
    try {
      const result = await this.request<RowContact[]>('GET', `/contacts/C/${encodeURIComponent(customerId)}`);
      const contacts = Array.isArray(result) ? result : [];
      op.end(true, undefined, { customerId, count: contacts.length });
      return contacts;
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        op.end(true, undefined, { customerId, count: 0 });
        return [];
      }
      op.end(false, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * PUT /contacts/create - Create a new contact
   * RowContact must include row_type: 'C' and parent_row_id (customer ID)
   */
  async createContact(contact: RowContact): Promise<McLeodApiResponse<{ contactId: string }>> {
    const op = logger.startOperation('mcleod_create_contact');
    try {
      const result = await this.request<RowContact>('PUT', '/contacts/create', contact);
      const contactId = result.id || '';

      op.end(true, undefined, { contactId, customerId: contact.parent_row_id });
      return {
        success: true,
        data: { contactId },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      op.end(false, errorMessage);
      return {
        success: false,
        error: {
          code: 'CREATE_CONTACT_FAILED',
          message: errorMessage,
        },
      };
    }
  }

  // ============================================
  // CommentService REST Endpoints
  // ============================================

  /**
   * PUT /comments/create - Create a comment on a customer
   * RowComment must include row_type: 'C' and parent_row_id (customer ID)
   */
  async createComment(comment: RowComment): Promise<McLeodApiResponse<{ commentId: string }>> {
    const op = logger.startOperation('mcleod_create_comment');
    try {
      const result = await this.request<RowComment>('PUT', '/comments/create', comment);
      const commentId = result.id || '';

      op.end(true, undefined, { commentId, customerId: comment.parent_row_id });
      return {
        success: true,
        data: { commentId },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      op.end(false, errorMessage);
      return {
        success: false,
        error: {
          code: 'CREATE_COMMENT_FAILED',
          message: errorMessage,
        },
      };
    }
  }

  // ============================================
  // ImagingService REST Endpoints
  // ============================================

  /**
   * POST /images/C/{customerId}/{documentTypeId} - Upload a document
   * Content-Type should be application/pdf (or appropriate type)
   * Returns document ID on success
   */
  async uploadCustomerAgreementPdf(
    customerId: string,
    documentTypeId: string,
    pdfBuffer: Buffer
  ): Promise<McLeodApiResponse<{ documentId: string }>> {
    const op = logger.startOperation('mcleod_upload_pdf');
    try {
      const endpoint = `/images/C/${encodeURIComponent(customerId)}/${encodeURIComponent(documentTypeId)}`;

      // For PDF upload, we need to send raw binary with appropriate content-type
      const url = `${this.baseUrl}${endpoint}`;
      const authHeader = await this.getAuthHeader();

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...authHeader,
          'Content-Type': 'application/pdf',
          'Accept': 'application/json',
          ...(this.companyId && { 'X-Company-Id': this.companyId }),
        },
        body: new Uint8Array(pdfBuffer),  // Convert Buffer to Uint8Array for fetch compatibility
        signal: AbortSignal.timeout(this.timeout * 2), // Longer timeout for uploads
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed: ${response.status} ${errorText}`);
      }

      // Parse response for document ID
      const text = await response.text();
      let documentId = '';
      if (text) {
        try {
          const data = JSON.parse(text);
          documentId = data.id || data.document_id || data.imageId || '';
        } catch {
          // Response might just be the ID as text
          documentId = text.trim();
        }
      }

      op.end(true, undefined, { customerId, documentTypeId, documentId });
      return {
        success: true,
        data: { documentId },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      op.end(false, errorMessage);
      return {
        success: false,
        error: {
          code: 'UPLOAD_FAILED',
          message: errorMessage,
        },
      };
    }
  }

  // ============================================
  // Legacy compatibility methods
  // ============================================

  /**
   * Find customer by EIN (legacy interface)
   * NOTE: Disabled until federal_id field is verified in GET /customers/new
   */
  async findCustomerByEIN(_ein: string): Promise<McLeodCustomer | null> {
    // EIN matching disabled until field is verified
    // TODO: Re-enable once federal_id field name is confirmed via GET /customers/new
    logger.warn('find_customer_by_ein_disabled', 'EIN matching disabled - field not yet verified');
    return null;
  }

  /**
   * Find customer by name and address (legacy interface)
   * Uses state_id instead of state per verified live response
   */
  async findCustomerByNameAddress(
    name: string,
    city: string,
    state: string
  ): Promise<McLeodCustomer | null> {
    try {
      const result = await this.searchCustomers({
        'customer.name': name,
        'customer.city': city,
        'customer.state_id': state,  // NOTE: McLeod uses state_id, not state
      });

      if (result.customers.length === 0) {
        return null;
      }

      // Try to find exact name match
      const normalizedName = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const exactMatch = result.customers.find((c) => {
        const customerName = (c.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        return customerName === normalizedName;
      });

      if (exactMatch) {
        return this.rowToLegacyCustomer(exactMatch);
      }

      return null;
    } catch (error) {
      logger.warn('find_customer_by_name_failed', error instanceof Error ? error.message : 'Unknown');
      return null;
    }
  }

  /**
   * Get customer by ID (legacy interface)
   */
  async getCustomer(customerId: string): Promise<McLeodCustomer | null> {
    const row = await this.getCustomerById(customerId);
    return row ? this.rowToLegacyCustomer(row) : null;
  }

  /**
   * Check if customer ID exists
   */
  async customerIdExists(customerId: string): Promise<boolean> {
    const customer = await this.getCustomerById(customerId);
    return customer !== null;
  }

  /**
   * Generate unique customer ID with collision handling
   */
  async generateUniqueCustomerId(baseId: string): Promise<string> {
    // Check if base ID exists
    if (!(await this.customerIdExists(baseId))) {
      return baseId;
    }

    // Try letter suffixes
    const letterSuffixes = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (const suffix of letterSuffixes) {
      const candidateId = `${baseId}${suffix}`;
      if (!(await this.customerIdExists(candidateId))) {
        return candidateId;
      }
    }

    // Try numeric suffixes
    for (let i = 1; i <= 99; i++) {
      const candidateId = `${baseId}${i.toString().padStart(2, '0')}`;
      if (!(await this.customerIdExists(candidateId))) {
        return candidateId;
      }
    }

    throw new Error(`Cannot generate unique customer ID from base: ${baseId}`);
  }

  /**
   * Legacy document upload (deprecated - use uploadCustomerAgreementPdf)
   */
  async uploadDocument(document: McLeodDocument): Promise<McLeodApiResponse<{ documentId: string }>> {
    // This legacy method expects base64 content
    // Convert to buffer and call new method
    const config = getConfig();
    const documentTypeId = config.mcleod.agreementDocumentTypeId;

    if (!document.content) {
      return {
        success: false,
        error: {
          code: 'NO_CONTENT',
          message: 'Document content is required',
        },
      };
    }

    const pdfBuffer = Buffer.from(document.content, 'base64');
    return this.uploadCustomerAgreementPdf(document.entity_id, documentTypeId, pdfBuffer);
  }

  /**
   * Append note to customer (legacy - now uses comments)
   */
  async appendNote(customerId: string, note: string): Promise<McLeodApiResponse<void>> {
    const comment: RowComment = {
      row_type: 'C',
      parent_row_id: customerId,
      comment: note,
      entered_user_id: 'JOTFORM_API',
    };

    const result = await this.createComment(comment);
    return {
      success: result.success,
      error: result.error,
    };
  }

  /**
   * Convert RowCustomer to legacy McLeodCustomer format
   */
  private rowToLegacyCustomer(row: RowCustomer): McLeodCustomer {
    return {
      id: row.id || '',
      name: row.name,
      dba_name: row.name2,
      address1: row.address1,
      address2: row.address2,
      city: row.city,
      state_id: row.state_id,  // NOTE: McLeod uses state_id, not state
      zip_code: row.zip_code,
      phone: row.phone1,
      phone2: row.phone2,
      fax: row.fax,
      email: row.email,
      federal_id: row.federal_id,
      mc_number: row.ic_number,
      status: row.status || 'A',
      credit_limit: row.credit_limit || 0,
      credit_status: row.credit_status,
      payment_terms: row.terms,
      salesperson_id: row.salesperson_id,
      contact_name: row.contact_name,
      created_by: row.entered_user_id,
      created_date: row.entered_date,
    };
  }
}

/**
 * Singleton McLeod client instance
 */
let clientInstance: McLeodClient | null = null;

export function getMcLeodClient(): McLeodClient {
  if (!clientInstance) {
    clientInstance = new McLeodClient();
  }
  return clientInstance;
}

/**
 * Reset client (for testing)
 */
export function resetMcLeodClient(): void {
  clientInstance = null;
}
