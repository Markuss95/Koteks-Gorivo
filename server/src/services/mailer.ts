// Outbound mail via the Microsoft Graph API, using an Azure app registration
// (client-credentials flow) with the Mail.Send application permission.
//
// Setup, once, by a tenant admin:
//   1. Azure Portal → App registrations → New registration.
//   2. API permissions → Microsoft Graph → Application permissions → Mail.Send
//      → "Grant admin consent". (Application, NOT delegated — there is no user
//      signing in here.)
//   3. Certificates & secrets → New client secret.
//   4. Put the tenant id, client id and secret in the server's .env (see
//      .env.example). Never commit them.
//
// Worth knowing: Mail.Send granted this way lets the app send as ANY mailbox in
// the tenant. To restrict it to noreply@ only, an admin can add an
// ApplicationAccessPolicy in Exchange Online — recommended, and independent of
// this code.
import { config } from '../config.js';

const TOKEN_HOST = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

// Graph's plain sendMail caps the whole request at 4 MB; base64 inflates by ~4/3,
// so keep raw attachments comfortably under that.
export const MAX_ATTACHMENT_BYTES = 2.5 * 1024 * 1024;

export interface MailAttachment {
  filename: string;
  contentType: string;
  /** Base64-encoded file content (no data: prefix). */
  contentBase64: string;
}

export interface SendMailInput {
  to: string[];
  subject: string;
  /** Plain-text body; sent as HTML after minimal escaping. */
  text: string;
  attachments?: MailAttachment[];
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super(
      'E-pošta nije konfigurirana na poslužitelju (GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET / MAIL_FROM).',
    );
    this.name = 'MailNotConfiguredError';
  }
}

export function isMailConfigured(): boolean {
  const m = config.mail;
  return Boolean(m.tenantId && m.clientId && m.clientSecret && m.from);
}

// Cached app token. Graph tokens last ~1h; refresh a minute early to avoid
// racing the expiry.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const body = new URLSearchParams({
    client_id: config.mail.clientId,
    client_secret: config.mail.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(`${TOKEN_HOST}/${config.mail.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !json.access_token) {
    // error_description carries the actionable detail (bad secret, no consent…).
    throw new Error(
      `Graph token request failed (${res.status}): ${json.error_description ?? json.error ?? 'unknown error'}`,
    );
  }

  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
  };
  return cachedToken.value;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Send one message as the configured MAIL_FROM mailbox. */
export async function sendMail(input: SendMailInput): Promise<void> {
  if (!isMailConfigured()) throw new MailNotConfiguredError();

  const token = await getAccessToken();
  const message = {
    subject: input.subject,
    body: {
      contentType: 'HTML',
      content: `<p>${escapeHtml(input.text).replace(/\n/g, '<br>')}</p>`,
    },
    toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
    attachments: (input.attachments ?? []).map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: a.contentType,
      contentBytes: a.contentBase64,
    })),
  };

  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(config.mail.from)}/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, saveToSentItems: config.mail.saveToSentItems }),
  });

  if (res.status === 202) return; // Graph accepts sendMail with 202 No Content.

  const detail = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  throw new Error(
    `Graph sendMail failed (${res.status}): ${detail.error?.message ?? 'unknown error'}`,
  );
}
