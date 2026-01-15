/**
 * Idempotency store for tracking processed submissions
 * MVP: In-memory store with TTL
 * Production: Replace with Redis or database
 */

import type { IdempotencyRecord } from '../types/index.js';
import { logger } from './logger.js';

/**
 * In-memory idempotency store
 * TODO: Replace with Redis or database for production
 */
class IdempotencyStore {
  private store: Map<string, IdempotencyRecord>;
  private readonly ttlMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(ttlMs: number = 60 * 60 * 1000) {
    this.store = new Map();
    this.ttlMs = ttlMs;
    this.startCleanup();
  }

  /**
   * Start periodic cleanup of expired entries
   */
  private startCleanup(): void {
    // Clean up every 10 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 10 * 60 * 1000);
  }

  /**
   * Stop cleanup interval
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Remove expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, record] of this.store) {
      if (now - record.createdAt.getTime() > this.ttlMs) {
        this.store.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug('idempotency_cleanup', { removedEntries: removed });
    }
  }

  /**
   * Get a record by submission ID
   */
  get(submissionId: string): IdempotencyRecord | undefined {
    return this.store.get(submissionId);
  }

  /**
   * Check if a submission has been processed
   */
  has(submissionId: string): boolean {
    return this.store.has(submissionId);
  }

  /**
   * Start processing a submission
   * Returns false if already being processed
   */
  startProcessing(submissionId: string): boolean {
    const existing = this.store.get(submissionId);

    if (existing) {
      // Check if it's a stale "processing" record (> 5 minutes)
      const staleThreshold = 5 * 60 * 1000;
      const isStale =
        existing.status === 'processing' &&
        Date.now() - existing.createdAt.getTime() > staleThreshold;

      if (existing.status === 'completed') {
        logger.info('idempotency_duplicate', {
          submissionId,
          previousCustomerId: existing.mcleodCustomerId,
        });
        return false;
      }

      if (existing.status === 'processing' && !isStale) {
        logger.warn('idempotency_concurrent', submissionId);
        return false;
      }

      // Stale processing record - allow retry
      logger.info('idempotency_retry_stale', { submissionId });
    }

    this.store.set(submissionId, {
      submissionId,
      mcleodCustomerId: null,
      status: 'processing',
      createdAt: new Date(),
      attempts: (existing?.attempts || 0) + 1,
    });

    return true;
  }

  /**
   * Mark processing as completed
   */
  markCompleted(submissionId: string, mcleodCustomerId: string): void {
    const existing = this.store.get(submissionId);

    this.store.set(submissionId, {
      submissionId,
      mcleodCustomerId,
      status: 'completed',
      createdAt: existing?.createdAt || new Date(),
      completedAt: new Date(),
      attempts: existing?.attempts || 1,
    });

    logger.info('idempotency_completed', { submissionId, mcleodCustomerId });
  }

  /**
   * Mark processing as failed
   */
  markFailed(submissionId: string, errorMessage: string, mcleodCustomerId?: string): void {
    const existing = this.store.get(submissionId);

    this.store.set(submissionId, {
      submissionId,
      mcleodCustomerId: mcleodCustomerId || existing?.mcleodCustomerId || null,
      status: 'failed',
      createdAt: existing?.createdAt || new Date(),
      errorMessage,
      attempts: existing?.attempts || 1,
    });

    logger.warn('idempotency_failed', errorMessage, { submissionId });
  }

  /**
   * Get the McLeod customer ID for a completed submission
   */
  getCustomerId(submissionId: string): string | null {
    const record = this.store.get(submissionId);
    return record?.mcleodCustomerId || null;
  }

  /**
   * Get all records (for debugging)
   */
  getAll(): IdempotencyRecord[] {
    return Array.from(this.store.values());
  }

  /**
   * Get store size
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Clear all entries (for testing)
   */
  clear(): void {
    this.store.clear();
  }
}

/**
 * Singleton instance
 */
export const idempotencyStore = new IdempotencyStore();

/**
 * Check idempotency and get existing result if available
 */
export interface IdempotencyCheck {
  canProcess: boolean;
  existingCustomerId?: string;
  status?: 'processing' | 'completed' | 'failed';
}

export function checkIdempotency(submissionId: string): IdempotencyCheck {
  const record = idempotencyStore.get(submissionId);

  if (!record) {
    return { canProcess: true };
  }

  if (record.status === 'completed' && record.mcleodCustomerId) {
    return {
      canProcess: false,
      existingCustomerId: record.mcleodCustomerId,
      status: 'completed',
    };
  }

  if (record.status === 'processing') {
    // Check for stale processing
    const staleThreshold = 5 * 60 * 1000;
    if (Date.now() - record.createdAt.getTime() > staleThreshold) {
      return { canProcess: true, status: 'processing' };
    }
    return { canProcess: false, status: 'processing' };
  }

  // Failed - allow retry
  return { canProcess: true, status: 'failed' };
}
