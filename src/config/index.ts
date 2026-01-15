/**
 * Configuration management
 * All secrets come from environment variables
 */

/**
 * Application configuration
 */
export interface Config {
  mcleod: {
    apiUrl: string;
    username: string;
    password: string;
    timeout: number;
  };
  jotform: {
    apiKey: string;
    webhookSecret: string;
  };
  slack: {
    webhookUrl: string;
    enabled: boolean;
  };
  azure: {
    storageConnectionString: string;
    containerName: string;
  };
  features: {
    documentUpload: boolean;
    slackAlerts: boolean;
    webhookValidation: boolean;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
}

/**
 * Load and validate configuration from environment variables
 */
export function loadConfig(): Config {
  const config: Config = {
    mcleod: {
      apiUrl: requireEnv('MCLEOD_API_URL'),
      username: requireEnv('MCLEOD_USERNAME'),
      password: requireEnv('MCLEOD_PASSWORD'),
      timeout: parseInt(process.env.MCLEOD_TIMEOUT || '30000', 10),
    },
    jotform: {
      apiKey: requireEnv('JOTFORM_API_KEY'),
      webhookSecret: process.env.JOTFORM_WEBHOOK_SECRET || '',
    },
    slack: {
      webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
      enabled: process.env.ENABLE_SLACK_ALERTS === 'true',
    },
    azure: {
      storageConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || '',
      containerName: process.env.AZURE_STORAGE_CONTAINER || 'customer-agreements',
    },
    features: {
      documentUpload: process.env.ENABLE_DOCUMENT_UPLOAD !== 'false',
      slackAlerts: process.env.ENABLE_SLACK_ALERTS === 'true',
      webhookValidation: process.env.ENABLE_WEBHOOK_VALIDATION !== 'false',
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
 * Salesperson mapping table
 * Maps Blackbox contact names to McLeod salesperson IDs
 *
 * TODO: Update with actual sales team members
 */
export const SALESPERSON_MAP: Record<string, string> = {
  // Format: "FirstName LastName" -> "SALESPERSON_ID"
  'Larry Dyer': 'LDYER',
  'John Smith': 'JSMITH',
  'Sarah Johnson': 'SJOHNSON',
  'Mike Wilson': 'MWILSON',
  'Jane Doe': 'JDOE',
  'Bob Anderson': 'BANDERSON',

  // Default fallback for unknown salespeople
  '_DEFAULT': 'HOUSE',
};

/**
 * Look up salesperson ID from name
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
    if (name.toLowerCase() === normalizedFullName) {
      return id;
    }
  }

  // Return default
  console.warn(`Unknown salesperson: ${fullName}, using default`);
  return SALESPERSON_MAP['_DEFAULT'];
}
