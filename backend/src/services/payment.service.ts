import { query, queryOne, pool } from '../config/database';
import { generatePaymentId, generateRefundId } from '../utils/generateId';
import { queueWebhookDelivery } from './webhook.service';
import { assessFraudRisk } from './ai.service';
import { redis } from '../config/redis';

function bustAnalyticsCache(merchantId: string) {
  redis.del(`analytics:${merchantId}:summary`).catch(() => {});
  redis.del(`analytics:${merchantId}:daily`).catch(() => {});
}

export interface Payment {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: string;
  idempotency_key: string;
  description: string | null;
  metadata: Record<string, any>;
  failure_reason: string | null;
  captured_at: string | null;
  created_at: string;
  updated_at: string;
  risk_score: number;
  risk_reason: string | null;
  risk_action: string;
}

export interface CreatePaymentInput {
  merchantId: string;
  amount: number;
  currency?: string;
  description?: string;
  metadata?: Record<string, any>;
  idempotencyKey: string;
}

export interface ListPaymentsFilter {
  status?: string;
  risk_action?: string;
  from?: string;
  to?: string;
  min_amount?: number;
  max_amount?: number;
  page?: number;
  limit?: number;
}

export async function createPayment(input: CreatePaymentInput): Promise<Payment> {
  const id = generatePaymentId();
  const { merchantId, amount, currency = 'INR', description, metadata = {}, idempotencyKey } = input;

  const recentPayments = await query<{ amount: number; status: string; created_at: string }>(
    `SELECT amount, status, created_at FROM payments
     WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [merchantId]
  );

  const risk = await assessFraudRisk(merchantId, { amount, currency, description, metadata }, recentPayments);

  const status = risk.action === 'block' ? 'blocked' : 'created';

  const payment = await queryOne<Payment>(
    `INSERT INTO payments (id, merchant_id, amount, currency, status, idempotency_key, description, metadata, risk_score, risk_reason, risk_action, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [id, merchantId, amount, currency, status, idempotencyKey, description ?? null, JSON.stringify(metadata),
     risk.risk_score, risk.reason, risk.action,
     risk.action === 'block' ? risk.reason : null]
  );

  bustAnalyticsCache(merchantId);

  if (risk.action === 'block') {
    queueWebhookDelivery(id, merchantId, 'payment.blocked', payment!).catch(() => {});
    throw Object.assign(
      new Error(risk.reason),
      { statusCode: 422, code: 'PAYMENT_BLOCKED', payment: payment! }
    );
  }

  queueWebhookDelivery(id, merchantId, 'payment.created', payment!).catch(() => {});

  return payment!;
}

export async function getPayment(paymentId: string, merchantId: string): Promise<Payment | null> {
  return queryOne<Payment>(
    'SELECT * FROM payments WHERE id = $1 AND merchant_id = $2',
    [paymentId, merchantId]
  );
}

export async function capturePayment(paymentId: string, merchantId: string): Promise<Payment> {
  const payment = await queryOne<Payment>(
    'SELECT * FROM payments WHERE id = $1 AND merchant_id = $2',
    [paymentId, merchantId]
  );

  if (!payment) throw Object.assign(new Error('Payment not found'), { statusCode: 404, code: 'PAYMENT_NOT_FOUND' });
  if (payment.status !== 'authorized' && payment.status !== 'created') {
    throw Object.assign(new Error(`Cannot capture payment with status: ${payment.status}`), { statusCode: 400, code: 'INVALID_STATUS' });
  }

  const updated = await queryOne<Payment>(
    `UPDATE payments SET status = 'captured', captured_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [paymentId]
  );

  bustAnalyticsCache(merchantId);
  queueWebhookDelivery(paymentId, merchantId, 'payment.captured', updated!).catch(() => {});

  return updated!;
}

export async function refundPayment(
  paymentId: string,
  merchantId: string,
  amount: number,
  reason?: string
): Promise<{ payment: Payment; refund: any }> {
  const payment = await queryOne<Payment>(
    'SELECT * FROM payments WHERE id = $1 AND merchant_id = $2',
    [paymentId, merchantId]
  );

  if (!payment) throw Object.assign(new Error('Payment not found'), { statusCode: 404, code: 'PAYMENT_NOT_FOUND' });
  if (payment.status !== 'captured') {
    throw Object.assign(new Error('Only captured payments can be refunded'), { statusCode: 400, code: 'INVALID_STATUS' });
  }

  const existingRefunds = await query<{ amount: number }>(
    'SELECT amount FROM refunds WHERE payment_id = $1 AND status != $2',
    [paymentId, 'failed']
  );
  const refundedTotal = existingRefunds.reduce((sum, r) => sum + r.amount, 0);
  if (refundedTotal + amount > payment.amount) {
    throw Object.assign(new Error('Refund amount exceeds payment amount'), { statusCode: 400, code: 'REFUND_EXCEEDS_AMOUNT' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const refundId = generateRefundId();
    const refund = await client.query(
      `INSERT INTO refunds (id, payment_id, merchant_id, amount, status, reason)
       VALUES ($1, $2, $3, $4, 'processed', $5) RETURNING *`,
      [refundId, paymentId, merchantId, amount, reason ?? null]
    );

    const isFullRefund = refundedTotal + amount >= payment.amount;
    const updatedPayment = await client.query(
      `UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [isFullRefund ? 'refunded' : 'captured', paymentId]
    );

    await client.query('COMMIT');

    bustAnalyticsCache(merchantId);
    queueWebhookDelivery(paymentId, merchantId, 'payment.refunded', updatedPayment.rows[0]).catch(() => {});

    return { payment: updatedPayment.rows[0], refund: refund.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listPayments(
  merchantId: string,
  filters: ListPaymentsFilter
): Promise<{ payments: Payment[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 20));
  const offset = (page - 1) * limit;

  const conditions: string[] = ['merchant_id = $1'];
  const params: any[] = [merchantId];
  let idx = 2;

  if (filters.status) {
    conditions.push(`status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters.risk_action) {
    conditions.push(`risk_action = $${idx++}`);
    params.push(filters.risk_action);
  }
  if (filters.from) {
    conditions.push(`created_at >= $${idx++}`);
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push(`created_at <= $${idx++}`);
    params.push(filters.to);
  }
  if (filters.min_amount) {
    conditions.push(`amount >= $${idx++}`);
    params.push(filters.min_amount);
  }
  if (filters.max_amount) {
    conditions.push(`amount <= $${idx++}`);
    params.push(filters.max_amount);
  }

  const where = conditions.join(' AND ');

  const [{ count }] = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM payments WHERE ${where}`,
    params
  );

  const payments = await query<Payment>(
    `SELECT * FROM payments WHERE ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset]
  );

  return { payments, total: parseInt(count), page, limit };
}
