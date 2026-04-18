import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { queryOne } from '../config/database';
import { redis } from '../config/redis';
import { jwtAuth } from '../middleware/auth';
import { generateApiKey, generateWebhookSecret } from '../utils/generateId';

const router = Router();

router.post('/register', async (req: Request, res: Response) => {
  const { name, email, password, webhook_url } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name, email and password are required' } });
  }

  const existing = await queryOne('SELECT id FROM merchants WHERE email = $1', [email]);
  if (existing) {
    return res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: 'Email already registered' } });
  }

  const password_hash = await bcrypt.hash(password, 12);
  const api_key = generateApiKey();
  const webhook_secret = generateWebhookSecret();

  const merchant = await queryOne<any>(
    `INSERT INTO merchants (name, email, password_hash, api_key, webhook_url, webhook_secret)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, email, api_key, webhook_url, created_at`,
    [name, email, password_hash, api_key, webhook_url ?? null, webhook_secret]
  );

  return res.status(201).json({ merchant });
});

router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'email and password are required' } });
  }

  const merchant = await queryOne<any>(
    'SELECT id, name, email, password_hash, api_key, webhook_url, is_active FROM merchants WHERE email = $1',
    [email]
  );

  if (!merchant || !merchant.is_active) {
    return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
  }

  const valid = await bcrypt.compare(password, merchant.password_hash);
  if (!valid) {
    return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
  }

  const token = jwt.sign({ merchantId: merchant.id }, process.env.JWT_SECRET!, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  } as jwt.SignOptions);

  return res.json({
    token,
    merchant: {
      id: merchant.id,
      name: merchant.name,
      email: merchant.email,
      api_key: merchant.api_key,
      webhook_url: merchant.webhook_url,
    },
  });
});

router.post('/regenerate-key', jwtAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const old_api_key = req.merchant!.api_key;

  const new_api_key = generateApiKey();

  await queryOne(
    'UPDATE merchants SET api_key = $1, updated_at = NOW() WHERE id = $2',
    [new_api_key, merchantId]
  );

  await redis.del(`merchant:${old_api_key}`);

  return res.json({ api_key: new_api_key });
});

router.put('/webhook-url', jwtAuth, async (req: Request, res: Response) => {
  const { webhook_url } = req.body;
  const merchantId = req.merchantId!;

  await queryOne(
    'UPDATE merchants SET webhook_url = $1, updated_at = NOW() WHERE id = $2',
    [webhook_url ?? null, merchantId]
  );

  await redis.del(`merchant:${req.merchant!.api_key}`);

  return res.json({ webhook_url: webhook_url ?? null });
});

router.get('/me', jwtAuth, async (req: Request, res: Response) => {
  const merchant = await queryOne<any>(
    'SELECT id, name, email, api_key, webhook_url, created_at FROM merchants WHERE id = $1',
    [req.merchantId!]
  );
  return res.json({ merchant });
});

export default router;
