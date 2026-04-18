import { query, queryOne } from '../config/database';
import { redis } from '../config/redis';

export interface AnalyticsSummary {
  total_volume: number;
  total_payments: number;
  successful_payments: number;
  failed_payments: number;
  success_rate: number;
  avg_transaction: number;
}

export interface DailyVolume {
  date: string;
  volume: number;
  count: number;
}

export async function getSummary(merchantId: string): Promise<AnalyticsSummary> {
  const cacheKey = `analytics:${merchantId}:summary`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const result = await queryOne<any>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE status NOT IN ('blocked', 'failed')), 0) AS total_volume,
       COUNT(*) AS total_payments,
       COUNT(*) FILTER (WHERE status IN ('created', 'authorized', 'captured', 'refunded')) AS successful_payments,
       COUNT(*) FILTER (WHERE status IN ('failed', 'blocked')) AS failed_payments,
       COALESCE(AVG(amount) FILTER (WHERE status NOT IN ('blocked', 'failed')), 0) AS avg_transaction
     FROM payments
     WHERE merchant_id = $1`,
    [merchantId]
  );

  const total = parseInt(result.total_payments);
  const successful = parseInt(result.successful_payments);

  const summary: AnalyticsSummary = {
    total_volume: parseInt(result.total_volume),
    total_payments: total,
    successful_payments: successful,
    failed_payments: parseInt(result.failed_payments),
    success_rate: total > 0 ? Math.round((successful / total) * 100 * 100) / 100 : 0,
    avg_transaction: Math.round(parseFloat(result.avg_transaction)),
  };

  await redis.setex(cacheKey, 300, JSON.stringify(summary));
  return summary;
}

export async function getDailyVolume(merchantId: string): Promise<DailyVolume[]> {
  const cacheKey = `analytics:${merchantId}:daily`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const rows = await query<any>(
    `SELECT
       TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
       COALESCE(SUM(amount) FILTER (WHERE status NOT IN ('blocked', 'failed')), 0) AS volume,
       COUNT(*) FILTER (WHERE status NOT IN ('blocked', 'failed')) AS count
     FROM payments
     WHERE merchant_id = $1
       AND created_at >= NOW() - INTERVAL '30 days'
     GROUP BY TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
     ORDER BY date ASC`,
    [merchantId]
  );

  const data: DailyVolume[] = rows.map((r) => ({
    date: r.date,
    volume: parseInt(r.volume),
    count: parseInt(r.count),
  }));

  await redis.setex(cacheKey, 300, JSON.stringify(data));
  return data;
}
