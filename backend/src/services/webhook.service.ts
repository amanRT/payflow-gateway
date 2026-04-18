import { Queue } from 'bullmq';
import { redisForBullMQ } from '../config/redis';
import { queryOne, query } from '../config/database';

const webhookQueue = new Queue('webhook-delivery', {
  connection: redisForBullMQ,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 30000,
    },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export async function queueWebhookDelivery(
  paymentId: string,
  merchantId: string,
  eventType: string,
  paymentData: any
): Promise<void> {
  const merchant = await queryOne<{ webhook_url: string | null }>(
    'SELECT webhook_url FROM merchants WHERE id = $1',
    [merchantId]
  );

  if (!merchant?.webhook_url) return;

  const payload = {
    event: eventType,
    created_at: new Date().toISOString(),
    payload: paymentData,
  };

  const delivery = await queryOne<{ id: string }>(
    `INSERT INTO webhook_deliveries (payment_id, merchant_id, event_type, payload)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [paymentId, merchantId, eventType, JSON.stringify(payload)]
  );

  await webhookQueue.add(
    eventType,
    { deliveryId: delivery!.id, paymentId, merchantId, payload },
    { jobId: delivery!.id }
  );
}

export async function listWebhookDeliveries(
  merchantId: string,
  page = 1,
  limit = 20
): Promise<{ deliveries: any[]; total: number }> {
  const offset = (page - 1) * limit;

  const [{ count }] = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM webhook_deliveries WHERE merchant_id = $1',
    [merchantId]
  );

  const deliveries = await query(
    `SELECT * FROM webhook_deliveries WHERE merchant_id = $1
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [merchantId, limit, offset]
  );

  return { deliveries, total: parseInt(count) };
}

export async function retryWebhookDelivery(deliveryId: string, merchantId: string): Promise<void> {
  const delivery = await queryOne<any>(
    'SELECT * FROM webhook_deliveries WHERE id = $1 AND merchant_id = $2',
    [deliveryId, merchantId]
  );

  if (!delivery) throw Object.assign(new Error('Delivery not found'), { statusCode: 404, code: 'NOT_FOUND' });

  await queryOne(
    `UPDATE webhook_deliveries SET status = 'pending', attempt_count = 0, next_retry_at = NULL WHERE id = $1`,
    [deliveryId]
  );

  await webhookQueue.add(
    delivery.event_type,
    { deliveryId, paymentId: delivery.payment_id, merchantId, payload: delivery.payload },
    { jobId: `retry_${deliveryId}_${Date.now()}` }
  );
}
