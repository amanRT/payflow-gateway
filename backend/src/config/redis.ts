import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  // Upstash requires TLS on port 6380
  ...(process.env.REDIS_TLS === 'true' && { tls: {} }),
};

export const redis = new Redis(redisConfig);
export const redisForBullMQ = new Redis(redisConfig);

redis.on('error', (err) => console.error('Redis error:', err));
redis.on('connect', () => console.log('Redis connected'));
