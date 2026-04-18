import crypto from 'crypto';

const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomString(length: number): string {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes)
    .map((b) => CHARS[b % CHARS.length])
    .join('');
}

export function generatePaymentId(): string {
  return `pay_${randomString(16)}`;
}

export function generateRefundId(): string {
  return `rfnd_${randomString(16)}`;
}

export function generateApiKey(): string {
  return `pk_${randomString(40)}`;
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}
