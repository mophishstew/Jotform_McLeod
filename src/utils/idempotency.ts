/**
 * Persistent Idempotency Store using Azure Table Storage
 *
 * Ensures serverless-safe idempotency:
 * - Prevents duplicate processing of the same submission
 * - Persists across function invocations
 * - Supports concurrent access with optimistic concurrency
 *
 * Fallback: In-memory store when Azure Table Storage is not configured
 */

import crypto from 'crypto';
import { getConfig } from '../config/index.js';
import { logger } from './logger.js';

/**
 * Idempotency record structure
 */
export interface IdempotencyRecord {
  submissionId: string;
  mcleodCustomerId: string | null;
  status: 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  errorMessage?: string;
  attempts: number;
  // Hash for content-based deduplication
  contentHash?: string;
}

/**
 * Azure Table Storage entity structure
 */
interface TableEntity {
  partitionKey: string;
  rowKey: string;
  submissionId: string;
  mcleodCustomerId: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  errorMessage?: string;
  attempts: number;
  contentHash?: string;
  etag?: string;
}

/**
 * Interface for idempotency store backends
 */
interface IdempotencyStoreBackend {
  get(submissionId: string): Promise<IdempotencyRecord | undefined>;
  set(submissionId: string, record: IdempotencyRecord): Promise<boolean>;
  delete(submissionId: string): Promise<void>;
}

/**
 * Azure Table Storage backend
 */
class AzureTableBackend implements IdempotencyStoreBackend {
  private tableClient: any = null;
  private initialized = false;
  private readonly tableName: string;
  private readonly connectionString: string;

  constructor(connectionString: string, tableName: string) {
    this.connectionString = connectionString;
    this.tableName = tableName;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Dynamic import to avoid issues when Azure SDK is not installed
      const { TableClient, TableServiceClient } = await import('@azure/data-tables');

      // Create table if it doesn't exist
      const serviceClient = TableServiceClient.fromConnectionString(this.connectionString);
      try {
        await serviceClient.createTable(this.tableName);
        logger.info('idempotency_table_created', { tableName: this.tableName });
      } catch (err: any) {
        // Table already exists is fine
        if (err.statusCode !== 409) {
          throw err;
        }
      }

      this.tableClient = TableClient.fromConnectionString(
        this.connectionString,
        this.tableName
      );
      this.initialized = true;
      logger.info('azure_table_backend_initialized', { tableName: this.tableName });
    } catch (error) {
      logger.error(
        'azure_table_backend_init_failed',
        error instanceof Error ? error.message : 'Unknown error'
      );
      throw error;
    }
  }

  private toEntity(submissionId: string, record: IdempotencyRecord): TableEntity {
    // Use date prefix for partition key to enable range queries and avoid hot partitions
    const datePrefix = record.createdAt.toISOString().split('T')[0];
    return {
      partitionKey: datePrefix,
      rowKey: submissionId,
      submissionId: record.submissionId,
      mcleodCustomerId: record.mcleodCustomerId || '',
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      completedAt: record.completedAt?.toISOString(),
      errorMessage: record.errorMessage,
      attempts: record.attempts,
      contentHash: record.contentHash,
    };
  }

  private fromEntity(entity: TableEntity): IdempotencyRecord {
    return {
      submissionId: entity.submissionId,
      mcleodCustomerId: entity.mcleodCustomerId || null,
      status: entity.status as IdempotencyRecord['status'],
      createdAt: new Date(entity.createdAt),
      completedAt: entity.completedAt ? new Date(entity.completedAt) : undefined,
      errorMessage: entity.errorMessage,
      attempts: entity.attempts,
      contentHash: entity.contentHash,
    };
  }

  async get(submissionId: string): Promise<IdempotencyRecord | undefined> {
    await this.initialize();

    try {
      // Search across partitions (we don't know the date)
      // For production, consider a secondary index or known partition
      const queryResults = this.tableClient.listEntities({
        queryOptions: { filter: `rowKey eq '${submissionId}'` },
      });

      for await (const entity of queryResults) {
        return this.fromEntity(entity as TableEntity);
      }
      return undefined;
    } catch (error: any) {
      if (error.statusCode === 404) {
        return undefined;
      }
      logger.error('azure_table_get_failed', error.message);
      throw error;
    }
  }

  async set(submissionId: string, record: IdempotencyRecord): Promise<boolean> {
    await this.initialize();

    try {
      const entity = this.toEntity(submissionId, record);
      await this.tableClient.upsertEntity(entity, 'Replace');
      return true;
    } catch (error: any) {
      // Handle concurrent modification (optimistic concurrency)
      if (error.statusCode === 412) {
        logger.warn('azure_table_conflict', 'Concurrent modification detected');
        return false;
      }
      logger.error('azure_table_set_failed', error.message);
      throw error;
    }
  }

  async delete(submissionId: string): Promise<void> {
    await this.initialize();

    try {
      const existing = await this.get(submissionId);
      if (existing) {
        const datePrefix = existing.createdAt.toISOString().split('T')[0];
        await this.tableClient.deleteEntity(datePrefix, submissionId);
      }
    } catch (error: any) {
      if (error.statusCode !== 404) {
        logger.error('azure_table_delete_failed', error.message);
        throw error;
      }
    }
  }
}

/**
 * In-memory backend (fallback when Azure not configured)
 */
class InMemoryBackend implements IdempotencyStoreBackend {
  private store: Map<string, IdempotencyRecord> = new Map();
  private readonly ttlMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(ttlMs: number = 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.startCleanup();
    logger.warn('using_inmemory_idempotency', 'Azure Table Storage not configured, using in-memory store');
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
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
    }, 10 * 60 * 1000);
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  async get(submissionId: string): Promise<IdempotencyRecord | undefined> {
    return this.store.get(submissionId);
  }

  async set(submissionId: string, record: IdempotencyRecord): Promise<boolean> {
    this.store.set(submissionId, record);
    return true;
  }

  async delete(submissionId: string): Promise<void> {
    this.store.delete(submissionId);
  }

  getStore(): Map<string, IdempotencyRecord> {
    return this.store;
  }
}

/**
 * Unified Idempotency Store
 * Automatically selects backend based on configuration
 */
class IdempotencyStore {
  private backend: IdempotencyStoreBackend | null = null;

  private getBackend(): IdempotencyStoreBackend {
    if (this.backend) {
      return this.backend;
    }

    try {
      const config = getConfig();
      if (config.azure.tableConnectionString) {
        this.backend = new AzureTableBackend(
          config.azure.tableConnectionString,
          config.azure.idempotencyTableName
        );
      } else {
        this.backend = new InMemoryBackend();
      }
    } catch {
      // Config not available yet - use in-memory
      this.backend = new InMemoryBackend();
    }

    return this.backend;
  }

  /**
   * Get a record by submission ID
   */
  async get(submissionId: string): Promise<IdempotencyRecord | undefined> {
    return this.getBackend().get(submissionId);
  }

  /**
   * Check if a submission has been processed
   */
  async has(submissionId: string): Promise<boolean> {
    const record = await this.get(submissionId);
    return record !== undefined;
  }

  /**
   * Start processing a submission
   * Returns false if already being processed or completed
   */
  async startProcessing(submissionId: string, contentHash?: string): Promise<boolean> {
    const existing = await this.get(submissionId);

    if (existing) {
      // Check for stale "processing" record (> 5 minutes)
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

      // Stale processing or failed - allow retry
      logger.info('idempotency_retry', { submissionId, previousStatus: existing.status });
    }

    const record: IdempotencyRecord = {
      submissionId,
      mcleodCustomerId: null,
      status: 'processing',
      createdAt: new Date(),
      attempts: (existing?.attempts || 0) + 1,
      contentHash,
    };

    const success = await this.getBackend().set(submissionId, record);
    if (!success) {
      logger.warn('idempotency_lock_failed', 'Failed to acquire processing lock');
    }
    return success;
  }

  /**
   * Mark processing as completed
   */
  async markCompleted(submissionId: string, mcleodCustomerId: string): Promise<void> {
    const existing = await this.get(submissionId);

    const record: IdempotencyRecord = {
      submissionId,
      mcleodCustomerId,
      status: 'completed',
      createdAt: existing?.createdAt || new Date(),
      completedAt: new Date(),
      attempts: existing?.attempts || 1,
      contentHash: existing?.contentHash,
    };

    await this.getBackend().set(submissionId, record);
    logger.info('idempotency_completed', { submissionId, mcleodCustomerId });
  }

  /**
   * Mark processing as failed
   */
  async markFailed(
    submissionId: string,
    errorMessage: string,
    mcleodCustomerId?: string
  ): Promise<void> {
    const existing = await this.get(submissionId);

    const record: IdempotencyRecord = {
      submissionId,
      mcleodCustomerId: mcleodCustomerId || existing?.mcleodCustomerId || null,
      status: 'failed',
      createdAt: existing?.createdAt || new Date(),
      errorMessage,
      attempts: existing?.attempts || 1,
      contentHash: existing?.contentHash,
    };

    await this.getBackend().set(submissionId, record);
    logger.warn('idempotency_failed', errorMessage, { submissionId });
  }

  /**
   * Get the McLeod customer ID for a completed submission
   */
  async getCustomerId(submissionId: string): Promise<string | null> {
    const record = await this.get(submissionId);
    return record?.mcleodCustomerId || null;
  }

  /**
   * Get store size (in-memory only)
   */
  size(): number {
    const backend = this.getBackend();
    if (backend instanceof InMemoryBackend) {
      return backend.getStore().size;
    }
    return -1; // Unknown for Azure
  }

  /**
   * Clear all entries (testing only)
   */
  clear(): void {
    const backend = this.getBackend();
    if (backend instanceof InMemoryBackend) {
      backend.getStore().clear();
    }
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

export async function checkIdempotency(submissionId: string): Promise<IdempotencyCheck> {
  const record = await idempotencyStore.get(submissionId);

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

/**
 * Generate content hash for deduplication
 * Uses EIN + company name + address to detect duplicate submissions
 */
export function generateContentHash(
  ein: string,
  companyName: string,
  city: string,
  state: string
): string {
  const content = `${ein}|${companyName.toLowerCase().trim()}|${city.toLowerCase().trim()}|${state.toUpperCase().trim()}`;
  return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
}
