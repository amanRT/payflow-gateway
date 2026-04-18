import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractJson(text: string): any {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');
  return JSON.parse(match[0]);
}

// ─── Fraud Detection ─────────────────────────────────────────────────────────

export interface FraudRiskResult {
  risk_score: number;
  reason: string;
  action: 'allow' | 'review' | 'block';
}

export async function assessFraudRisk(
  merchantId: string,
  payment: { amount: number; currency: string; description?: string | null; metadata?: Record<string, any> },
  recentPayments: Array<{ amount: number; status: string; created_at: string }>
): Promise<FraudRiskResult> {
  const amountRupees = payment.amount / 100;
  const avgAmount = recentPayments.length >= 3
    ? recentPayments.reduce((s, p) => s + p.amount, 0) / recentPayments.length
    : null;
  const ratio = avgAmount ? payment.amount / avgAmount : null;

  // ── Deterministic rules (Claude does NOT decide block/allow) ──────────────
  let action: 'allow' | 'review' | 'block' = 'allow';
  let risk_score = 5;

  if (avgAmount !== null && ratio !== null) {
    if (ratio > 200 && amountRupees > 50000) {
      action = 'block'; risk_score = 90;
    } else if (ratio > 50 && amountRupees > 10000) {
      action = 'review'; risk_score = 65;
    } else if (ratio > 20) {
      action = 'review'; risk_score = 45;
    } else if (ratio > 5) {
      action = 'review'; risk_score = 30;
    } else {
      action = 'allow'; risk_score = 10;
    }
  } else {
    // No history — only block truly extreme amounts
    if (amountRupees > 500000) {
      action = 'block'; risk_score = 85;
    } else if (amountRupees > 100000) {
      action = 'review'; risk_score = 50;
    } else {
      action = 'allow'; risk_score = 8;
    }
  }

  // ── Claude writes the human-readable reason only ──────────────────────────
  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 120,
      system: `You are a payment risk analyst. Write ONE concise sentence explaining the risk assessment result for this payment. Do not include JSON. Do not recommend blocking or allowing — that decision is already made. Just explain why the risk score is what it is.`,
      messages: [{
        role: 'user',
        content: `Payment: ₹${amountRupees.toFixed(2)}, merchant history: ${recentPayments.length} payments${avgAmount ? `, avg ₹${(avgAmount/100).toFixed(2)}` : ' (no history)'}, risk score: ${risk_score}, action: ${action}.`
      }],
    });
    const reason = response.content.find(b => b.type === 'text')?.text?.trim() ?? 'Risk assessment completed.';
    return { risk_score, reason, action };
  } catch (err) {
    console.error('[AI] assessFraudRisk reason failed:', err);
    const fallbackReason = action === 'block'
      ? `Payment amount (₹${amountRupees.toFixed(2)}) is unusually large compared to account history.`
      : action === 'review'
      ? `Payment amount is higher than typical for this account.`
      : 'Payment amount is within normal range.';
    return { risk_score, reason: fallbackReason, action };
  }
}

// ─── Natural Language → Query Params ─────────────────────────────────────────

export interface NLQueryParams {
  status?: string;
  from?: string;
  to?: string;
  min_amount?: number;
  max_amount?: number;
}

export async function nlToQueryParams(query: string, today: string): Promise<NLQueryParams> {
  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 256,
      system: `You are a query parser for a payment dashboard. Convert natural language to filter params.
Today's date is provided. Amounts in INR but output min_amount/max_amount in paise (×100).
Dates must be ISO 8601 (YYYY-MM-DD). Only include fields explicitly mentioned.
Valid statuses: created, authorized, captured, failed, refunded.
Respond ONLY with valid JSON like: {"status":"captured","from":"2026-04-10","to":"2026-04-17"}`,
      messages: [{
        role: 'user',
        content: `Today: ${today}\nQuery: "${query}"\nReply with JSON only.`
      }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '{}';
    return extractJson(text) as NLQueryParams;
  } catch (err) {
    console.error('[AI] nlToQueryParams failed:', err);
    return {};
  }
}

// ─── Webhook Failure Diagnosis ────────────────────────────────────────────────

export interface WebhookDeliveryInfo {
  webhook_url: string;
  attempt_count: number;
  response_status_code: number | null;
  response_body: string | null;
  event_type: string;
}

export async function diagnoseWebhookFailure(delivery: WebhookDeliveryInfo): Promise<string> {
  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 256,
      system: `You are a webhook debugging assistant for PayFlow. Given a failed webhook delivery, provide a concise 2-3 sentence diagnosis. Identify the likely cause and suggest the most probable fix. Be technical but clear.`,
      messages: [{
        role: 'user',
        content: `URL: ${delivery.webhook_url}
Event: ${delivery.event_type}
Attempts: ${delivery.attempt_count}
HTTP status: ${delivery.response_status_code ?? 'no response (timeout/connection error)'}
Response body: ${delivery.response_body ?? 'empty'}`
      }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    return text.trim();
  } catch (err) {
    console.error('[AI] diagnoseWebhookFailure failed:', err);
    return '';
  }
}

// ─── Anomaly Detection ────────────────────────────────────────────────────────

export interface AnomalyMetrics {
  volume: number;
  count: number;
  success_rate: number;
  avg_amount: number;
}

export interface AnomalyResult {
  has_anomaly: boolean;
  severity?: 'low' | 'medium' | 'high';
  message?: string;
}

export async function generateAnomalyAlert(
  today: AnomalyMetrics,
  sevenDayAvg: AnomalyMetrics
): Promise<AnomalyResult> {
  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 512,
      system: `You are a payment anomaly detection system. Compare today's metrics vs 7-day baseline.
Flag anomalies: >50% volume deviation, >20% success rate drop, or unusual failure spikes.
Severity: low (worth noting), medium (investigate soon), high (act immediately).
Respond ONLY with valid JSON:
{"has_anomaly": <bool>, "severity": "<low|medium|high>", "message": "<string>"}
If no anomaly: {"has_anomaly": false}`,
      messages: [{
        role: 'user',
        content: `Today: volume=${today.volume} paise, txns=${today.count}, success=${today.success_rate}%, avg=${today.avg_amount} paise
7-day avg: volume=${sevenDayAvg.volume} paise, txns=${sevenDayAvg.count}, success=${sevenDayAvg.success_rate}%, avg=${sevenDayAvg.avg_amount} paise
Reply with JSON only.`
      }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '{}';
    return extractJson(text) as AnomalyResult;
  } catch (err) {
    console.error('[AI] generateAnomalyAlert failed:', err);
    return { has_anomaly: false };
  }
}
