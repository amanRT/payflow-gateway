import { Router, Request, Response } from 'express';
import { apiKeyAuth, jwtAuth } from '../middleware/auth';
import { rateLimiter } from '../middleware/rateLimiter';
import { idempotencyCheck } from '../middleware/idempotency';
import {
  createPayment,
  getPayment,
  capturePayment,
  refundPayment,
  listPayments,
} from '../services/payment.service';

const router = Router();

// Create payment — JWT auth (dashboard UI) + idempotency + rate limiting
router.post(
  '/',
  jwtAuth,
  rateLimiter,
  idempotencyCheck,
  async (req: Request, res: Response) => {
    const { amount, currency, description, metadata } = req.body;

    if (!amount || typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'amount must be a positive integer (in paise)' } });
    }

    const idempotencyKey = req.headers['x-idempotency-key'] as string;

    try {
      const payment = await createPayment({
        merchantId: req.merchantId!,
        amount,
        currency,
        description,
        metadata,
        idempotencyKey,
      });
      return res.status(201).json({ payment });
    } catch (err: any) {
      if (err.code === 'PAYMENT_BLOCKED') {
        return res.status(422).json({
          error: { code: 'PAYMENT_BLOCKED', message: err.message },
          payment: err.payment,
        });
      }
      if (err.code === '23505') {
        const existing = await getPayment(req.body.id, req.merchantId!);
        return res.status(201).json({ payment: existing });
      }
      throw err;
    }
  }
);

// Get payment — JWT auth
router.get('/:id', jwtAuth, rateLimiter, async (req: Request, res: Response) => {
  const payment = await getPayment(req.params.id, req.merchantId!);
  if (!payment) {
    return res.status(404).json({ error: { code: 'PAYMENT_NOT_FOUND', message: 'Payment not found' } });
  }
  return res.json({ payment });
});

// Capture payment — JWT auth
router.post('/:id/capture', jwtAuth, rateLimiter, async (req: Request, res: Response) => {
  try {
    const payment = await capturePayment(req.params.id, req.merchantId!);
    return res.json({ payment });
  } catch (err: any) {
    const status = err.statusCode || 500;
    return res.status(status).json({ error: { code: err.code || 'INTERNAL_ERROR', message: err.message } });
  }
});

// Refund payment — JWT auth
router.post('/:id/refund', jwtAuth, rateLimiter, async (req: Request, res: Response) => {
  const { amount, reason } = req.body;

  if (!amount || typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'amount must be a positive integer (in paise)' } });
  }

  try {
    const result = await refundPayment(req.params.id, req.merchantId!, amount, reason);
    return res.json(result);
  } catch (err: any) {
    const status = err.statusCode || 500;
    return res.status(status).json({ error: { code: err.code || 'INTERNAL_ERROR', message: err.message } });
  }
});

// List payments — JWT auth (dashboard)
router.get('/', jwtAuth, async (req: Request, res: Response) => {
  const { status, from, to, page, limit } = req.query as Record<string, string>;

  const result = await listPayments(req.merchantId!, {
    status,
    from,
    to,
    page: page ? parseInt(page) : undefined,
    limit: limit ? parseInt(limit) : undefined,
  });

  return res.json(result);
});

export default router;
