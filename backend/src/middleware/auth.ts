import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { redis } from '../config/redis';
import { queryOne } from '../config/database';

export interface Merchant {
  id: string;
  name: string;
  email: string;
  api_key: string;
  webhook_url: string | null;
  webhook_secret: string;
  is_active: boolean;
}

declare global {
  namespace Express {
    interface Request {
      merchant?: Merchant;
      merchantId?: string;
    }
  }
}

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey) {
    return res.status(401).json({ error: { code: 'MISSING_API_KEY', message: 'x-api-key header is required' } });
  }

  const cacheKey = `merchant:${apiKey}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    req.merchant = JSON.parse(cached);
    req.merchantId = req.merchant!.id;
    return next();
  }

  const merchant = await queryOne<Merchant>(
    'SELECT id, name, email, api_key, webhook_url, webhook_secret, is_active FROM merchants WHERE api_key = $1',
    [apiKey]
  );

  if (!merchant || !merchant.is_active) {
    return res.status(401).json({ error: { code: 'INVALID_API_KEY', message: 'Invalid or inactive API key' } });
  }

  await redis.setex(cacheKey, 300, JSON.stringify(merchant));
  req.merchant = merchant;
  req.merchantId = merchant.id;
  next();
}

export async function jwtAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: { code: 'MISSING_TOKEN', message: 'Authorization header with Bearer token is required' } });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { merchantId: string };
    req.merchantId = payload.merchantId;

    const merchant = await queryOne<Merchant>(
      'SELECT id, name, email, api_key, webhook_url, webhook_secret, is_active FROM merchants WHERE id = $1',
      [payload.merchantId]
    );

    if (!merchant || !merchant.is_active) {
      return res.status(401).json({ error: { code: 'MERCHANT_NOT_FOUND', message: 'Merchant not found or inactive' } });
    }

    req.merchant = merchant;
    next();
  } catch {
    return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
  }
}
