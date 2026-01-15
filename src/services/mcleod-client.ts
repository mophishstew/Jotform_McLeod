/**
 * McLeod TMS API Client
 *
 * This client handles all communication with McLeod TMS Web Services.
 * Currently implemented with placeholder functions - update with actual
 * SOAP calls after WSDL verification.
 *
 * TODO: After obtaining McLeod WSDL:
 * 1. Update SOAP envelope structure
 * 2. Verify exact field names
 * 3. Implement actual SOAP calls using 'soap' library
 * 4. Add proper WS-Security if required
 */

import { getConfig } from '../config/index.js';
import { logger, withRetry } from '../utils/index.js';
import type {
  McLeodCustomer,
  McLeodSearchCriteria,
  McLeodSearchResult,
  McLeodDocument,
  McLeodApiResponse,
} from '../types/index.js';

/**
 * McLeod API Client class
 */
export class McLeodClient {
  private readonly apiUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeout: number;

  constructor() {
    const config = getConfig();
    this.apiUrl = config.mcleod.apiUrl;
    this.username = config.mcleod.username;
    this.password = config.mcleod.password;
    this.timeout = config.mcleod.timeout;
  }

  /**
   * Search for existing customer by criteria
   *
   * TODO: Implement actual SOAP call to CustomerService.SearchCustomers
   *
   * Expected SOAP operation: SearchCustomers or FindCustomer
   * Required fields: criteria object with search parameters
   * Returns: Array of matching customers
   */
  async searchCustomers(criteria: McLeodSearchCriteria): Promise<McLeodSearchResult> {
    const op = logger.startOperation('mcleod_search_customers');

    try {
      // TODO: Replace with actual SOAP implementation
      // Example SOAP envelope structure:
      /*
      const envelope = `
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Header>
            <wsse:Security xmlns:wsse="...">
              <wsse:UsernameToken>
                <wsse:Username>${this.username}</wsse:Username>
                <wsse:Password>${this.password}</wsse:Password>
              </wsse:UsernameToken>
            </wsse:Security>
          </soap:Header>
          <soap:Body>
            <SearchCustomers xmlns="http://mcleod.com/webservices/customer">
              <criteria>
                ${criteria.federal_id ? `<federal_id>${criteria.federal_id}</federal_id>` : ''}
                ${criteria.name ? `<name>${criteria.name}</name>` : ''}
                ${criteria.city ? `<city>${criteria.city}</city>` : ''}
                ${criteria.state ? `<state>${criteria.state}</state>` : ''}
              </criteria>
              <max_results>10</max_results>
            </SearchCustomers>
          </soap:Body>
        </soap:Envelope>
      `;

      const response = await fetch(`${this.apiUrl}/CustomerService`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': 'SearchCustomers',
        },
        body: envelope,
        signal: AbortSignal.timeout(this.timeout),
      });

      // Parse SOAP response and extract customers
      */

      // Placeholder implementation - returns empty result
      logger.warn('mcleod_search_not_implemented', 'Search not implemented - returning empty result');

      op.end(true, undefined, { criteria, resultCount: 0 });

      return {
        customers: [],
        totalCount: 0,
        hasMore: false,
      };
    } catch (error) {
      op.end(false, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * Find customer by EIN/Tax ID
   *
   * Convenience method that searches by federal_id
   */
  async findCustomerByEIN(ein: string): Promise<McLeodCustomer | null> {
    const result = await this.searchCustomers({ federal_id: ein });

    if (result.customers.length === 0) {
      return null;
    }

    if (result.customers.length > 1) {
      logger.warn('multiple_customers_for_ein', `Found ${result.customers.length} customers for EIN ${ein}`);
    }

    // Return first active customer, or first customer if none active
    return result.customers.find(c => c.status === 'ACTIVE') || result.customers[0];
  }

  /**
   * Find customer by name and address
   *
   * Fallback search when EIN doesn't match
   */
  async findCustomerByNameAddress(
    name: string,
    city: string,
    state: string
  ): Promise<McLeodCustomer | null> {
    const result = await this.searchCustomers({ name, city, state });

    if (result.customers.length === 0) {
      return null;
    }

    // Try to find exact name match
    const normalizedName = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const exactMatch = result.customers.find(c => {
      const customerName = c.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
      return customerName === normalizedName;
    });

    return exactMatch || null;
  }

  /**
   * Get customer by ID
   *
   * TODO: Implement actual SOAP call to CustomerService.GetCustomer
   */
  async getCustomer(customerId: string): Promise<McLeodCustomer | null> {
    const op = logger.startOperation('mcleod_get_customer');

    try {
      // TODO: Replace with actual SOAP implementation
      /*
      const envelope = `
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Header>...</soap:Header>
          <soap:Body>
            <GetCustomer xmlns="http://mcleod.com/webservices/customer">
              <id>${customerId}</id>
            </GetCustomer>
          </soap:Body>
        </soap:Envelope>
      `;
      */

      logger.warn('mcleod_get_not_implemented', 'GetCustomer not implemented');
      op.end(true, undefined, { customerId });
      return null;
    } catch (error) {
      op.end(false, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * Create new customer in McLeod
   *
   * TODO: Implement actual SOAP call to CustomerService.CreateCustomer
   *
   * Expected SOAP operation: CreateCustomer or AddCustomer
   * Required fields: id, name, address1, city, state, zip_code, status
   * Returns: Created customer ID and success status
   */
  async createCustomer(customer: McLeodCustomer): Promise<McLeodApiResponse<{ customerId: string }>> {
    const op = logger.startOperation('mcleod_create_customer');

    try {
      // TODO: Replace with actual SOAP implementation
      /*
      const envelope = `
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Header>
            <wsse:Security xmlns:wsse="...">
              <wsse:UsernameToken>
                <wsse:Username>${this.username}</wsse:Username>
                <wsse:Password>${this.password}</wsse:Password>
              </wsse:UsernameToken>
            </wsse:Security>
          </soap:Header>
          <soap:Body>
            <CreateCustomer xmlns="http://mcleod.com/webservices/customer">
              <customer>
                <id>${customer.id}</id>
                <name>${customer.name}</name>
                <dba_name>${customer.dba_name || ''}</dba_name>
                <address1>${customer.address1}</address1>
                <address2>${customer.address2 || ''}</address2>
                <city>${customer.city}</city>
                <state>${customer.state}</state>
                <zip_code>${customer.zip_code}</zip_code>
                <phone>${customer.phone || ''}</phone>
                <email>${customer.email || ''}</email>
                <federal_id>${customer.federal_id || ''}</federal_id>
                <status>${customer.status}</status>
                <category>${customer.category || 'SHIPPER'}</category>
                <credit_limit>${customer.credit_limit}</credit_limit>
                <credit_status>${customer.credit_status || 'HOLD'}</credit_status>
                <salesperson_id>${customer.salesperson_id || ''}</salesperson_id>
                <payment_terms>${customer.payment_terms || ''}</payment_terms>
                <notes><![CDATA[${customer.notes || ''}]]></notes>
              </customer>
            </CreateCustomer>
          </soap:Body>
        </soap:Envelope>
      `;

      const response = await fetch(`${this.apiUrl}/CustomerService`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': 'CreateCustomer',
        },
        body: envelope,
        signal: AbortSignal.timeout(this.timeout),
      });

      // Parse response
      */

      // Placeholder - simulate success
      logger.warn('mcleod_create_not_implemented', 'CreateCustomer not implemented - simulating success');

      op.end(true, undefined, { customerId: customer.id });

      return {
        success: true,
        data: { customerId: customer.id },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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
   * Update existing customer in McLeod
   *
   * TODO: Implement actual SOAP call to CustomerService.UpdateCustomer
   *
   * Expected SOAP operation: UpdateCustomer or ModifyCustomer
   * Required fields: id (existing), plus fields to update
   * Returns: Success status
   */
  async updateCustomer(
    customerId: string,
    updates: Partial<McLeodCustomer>
  ): Promise<McLeodApiResponse<void>> {
    const op = logger.startOperation('mcleod_update_customer');

    try {
      // TODO: Replace with actual SOAP implementation
      /*
      const updateFields = Object.entries(updates)
        .filter(([_, value]) => value !== undefined)
        .map(([key, value]) => `<${key}>${escapeXml(String(value))}</${key}>`)
        .join('\n');

      const envelope = `
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Header>...</soap:Header>
          <soap:Body>
            <UpdateCustomer xmlns="http://mcleod.com/webservices/customer">
              <id>${customerId}</id>
              <updates>
                ${updateFields}
              </updates>
            </UpdateCustomer>
          </soap:Body>
        </soap:Envelope>
      `;
      */

      logger.warn('mcleod_update_not_implemented', 'UpdateCustomer not implemented - simulating success');

      op.end(true, undefined, { customerId, updateFields: Object.keys(updates) });

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

  /**
   * Append note to customer record
   *
   * TODO: Implement based on McLeod note handling
   * Some McLeod systems append to notes field, others have separate note table
   */
  async appendNote(customerId: string, note: string): Promise<McLeodApiResponse<void>> {
    const op = logger.startOperation('mcleod_append_note');

    try {
      // Get existing customer to get current notes
      const existing = await this.getCustomer(customerId);
      const existingNotes = existing?.notes || '';

      // Append new note with timestamp
      const timestamp = new Date().toISOString();
      const newNotes = existingNotes
        ? `${existingNotes}\n\n--- ${timestamp} ---\n${note}`
        : `--- ${timestamp} ---\n${note}`;

      return await this.updateCustomer(customerId, { notes: newNotes });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      op.end(false, errorMessage);

      return {
        success: false,
        error: {
          code: 'APPEND_NOTE_FAILED',
          message: errorMessage,
        },
      };
    }
  }

  /**
   * Upload document to McLeod
   *
   * TODO: Implement actual SOAP call to DocumentService
   *
   * Expected SOAP operation: UploadDocument or AttachDocument
   * Required fields: entity_type, entity_id, content (base64), filename
   * Returns: Document ID
   *
   * If McLeod doesn't support document upload, this should throw
   * and caller will fall back to external storage
   */
  async uploadDocument(document: McLeodDocument): Promise<McLeodApiResponse<{ documentId: string }>> {
    const op = logger.startOperation('mcleod_upload_document');

    try {
      // TODO: Replace with actual SOAP implementation
      /*
      const envelope = `
        <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Header>...</soap:Header>
          <soap:Body>
            <UploadDocument xmlns="http://mcleod.com/webservices/document">
              <document>
                <entity_type>${document.entity_type}</entity_type>
                <entity_id>${document.entity_id}</entity_id>
                <document_type>${document.document_type}</document_type>
                <filename>${document.filename}</filename>
                <content_type>${document.content_type}</content_type>
                <content>${document.content}</content>
                <description>${document.description || ''}</description>
              </document>
            </UploadDocument>
          </soap:Body>
        </soap:Envelope>
      `;
      */

      // Placeholder - throw to indicate not implemented
      // This will trigger fallback to external storage
      throw new Error('McLeod document upload not implemented - use fallback storage');
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

  /**
   * Check if customer ID already exists
   */
  async customerIdExists(customerId: string): Promise<boolean> {
    const customer = await this.getCustomer(customerId);
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
