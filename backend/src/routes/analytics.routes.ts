import { Router, Request, Response } from 'express';
import { jwtAuth } from '../middleware/auth';
import { getSummary, getDailyVolume } from '../services/analytics.service';
import { listPayments } from '../services/payment.service';
import { nlToQueryParams, generateAnomalyAlert, AnomalyMetrics } from '../services/ai.service';
import { query } from '../config/database';
import { redis } from '../config/redis';

const router = Router();

router.get('/summary', jwtAuth, async (req: Request, res: Response) => {
  const summary = await getSummary(req.merchantId!);
  return res.json(summary);
});

router.get('/daily', jwtAuth, async (req: Request, res: Response) => {
  const data = await getDailyVolume(req.merchantId!);
  return res.json({ data });
});

router.post('/nl-query', jwtAuth, async (req: Request, res: Response) => {
  const { q } = req.body as { q?: string };
  if (!q || typeof q !== 'string' || q.trim().length === 0) {
    return res.status(400).json({ error: 'Query string "q" is required' });
  }

  const today = new Date().toISOString().split('T')[0];
  const filters = await nlToQueryParams(q.trim(), today);
  const result = await listPayments(req.merchantId!, { ...filters, limit: 50 });

  return res.json({ filters, ...result });
});

router.get('/anomalies', jwtAuth, async (req: Request, res: Response) => {
  const merchantId = req.merchantId!;
  const cacheKey = `analytics:${merchantId}:anomaly`;
  const cached = await redis.get(cacheKey);
  if (cached) return res.json(JSON.parse(cached));

  const todayRows = await query<any>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE status NOT IN ('blocked', 'failed')), 0) AS volume,
       COUNT(*) AS count,
       COUNT(*) FILTER (WHERE status IN ('created', 'authorized', 'captured', 'refunded')) AS successful,
       COALESCE(AVG(amount) FILTER (WHERE status NOT IN ('blocked', 'failed')), 0) AS avg_amount
     FROM payments
     WHERE merchant_id = $1
       AND created_at >= CURRENT_DATE`,
    [merchantId]
  );

  const avgRows = await query<any>(
    `SELECT
       COALESCE(AVG(daily_volume), 0) AS volume,
       COALESCE(AVG(daily_count), 0) AS count,
       COALESCE(AVG(daily_success_rate), 0) AS success_rate,
       COALESCE(AVG(daily_avg_amount), 0) AS avg_amount
     FROM (
       SELECT
         DATE(created_at AT TIME ZONE 'UTC') AS day,
         COALESCE(SUM(amount) FILTER (WHERE status NOT IN ('blocked', 'failed')), 0) AS daily_volume,
         COUNT(*) AS daily_count,
         CASE WHEN COUNT(*) > 0
              THEN COUNT(*) FILTER (WHERE status IN ('created', 'authorized', 'captured', 'refunded'))::float / COUNT(*) * 100
              ELSE 0 END AS daily_success_rate,
         COALESCE(AVG(amount) FILTER (WHERE status NOT IN ('blocked', 'failed')), 0) AS daily_avg_amount
       FROM payments
       WHERE merchant_id = $1
         AND created_at >= NOW() - INTERVAL '7 days'
         AND created_at < CURRENT_DATE
       GROUP BY DATE(created_at AT TIME ZONE 'UTC')
     ) sub`,
    [merchantId]
  );

  const t = todayRows[0];
  const a = avgRows[0];

  const todayCount = parseInt(t.count);
  const todaySuccessful = parseInt(t.successful);

  const todayMetrics: AnomalyMetrics = {
    volume: parseInt(t.volume),
    count: todayCount,
    success_rate: todayCount > 0 ? Math.round((todaySuccessful / todayCount) * 100 * 10) / 10 : 0,
    avg_amount: Math.round(parseFloat(t.avg_amount)),
  };

  const avgMetrics: AnomalyMetrics = {
    volume: Math.round(parseFloat(a.volume)),
    count: Math.round(parseFloat(a.count)),
    success_rate: Math.round(parseFloat(a.success_rate) * 10) / 10,
    avg_amount: Math.round(parseFloat(a.avg_amount)),
  };

  const result = await generateAnomalyAlert(todayMetrics, avgMetrics);

  await redis.setex(cacheKey, 300, JSON.stringify(result));
  return res.json(result);
});

export default router;
