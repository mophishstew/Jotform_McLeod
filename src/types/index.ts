/**
 * Type exports
 */

export * from './jotform.js';
export * from './mcleod.js';

// NOTE: IdempotencyRecord is defined in utils/idempotency.ts and exported from there

/**
 * Processing result
 */
export interface ProcessingResult {
  success: boolean;
  customerId?: string;
  created: boolean;          // true if new customer, false if updated
  documentUploaded: boolean;
  documentLocation?: string;
  error?: string;
}

/**
 * Alert levels for notifications
 */
export type AlertLevel = 'info' | 'warning' | 'error';

/**
 * Alert payload
 */
export interface AlertPayload {
  level: AlertLevel;
  service: string;
  timestamp: Date;
  submissionId?: string;
  companyName?: string;
  mcleodCustomerId?: string;
  message: string;
  error?: string;
  actionRequired?: string;
}

/**
 * Log entry structure
 */
export interface LogEntry {
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;
  traceId: string;
  submissionId?: string;
  operation: string;
  durationMs?: number;
  success: boolean;
  mcleodCustomerId?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}
