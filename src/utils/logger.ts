/**
 * Structured logging utility
 */

import { v4 as uuidv4 } from 'uuid';
import type { LogEntry } from '../types/index.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Logger class with structured JSON output
 */
export class Logger {
  private service: string;
  private traceId: string;
  private minLevel: LogLevel;
  private submissionId?: string;

  constructor(service: string, minLevel: LogLevel = 'info') {
    this.service = service;
    this.traceId = uuidv4();
    this.minLevel = minLevel;
  }

  /**
   * Create a child logger with a specific submission ID
   */
  withSubmission(submissionId: string): Logger {
    const child = new Logger(this.service, this.minLevel);
    child.traceId = this.traceId;
    child.submissionId = submissionId;
    return child;
  }

  /**
   * Set the trace ID for correlation
   */
  setTraceId(traceId: string): void {
    this.traceId = traceId;
  }

  /**
   * Get current trace ID
   */
  getTraceId(): string {
    return this.traceId;
  }

  /**
   * Log a debug message
   */
  debug(operation: string, metadata?: Record<string, unknown>): void {
    this.log('debug', operation, true, undefined, metadata);
  }

  /**
   * Log an info message
   */
  info(operation: string, metadata?: Record<string, unknown>): void {
    this.log('info', operation, true, undefined, metadata);
  }

  /**
   * Log a warning message
   */
  warn(operation: string, error?: string, metadata?: Record<string, unknown>): void {
    this.log('warn', operation, true, error, metadata);
  }

  /**
   * Log an error message
   */
  error(operation: string, error: string, metadata?: Record<string, unknown>): void {
    this.log('error', operation, false, error, metadata);
  }

  /**
   * Log operation start (for timing)
   */
  startOperation(operation: string): { end: (success: boolean, error?: string, metadata?: Record<string, unknown>) => void } {
    const startTime = Date.now();

    return {
      end: (success: boolean, error?: string, metadata?: Record<string, unknown>) => {
        const durationMs = Date.now() - startTime;
        this.log(success ? 'info' : 'error', operation, success, error, {
          ...metadata,
          durationMs,
        });
      },
    };
  }

  /**
   * Core logging method
   */
  private log(
    level: LogLevel,
    operation: string,
    success: boolean,
    error?: string,
    metadata?: Record<string, unknown>
  ): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      service: this.service,
      traceId: this.traceId,
      submissionId: this.submissionId,
      operation,
      success,
      error,
      metadata,
    };

    // Extract mcleodCustomerId from metadata if present
    if (metadata?.mcleodCustomerId) {
      entry.mcleodCustomerId = metadata.mcleodCustomerId as string;
    }

    // Extract durationMs from metadata if present
    if (metadata?.durationMs) {
      entry.durationMs = metadata.durationMs as number;
    }

    // Output as JSON for structured logging
    const output = JSON.stringify(entry);

    switch (level) {
      case 'debug':
        console.debug(output);
        break;
      case 'info':
        console.info(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'error':
        console.error(output);
        break;
    }
  }
}

/**
 * Default logger instance
 */
export const logger = new Logger('jotform-mcleod-integration');
