/**
 * Alert notifications (Slack)
 */

import { getConfig } from '../config/index.js';
import type { AlertLevel, AlertPayload } from '../types/index.js';
import { logger } from './logger.js';

/**
 * Slack message attachment format
 */
interface SlackAttachment {
  color: string;
  title: string;
  text: string;
  fields: Array<{
    title: string;
    value: string;
    short: boolean;
  }>;
  ts: number;
}

/**
 * Slack message payload
 */
interface SlackMessage {
  text: string;
  attachments: SlackAttachment[];
}

/**
 * Color mapping for alert levels
 */
const ALERT_COLORS: Record<AlertLevel, string> = {
  info: '#36a64f',    // Green
  warning: '#ff9800', // Orange
  error: '#dc3545',   // Red
};

/**
 * Emoji mapping for alert levels
 */
const ALERT_EMOJI: Record<AlertLevel, string> = {
  info: ':information_source:',
  warning: ':warning:',
  error: ':x:',
};

/**
 * Send an alert to Slack
 */
export async function sendSlackAlert(payload: AlertPayload): Promise<boolean> {
  const config = getConfig();

  if (!config.features.slackAlerts || !config.slack.webhookUrl) {
    logger.debug('slack_alert_skipped', {
      reason: 'Slack alerts disabled or webhook URL not configured',
    });
    return false;
  }

  const message = buildSlackMessage(payload);

  try {
    const response = await fetch(config.slack.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      logger.error('slack_alert_failed', `HTTP ${response.status}: ${response.statusText}`);
      return false;
    }

    logger.info('slack_alert_sent', {
      level: payload.level,
      submissionId: payload.submissionId,
    });
    return true;
  } catch (error) {
    logger.error('slack_alert_error', error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}

/**
 * Build Slack message payload
 */
function buildSlackMessage(payload: AlertPayload): SlackMessage {
  const emoji = ALERT_EMOJI[payload.level];
  const color = ALERT_COLORS[payload.level];

  const fields: SlackAttachment['fields'] = [];

  if (payload.submissionId) {
    fields.push({
      title: 'Submission ID',
      value: payload.submissionId,
      short: true,
    });
  }

  if (payload.companyName) {
    fields.push({
      title: 'Company',
      value: payload.companyName,
      short: true,
    });
  }

  if (payload.mcleodCustomerId) {
    fields.push({
      title: 'McLeod Customer ID',
      value: payload.mcleodCustomerId,
      short: true,
    });
  }

  if (payload.error) {
    fields.push({
      title: 'Error',
      value: `\`\`\`${payload.error}\`\`\``,
      short: false,
    });
  }

  if (payload.actionRequired) {
    fields.push({
      title: 'Action Required',
      value: payload.actionRequired,
      short: false,
    });
  }

  return {
    text: `${emoji} *${payload.service}*: ${payload.message}`,
    attachments: [
      {
        color,
        title: `${payload.level.toUpperCase()} Alert`,
        text: payload.message,
        fields,
        ts: Math.floor(payload.timestamp.getTime() / 1000),
      },
    ],
  };
}

/**
 * Send alert for processing failure
 */
export async function alertProcessingFailure(
  submissionId: string,
  companyName: string,
  error: string
): Promise<void> {
  await sendSlackAlert({
    level: 'error',
    service: 'jotform-mcleod-integration',
    timestamp: new Date(),
    submissionId,
    companyName,
    message: 'Customer onboarding failed',
    error,
    actionRequired: 'Manual review required. Check logs for details.',
  });
}

/**
 * Send alert for document upload failure (warning level)
 */
export async function alertDocumentUploadFailure(
  submissionId: string,
  customerId: string,
  companyName: string,
  error: string
): Promise<void> {
  await sendSlackAlert({
    level: 'warning',
    service: 'jotform-mcleod-integration',
    timestamp: new Date(),
    submissionId,
    companyName,
    mcleodCustomerId: customerId,
    message: 'Document upload failed (customer created successfully)',
    error,
    actionRequired: 'Manually upload agreement document to customer record.',
  });
}

/**
 * Send info alert for successful processing
 */
export async function alertProcessingSuccess(
  submissionId: string,
  customerId: string,
  companyName: string,
  created: boolean
): Promise<void> {
  // Only send success alerts in debug mode
  const config = getConfig();
  if (config.logging.level !== 'debug') {
    return;
  }

  await sendSlackAlert({
    level: 'info',
    service: 'jotform-mcleod-integration',
    timestamp: new Date(),
    submissionId,
    companyName,
    mcleodCustomerId: customerId,
    message: created
      ? 'New customer created successfully'
      : 'Existing customer updated successfully',
  });
}

/**
 * Send warning alert for salesperson not found
 */
export async function alertSalespersonNotFound(
  submissionId: string,
  companyName: string,
  salespersonName: string
): Promise<void> {
  await sendSlackAlert({
    level: 'warning',
    service: 'jotform-mcleod-integration',
    timestamp: new Date(),
    submissionId,
    companyName,
    message: `Salesperson "${salespersonName}" not found in mapping`,
    error: 'Using UNASSIGNED as default. Customer created but needs salesperson assignment.',
    actionRequired: 'Update SALESPERSON_MAP in config or manually assign salesperson in McLeod.',
  });
}
