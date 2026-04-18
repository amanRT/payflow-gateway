import crypto from 'crypto';

export function createWebhookSignature(secret: string, payload: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return `sha256=${hmac.digest('hex')}`;
}

export function verifyWebhookSignature(secret: string, payload: string, signature: string): boolean {
  const expected = createWebhookSignature(secret, payload);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
