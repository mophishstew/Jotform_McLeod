/**
 * Jotform McLeod Integration Service
 *
 * Azure Functions entry point
 *
 * This service receives Jotform webhook submissions and creates/updates
 * customer records in McLeod TMS with:
 * - Zero credit limit (pending approval)
 * - Salesperson assignment
 * - Contact information
 * - Agreement document storage
 */

// Import handlers to register Azure Functions
import './handlers/webhook.js';

// Export types for consumers
export * from './types/index.js';
export * from './services/index.js';
export * from './utils/index.js';
export * from './config/index.js';
