/**
 * Configuration management
 * All secrets come from environment variables
 */

/**
 * McLeod authentication modes
 * - token: Use a pre-existing token from env (MCLEOD_TOKEN)
 * - basic: Use Basic Auth header for every request
 * - login: Login via POST /users/login to get a token, then use Bearer
 */
export type McLeodAuthMode = 'token' | 'basic' | 'login';

/**
 * Application configuration
 */
export interface Config {
  mcleod: {
    baseUrl: string;               // Base URL (e.g., https://tms-bkxg.mcleodhosted.com/ws/api)
    username: string;              // McLeod username (for basic/login auth)
    password: string;              // McLeod password (for basic/login auth)
    token: string;                 // Pre-existing token (for token auth mode)
    authMode: McLeodAuthMode;      // Authentication mode
    companyId: string;             // McLeod Anywhere Company ID (e.g., TMS)
    agreementDocumentTypeId: string; // Document type ID for agreement uploads
    timeout: number;               // Request timeout in ms
  };
  jotform: {
    apiKey: string;
    formId: string;
    webhookSecret: string;
  };
  slack: {
    webhookUrl: string;
    enabled: boolean;
  };
  azure: {
    // Azure Table Storage for idempotency
    tableConnectionString: string;
    idempotencyTableName: string;
    // Azure Blob Storage for document fallback
    blobConnectionString: string;
    blobContainerName: string;
    // Legacy storage connection (for backward compat)
    storageConnectionString: string;
    containerName: string;
  };
  features: {
    documentUpload: boolean;
    slackAlerts: boolean;
    webhookValidation: boolean;
    refetchSubmission: boolean;    // Re-fetch from Jotform API to validate
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
}

/**
 * Load and validate configuration from environment variables
 */
export function loadConfig(): Config {
  // Determine auth mode
  const authModeRaw = process.env.MCLEOD_AUTH_MODE || 'login';
  const authMode: McLeodAuthMode =
    authModeRaw === 'token' || authModeRaw === 'basic' || authModeRaw === 'login'
      ? authModeRaw
      : 'login';

  // Token auth mode requires MCLEOD_TOKEN
  // Basic/login auth modes require username and password
  const token = process.env.MCLEOD_TOKEN || '';
  const username = process.env.MCLEOD_USERNAME || '';
  const password = process.env.MCLEOD_PASSWORD || '';

  if (authMode === 'token' && !token) {
    throw new Error('MCLEOD_TOKEN is required when MCLEOD_AUTH_MODE=token');
  }

  if ((authMode === 'basic' || authMode === 'login') && (!username || !password)) {
    throw new Error('MCLEOD_USERNAME and MCLEOD_PASSWORD are required when MCLEOD_AUTH_MODE=basic or login');
  }

  const config: Config = {
    mcleod: {
      baseUrl: requireEnv('MCLEOD_BASE_URL'),
      username,
      password,
      token,
      authMode,
      companyId: process.env.MCLEOD_ANYWHERE_COMPANY_ID || 'TMS',
      agreementDocumentTypeId: process.env.MCLEOD_AGREEMENT_DOCUMENT_TYPE_ID || 'AGREEMENT',
      timeout: parseInt(process.env.MCLEOD_TIMEOUT || '30000', 10),
    },
    jotform: {
      apiKey: process.env.JOTFORM_API_KEY || '',
      formId: process.env.JOTFORM_FORM_ID || '',
      webhookSecret: process.env.JOTFORM_WEBHOOK_SECRET || '',
    },
    slack: {
      webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
      enabled: process.env.ENABLE_SLACK_ALERTS === 'true',
    },
    azure: {
      // Table Storage for idempotency
      tableConnectionString: process.env.AZURE_TABLE_CONNECTION_STRING || '',
      idempotencyTableName: process.env.AZURE_IDEMPOTENCY_TABLE_NAME || 'JotformIdempotency',
      // Blob Storage for document fallback
      blobConnectionString: process.env.AZURE_BLOB_CONNECTION_STRING || '',
      blobContainerName: process.env.AZURE_BLOB_CONTAINER_NAME || 'customer-agreements',
      // Legacy (backward compat)
      storageConnectionString:
        process.env.AZURE_STORAGE_CONNECTION_STRING ||
        process.env.AZURE_BLOB_CONNECTION_STRING ||
        '',
      containerName:
        process.env.AZURE_STORAGE_CONTAINER ||
        process.env.AZURE_BLOB_CONTAINER_NAME ||
        'customer-agreements',
    },
    features: {
      documentUpload: process.env.ENABLE_DOCUMENT_UPLOAD !== 'false',
      slackAlerts: process.env.ENABLE_SLACK_ALERTS === 'true',
      webhookValidation: process.env.ENABLE_WEBHOOK_VALIDATION !== 'false',
      refetchSubmission: process.env.ENABLE_REFETCH_SUBMISSION === 'true',
    },
    logging: {
      level: (process.env.LOG_LEVEL as Config['logging']['level']) || 'info',
    },
  };

  return config;
}

/**
 * Require an environment variable, throw if missing
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Singleton config instance
 */
let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

/**
 * Reset config (for testing)
 */
export function resetConfig(): void {
  configInstance = null;
}

/**
 * Salesperson mapping table
 * Maps Blackbox contact names to McLeod salesperson IDs
 *
 * Supports:
 * - Exact match (case-insensitive)
 * - Common variations and aliases
 * - Punctuation-normalized matching
 */
export const SALESPERSON_MAP: Record<string, string> = {
  // Format: "FirstName LastName" -> "SALESPERSON_ID"
  'Larry Dyer': 'LDYER',
  'John Smith': 'JSMITH',
  'Sarah Johnson': 'SJOHNSON',
  'Mike Wilson': 'MWILSON',
  'Jane Doe': 'JDOE',
  'Bob Anderson': 'BANDERSON',

  // Aliases and variations (add as needed)
  'Lawrence Dyer': 'LDYER',
  'Larry D': 'LDYER',

  // Default fallback for unknown salespeople
  '_DEFAULT': 'UNASSIGNED',
};

/**
 * Look up salesperson ID from name
 * Returns the McLeod salesperson ID or default if not found
 */
export function getSalespersonId(firstName: string, lastName: string): string {
  const fullName = `${firstName.trim()} ${lastName.trim()}`;

  // Try exact match first
  if (SALESPERSON_MAP[fullName]) {
    return SALESPERSON_MAP[fullName];
  }

  // Try case-insensitive match
  const normalizedFullName = fullName.toLowerCase();
  for (const [name, id] of Object.entries(SALESPERSON_MAP)) {
    if (name !== '_DEFAULT' && name.toLowerCase() === normalizedFullName) {
      return id;
    }
  }

  // Try matching with punctuation removed
  const cleanedFullName = fullName.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  for (const [name, id] of Object.entries(SALESPERSON_MAP)) {
    if (name !== '_DEFAULT') {
      const cleanedName = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      if (cleanedName === cleanedFullName) {
        return id;
      }
    }
  }

  // Try partial match (first name only)
  const firstNameLower = firstName.trim().toLowerCase();
  for (const [name, id] of Object.entries(SALESPERSON_MAP)) {
    if (name !== '_DEFAULT') {
      const nameFirstPart = name.toLowerCase().split(' ')[0];
      if (nameFirstPart === firstNameLower) {
        return id;
      }
    }
  }

  // Return default
  return SALESPERSON_MAP['_DEFAULT'];
}

/**
 * Check if a salesperson was found (not the default)
 */
export function isSalespersonFound(salespersonId: string): boolean {
  return salespersonId !== SALESPERSON_MAP['_DEFAULT'];
}
