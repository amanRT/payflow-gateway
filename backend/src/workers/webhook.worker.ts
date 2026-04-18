import dotenv from 'dotenv';
dotenv.config();

import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { redisForBullMQ } from '../config/redis';
import { queryOne } from '../config/database';
import { createWebhookSignature } from '../utils/hmac';
import { diagnoseWebhookFailure } from '../services/ai.service';

interface WebhookJobData {
  deliveryId: string;
  paymentId: string;
  merchantId: string;
  payload: any;
}

const worker = new Worker<WebhookJobData>(
  'webhook-delivery',
  async (job: Job<WebhookJobData>) => {
    const { deliveryId, merchantId, payload } = job.data;

    const merchant = await queryOne<{ webhook_url: string | null; webhook_secret: string }>(
      'SELECT webhook_url, webhook_secret FROM merchants WHERE id = $1',
      [merchantId]
    );

    if (!merchant?.webhook_url) {
      await updateDelivery(deliveryId, 'failed', job.attemptsMade + 1, null, 'No webhook URL configured');
      return;
    }

    const body = JSON.stringify(payload);
    const signature = createWebhookSignature(merchant.webhook_secret, body);

    await queryOne(
      `UPDATE webhook_deliveries
       SET attempt_count = $1, last_attempted_at = NOW(), status = 'pending'
       WHERE id = $2`,
      [job.attemptsMade + 1, deliveryId]
    );

    const response = await axios.post(merchant.webhook_url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-PayFlow-Signature': signature,
        'User-Agent': 'PayFlow-Webhook/1.0',
      },
      timeout: 10000,
      validateStatus: null,
    });

    const success = response.status >= 200 && response.status < 300;
    const responseBody = typeof response.data === 'string'
      ? response.data.slice(0, 500)
      : JSON.stringify(response.data).slice(0, 500);

    await updateDelivery(
      deliveryId,
      success ? 'delivered' : 'failed',
      job.attemptsMade + 1,
      response.status,
      responseBody
    );

    if (!success) {
      throw new Error(`Webhook returned non-2xx status: ${response.status}`);
    }
  },
  {
    connection: redisForBullMQ,
    concurrency: 10,
  }
);

async function updateDelivery(
  deliveryId: string,
  status: string,
  attemptCount: number,
  responseStatusCode: number | null,
  responseBody: string | null
) {
  await queryOne(
    `UPDATE webhook_deliveries
     SET status = $1, attempt_count = $2, response_status_code = $3,
         response_body = $4, last_attempted_at = NOW()
     WHERE id = $5`,
    [status, attemptCount, responseStatusCode, responseBody, deliveryId]
  );
}

worker.on('completed', (job) => {
  console.log(`Webhook job ${job.id} completed`);
});

worker.on('failed', async (job, err) => {
  console.error(`Webhook job ${job?.id} failed:`, err.message);

  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 3;
  if (job.attemptsMade < maxAttempts) return;

  const { deliveryId, merchantId } = job.data;

  try {
    const delivery = await queryOne<{
      webhook_url: string;
      attempt_count: number;
      response_status_code: number | null;
      response_body: string | null;
      event_type: string;
    }>(
      `SELECT wd.attempt_count, wd.response_status_code, wd.response_body, wd.event_type,
              m.webhook_url
       FROM webhook_deliveries wd
       JOIN merchants m ON m.id = wd.merchant_id
       WHERE wd.id = $1`,
      [deliveryId]
    );

    if (!delivery?.webhook_url) return;

    const diagnosis = await diagnoseWebhookFailure({
      webhook_url: delivery.webhook_url,
      attempt_count: delivery.attempt_count,
      response_status_code: delivery.response_status_code,
      response_body: delivery.response_body,
      event_type: delivery.event_type,
    });

    if (diagnosis) {
      await queryOne(
        `UPDATE webhook_deliveries SET ai_diagnosis = $1 WHERE id = $2`,
        [diagnosis, deliveryId]
      );
    }
  } catch (diagErr) {
    console.error(`AI diagnosis failed for delivery ${deliveryId}:`, diagErr);
  }
});

console.log('Webhook worker started');
