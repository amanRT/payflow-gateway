import { Router, Request, Response } from 'express';
import axios from 'axios';
import { jwtAuth } from '../middleware/auth';
import { listWebhookDeliveries, retryWebhookDelivery } from '../services/webhook.service';
import { createWebhookSignature } from '../utils/hmac';

const router = Router();

router.get('/', jwtAuth, async (req: Request, res: Response) => {
  const page = req.query.page ? parseInt(req.query.page as string) : 1;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;

  const result = await listWebhookDeliveries(req.merchantId!, page, limit);
  return res.json(result);
});

router.post('/test', jwtAuth, async (req: Request, res: Response) => {
  const merchant = req.merchant!;

  if (!merchant.webhook_url) {
    return res.status(400).json({ error: { code: 'NO_WEBHOOK_URL', message: 'No webhook URL configured' } });
  }

  const testPayload = {
    event: 'webhook.test',
    created_at: new Date().toISOString(),
    payload: {
      id: 'pay_test00000000000',
      amount: 10000,
      currency: 'INR',
      status: 'captured',
      description: 'Test webhook',
    },
  };

  const body = JSON.stringify(testPayload);
  const signature = createWebhookSignature(merchant.webhook_secret, body);

  try {
    const response = await axios.post(merchant.webhook_url, testPayload, {
      headers: {
        'Content-Type': 'application/json',
        'X-PayFlow-Signature': signature,
      },
      timeout: 10000,
    });

    return res.json({
      success: true,
      status_code: response.status,
      message: 'Test webhook delivered successfully',
    });
  } catch (err: any) {
    return res.json({
      success: false,
      status_code: err.response?.status ?? null,
      message: err.message,
    });
  }
});

router.post('/:id/retry', jwtAuth, async (req: Request, res: Response) => {
  try {
    await retryWebhookDelivery(req.params.id, req.merchantId!);
    return res.json({ message: 'Webhook queued for retry' });
  } catch (err: any) {
    const status = err.statusCode || 500;
    return res.status(status).json({ error: { code: err.code || 'INTERNAL_ERROR', message: err.message } });
  }
});

export default router;
