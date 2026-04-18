import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';

const MAX_TOKENS = parseInt(process.env.RATE_LIMIT_MAX || '100');
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000');
const REFILL_RATE = MAX_TOKENS / (WINDOW_MS / 1000); // tokens per second

export async function rateLimiter(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey) return next();

  const tokensKey = `rate_limit:${apiKey}:tokens`;
  const lastRefillKey = `rate_limit:${apiKey}:last_refill`;

  const now = Date.now();

  const [tokensStr, lastRefillStr] = await redis.mget(tokensKey, lastRefillKey);

  let tokens = tokensStr !== null ? parseFloat(tokensStr) : MAX_TOKENS;
  const lastRefill = lastRefillStr !== null ? parseInt(lastRefillStr) : now;

  const elapsed = (now - lastRefill) / 1000;
  tokens = Math.min(MAX_TOKENS, tokens + elapsed * REFILL_RATE);

  const resetTime = Math.ceil(now / 1000) + Math.ceil((MAX_TOKENS - tokens) / REFILL_RATE);

  res.setHeader('X-RateLimit-Limit', MAX_TOKENS);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, Math.floor(tokens - 1)));
  res.setHeader('X-RateLimit-Reset', resetTime);

  if (tokens < 1) {
    const retryAfter = Math.ceil(1 / REFILL_RATE);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Rate limit exceeded. Retry after ${retryAfter} seconds.`,
      },
    });
  }

  tokens -= 1;

  const pipeline = redis.pipeline();
  pipeline.set(tokensKey, tokens.toString(), 'PX', WINDOW_MS * 2);
  pipeline.set(lastRefillKey, now.toString(), 'PX', WINDOW_MS * 2);
  await pipeline.exec();

  next();
}
