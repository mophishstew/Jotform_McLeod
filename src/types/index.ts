/**
 * Type exports
 */

export * from './jotform.js';
export * from './mcleod.js';

/**
 * Idempotency record for tracking processed submissions
 */
export interface IdempotencyRecord {
  submissionId: string;
  mcleodCustomerId: string | null;
  status: 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  errorMessage?: string;
  attempts: number;
}

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
