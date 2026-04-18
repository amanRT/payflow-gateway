import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';

const IDEMPOTENCY_TTL = 86400; // 24 hours

export async function idempotencyCheck(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'POST') return next();

  const idempotencyKey = req.headers['x-idempotency-key'] as string;
  if (!idempotencyKey) {
    return res.status(400).json({
      error: { code: 'MISSING_IDEMPOTENCY_KEY', message: 'x-idempotency-key header is required for POST requests' },
    });
  }

  const merchantId = req.merchantId;
  if (!merchantId) return next();

  const cacheKey = `idempotency:${merchantId}:${idempotencyKey}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    const { statusCode, body } = JSON.parse(cached);
    res.setHeader('X-Idempotent-Replayed', 'true');
    return res.status(statusCode).json(body);
  }

  // Intercept res.json to cache the response
  const originalJson = res.json.bind(res);
  res.json = function (body: any) {
    if (res.statusCode < 400) {
      redis.setex(cacheKey, IDEMPOTENCY_TTL, JSON.stringify({ statusCode: res.statusCode, body })).catch(() => {});
    }
    return originalJson(body);
  };

  next();
}
