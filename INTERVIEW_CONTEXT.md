# PayFlow — Interview AI Context File

> **How to use this file:** Paste the entire contents into an AI assistant before your interview. Tell it: "I built this project. Answer interview questions about it as if you are me — use first person, be specific, reference actual code details."

---

## What This Project Is

I built a full-stack payment gateway called **PayFlow** — essentially a simplified Razorpay/Stripe clone. The goal was to deeply understand what happens under the hood in a real payment system: idempotency, webhook reliability, fraud detection, async job queues, and caching.

This is a portfolio project built to demonstrate SDE-1/SDE-2 level backend engineering skills, specifically for fintech companies.

---

## Complete Tech Stack

**Backend:**

- Runtime: Node.js with Express and TypeScript
- Database: PostgreSQL 16 — raw `pg` driver, no ORM (intentional)
- Cache + Queue: Redis 7 via ioredis, BullMQ for job queue
- AI: Anthropic Claude Opus 4.7 via `@anthropic-ai/sdk` v0.39.0
- Auth: JWT (dashboard) + API Key (programmatic access)
- Password hashing: bcrypt
- Security headers: Helmet

**Frontend:**

- React 18 with TypeScript
- Vite (dev server + build)
- Tailwind CSS + Framer Motion (animations)
- Recharts (area charts)
- Axios with interceptors

**Infrastructure:**

- Docker Compose for local Postgres + Redis
- Two separate Node processes: API server + webhook worker

---

## Complete Feature List

### 1. Payment Lifecycle

- Create payment → captured → refunded
- Statuses: `created`, `authorized`, `captured`, `failed`, `blocked`, `refunded`
- Amounts stored in paise (smallest INR unit) as integers — no floating point money
- Every payment creation runs AI fraud detection first

### 2. AI Fraud Detection

- Runs before every payment INSERT
- Uses deterministic rules to decide action (not Claude — LLMs are unpredictable for binary decisions)
- Claude writes the human-readable reason text only
- Risk score (0–100), action (allow/review/block), reason stored with the payment
- Blocked payments are still saved to DB with status=`blocked` (not silently dropped) so merchants can audit them
- Fast-path: amounts ≤ ₹5,000 skip the AI call entirely for near-zero latency

### 3. Webhook System

- Events fired: `payment.captured`, `payment.refunded`, `webhook.test`
- Signed with HMAC-SHA256 — header: `X-PayFlow-Signature: sha256=<hex>`
- Async delivery via BullMQ queue (separate worker process)
- 3 retries with exponential backoff (30s → 90s → 270s)
- Delivery records stored: attempt count, HTTP status, response body, last attempt time
- On final failure: Claude diagnoses the issue from URL + status + body and stores it

### 4. Analytics Dashboard

- Total volume, transactions, success rate, avg transaction (Redis-cached 5 min)
- 30-day daily volume chart
- AI Anomaly Detection: today's metrics vs. 7-day average → severity flag (low/medium/high)
- Natural Language Search: "show failed payments from last week" → Claude converts to SQL filters

### 5. Security & Reliability

- Two auth schemes: JWT Bearer for dashboard, `x-api-key` header for API clients
- Token bucket rate limiter — 100 requests/60s per API key, tracked in Redis
- Idempotency keys — required on payment creation, cached 24h in Redis
- All analytics cached in Redis (5 min TTL)
- Merchant API key cached in Redis on lookup (5 min TTL)
- bcrypt password hashing

---

## Database Schema (Full Detail)

```sql
-- Merchants
CREATE TABLE merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  api_key VARCHAR(64) UNIQUE NOT NULL,
  webhook_url TEXT,
  webhook_secret VARCHAR(64) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Payments
CREATE TABLE payments (
  id VARCHAR(32) PRIMARY KEY,               -- pay_<nanoid>
  merchant_id UUID REFERENCES merchants(id),
  amount INTEGER NOT NULL,                  -- paise (integer, no float)
  currency VARCHAR(3) DEFAULT 'INR',
  status VARCHAR(20) NOT NULL DEFAULT 'created',
  idempotency_key VARCHAR(255) NOT NULL,
  description TEXT,
  metadata JSONB DEFAULT '{}',
  failure_reason TEXT,
  risk_score INTEGER DEFAULT 0,
  risk_reason TEXT,
  risk_action VARCHAR(20) DEFAULT 'allow',
  captured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(merchant_id, idempotency_key)
);

-- Webhook Deliveries
CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id VARCHAR(32) REFERENCES payments(id),
  merchant_id UUID REFERENCES merchants(id),
  event_type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',     -- pending/delivered/failed
  attempt_count INTEGER DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  last_attempted_at TIMESTAMPTZ,
  response_status_code INTEGER,
  response_body TEXT,
  ai_diagnosis TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Refunds
CREATE TABLE refunds (
  id VARCHAR(32) PRIMARY KEY,               -- ref_<nanoid>
  payment_id VARCHAR(32) REFERENCES payments(id),
  merchant_id UUID REFERENCES merchants(id),
  amount INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'processed',
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Key indexes:** merchant_id + created_at on payments for list queries; status on webhook_deliveries for worker polling.

---

## Key Implementation Deep Dives

### Idempotency System

```typescript
// middleware/idempotency.ts
export async function idempotencyCheck(req, res, next) {
  const key = req.headers["x-idempotency-key"];
  if (!key) return next(); // optional on non-payment routes

  const cacheKey = `idempotent:${req.merchantId}:${key}`;
  const cached = await redis.get(cacheKey);
  if (cached) return res.json(JSON.parse(cached)); // return identical response

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400) {
      redis.setex(cacheKey, 86400, JSON.stringify(body)); // cache 24h on success
    }
    return originalJson(body);
  };
  next();
}
```

Why: A mobile client on a bad connection retries a payment after a timeout. Without idempotency, they're charged twice. With it, the second request hits Redis and gets the original response in ~1ms.

---

### Token Bucket Rate Limiter

```typescript
// middleware/rateLimiter.ts
async function rateLimiter(req, res, next) {
  const key = `rate:${req.merchantId}`;
  const now = Date.now();
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000");
  const maxTokens = parseInt(process.env.RATE_LIMIT_MAX || "100");

  const data = await redis.get(key);
  let { tokens, lastRefill } = data
    ? JSON.parse(data)
    : { tokens: maxTokens, lastRefill: now };

  // Refill tokens proportional to time elapsed
  const elapsed = now - lastRefill;
  const refill = (elapsed / windowMs) * maxTokens;
  tokens = Math.min(maxTokens, tokens + refill);

  if (tokens < 1) {
    res.setHeader(
      "Retry-After",
      Math.ceil(((1 - tokens) * windowMs) / maxTokens / 1000),
    );
    return res.status(429).json({ error: "Rate limit exceeded" });
  }

  tokens -= 1;
  await redis.setex(
    key,
    Math.ceil(windowMs / 1000) * 2,
    JSON.stringify({ tokens, lastRefill: now }),
  );
  next();
}
```

Token bucket chosen over fixed window because it allows short bursts while still enforcing average rate. A merchant can burst 20 requests immediately without being penalized, unlike a fixed window that would block after the limit in the first second.

---

### Webhook Worker (BullMQ)

```typescript
// workers/webhook.worker.ts
const worker = new Worker('webhook-delivery', async (job) => {
  const { deliveryId, merchantId, payload, webhookUrl, webhookSecret } = job.data;

  const signature = 'sha256=' + crypto
    .createHmac('sha256', webhookSecret)
    .update(JSON.stringify(payload))
    .digest('hex');

  const response = await axios.post(webhookUrl, payload, {
    headers: { 'X-PayFlow-Signature': signature },
    timeout: 10000,
  });

  await db.query(
    `UPDATE webhook_deliveries SET status='delivered', response_status_code=$1, ... WHERE id=$2`,
    [response.status, deliveryId]
  );
}, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30000 }
});

// AI diagnosis on final failure
worker.on('failed', async (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    const diagnosis = await diagnoseWebhookFailure({ ... });
    await db.query(`UPDATE webhook_deliveries SET ai_diagnosis=$1 WHERE id=$2`, [diagnosis, deliveryId]);
  }
});
```

Why a separate worker process: Webhook delivery is I/O-bound and can be slow (external URLs, timeouts). Keeping it in a separate process means a slow webhook doesn't hold up the main API. Also, if the API server crashes, queued jobs survive in Redis and the worker picks them up when restarted.

---

### Fraud Detection Logic

```typescript
// services/ai.service.ts — deterministic rules, Claude writes reason only
const avgAmount = recentPayments.length >= 3
  ? recentPayments.reduce((s, p) => s + p.amount, 0) / recentPayments.length
  : null;
const ratio = avgAmount ? payment.amount / avgAmount : null;

// Rules (Claude cannot override these)
if (avgAmount !== null && ratio !== null) {
  if (ratio > 200 && amountRupees > 50000)       { action = 'block';  risk_score = 90; }
  else if (ratio > 50 && amountRupees > 10000)   { action = 'review'; risk_score = 65; }
  else if (ratio > 20)                            { action = 'review'; risk_score = 45; }
  else if (ratio > 5)                             { action = 'review'; risk_score = 30; }
  else                                            { action = 'allow';  risk_score = 10; }
} else {
  // No history
  if (amountRupees > 500000)      { action = 'block';  risk_score = 85; }
  else if (amountRupees > 100000) { action = 'review'; risk_score = 50; }
  else                            { action = 'allow';  risk_score = 8;  }
}

// Claude writes the human-readable explanation — doesn't decide action
const reason = await claude.messages.create({ ... });
```

Design choice: Initially I let Claude decide block/allow/review. It was inconsistent — it would block ₹500 payments sometimes. The right pattern is deterministic rules for the binary decision, LLM for the natural language output.

---

### Analytics Query (why counts matter)

```sql
-- Success rate counts created/authorized/captured/refunded — not just captured
SELECT
  COALESCE(SUM(amount) FILTER (WHERE status NOT IN ('blocked', 'failed')), 0) AS total_volume,
  COUNT(*) AS total_payments,
  COUNT(*) FILTER (WHERE status IN ('created', 'authorized', 'captured', 'refunded')) AS successful_payments,
  COUNT(*) FILTER (WHERE status IN ('failed', 'blocked')) AS failed_payments,
  COALESCE(AVG(amount) FILTER (WHERE status NOT IN ('blocked', 'failed')), 0) AS avg_transaction
FROM payments
WHERE merchant_id = $1
```

Common mistake: counting only `captured` as "successful." In a real gateway, `created` and `authorized` are also successful states — money is committed. Counting only captured gives 0% success rate for a merchant who doesn't capture.

---

## API Design Decisions & Why

**Two auth schemes (JWT + API Key):**

- Dashboard UI uses JWT — it's a browser session, has expiry, auto-revoked on 401
- External integrations use API key — stateless, can be rotated without re-login
- API key is cached in Redis so DB isn't hit on every request

**Amounts in paise (integers):**

- Never store money as floats. `0.1 + 0.2 = 0.30000000000000004` in JS
- Integer paise means all arithmetic is exact
- Display layer converts: `paise / 100` formatted with `toLocaleString`

**No ORM:**

- Full control over SQL — can use `FILTER (WHERE ...)` aggregations, CTEs, specific indexes
- ORMs generate unpredictable queries that are hard to optimize
- For a payment system, query correctness and performance are critical

**Blocked payments saved to DB:**

- Initially, blocked payments threw an error and were never stored
- Problem: merchants had no audit trail — "where did my payment go?"
- Fix: always INSERT with `status='blocked'` then return 422
- Now the fraud dashboard shows full history including blocked attempts

---

## Frontend Architecture

### Real-time Updates (Polling)

```typescript
// hooks/usePolling.ts
export function usePolling(fn: () => void, intervalMs: number, enabled = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn; // always latest fn without re-registering interval

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => fnRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
}
```

New payment detection without blank rows:

```tsx
// Detect new IDs by diffing previous vs incoming set
const inIds = new Set(incoming.map((x) => x.id));
const added = new Set([...inIds].filter((id) => !prevIds.current.has(id)));

// Animate only new rows — never opacity:0 so no blank flash
<motion.tr
  initial={isNew ? { y: -10, backgroundColor: "rgba(59,130,246,0.18)" } : false}
  animate={isNew ? { y: 0, backgroundColor: "rgba(0,0,0,0)" } : {}}
  transition={{ y: { duration: 0.3 }, backgroundColor: { duration: 2.5 } }}
/>;
```

Key insight: using `opacity: 0` in the initial animation caused blank rows during transition. Using only `y` and `backgroundColor` keeps the row visible immediately.

### Live Clock (1-second tick)

```typescript
function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
```

Separated from data polling (5s) — clock always ticks, data refreshes separately.

---

## Common Interview Questions & Answers

**Q: How do you prevent duplicate payments?**
Idempotency keys. The client generates a unique key per payment attempt and sends it as `X-Idempotency-Key`. The server caches the response in Redis keyed by `merchantId + idempotencyKey` for 24 hours. Duplicate requests get the cached response immediately without touching the DB. The unique constraint `(merchant_id, idempotency_key)` in PostgreSQL is a DB-level safety net for race conditions.

**Q: How do webhooks work? What happens if delivery fails?**
When a payment is captured or refunded, a job is added to a BullMQ queue in Redis. A separate worker process picks it up, signs the payload with HMAC-SHA256, and POSTs to the merchant's webhook URL. If it fails (timeout, 4xx/5xx, network error), BullMQ retries up to 3 times with exponential backoff: 30s, 90s, 270s. On final failure, I use Claude to analyze the URL, HTTP status, and response body, generate a diagnosis, and store it — so the merchant can see exactly why it failed and what to fix.

**Q: How does the fraud detection work?**
Two-stage approach. First, deterministic rules check the payment amount against the merchant's last 20 payments. If the new amount is 200x the average and over ₹50,000, it's blocked. Smaller ratios get `review`. For merchants with no history, extreme amounts (>₹5 lakh) are blocked, everything else is allowed. Second, Claude writes a one-sentence human-readable explanation for whatever the rules decided. I tried letting Claude make the block decision but it was inconsistent — would block normal payments. Rules are auditable and deterministic, Claude adds natural language value.

**Q: How did you implement rate limiting?**
Token bucket algorithm in Redis. Each API key has a token bucket. Every request consumes one token. Tokens refill linearly over time proportional to elapsed time. If tokens run out, return 429 with a `Retry-After` header. Token bucket is better than fixed window because it handles bursts gracefully — a merchant can send 20 quick requests without being penalized, which would fail in a fixed window if they hit the limit in second 1.

**Q: Why PostgreSQL over MongoDB?**
Payments have clear relational structure — payments belong to merchants, refunds belong to payments, webhook deliveries belong to payments. Transactions (for refunds) need ACID guarantees. PostgreSQL's `FILTER (WHERE ...)` aggregate syntax is perfect for computing success rates and volumes in a single query. MongoDB is better for unstructured documents; financial data is not that.

**Q: How do you handle concurrency — what if two requests try to create the same payment at once?**
Three layers: (1) The `(merchant_id, idempotency_key)` unique constraint in PostgreSQL rejects the second INSERT at the DB level. (2) The idempotency middleware checks Redis before hitting the DB, so most duplicates are caught before they reach the service layer. (3) If a race condition somehow bypasses Redis (cache miss + simultaneous requests), the DB constraint fires a `23505` unique violation error, which I catch and return the original payment instead.

**Q: How is the webhook signature generated and verified?**

```
signature = "sha256=" + HMAC-SHA256(webhookSecret, JSON.stringify(payload))
```

The secret is unique per merchant (stored in DB). The merchant verifies it on their end with the same HMAC computation using `crypto.timingSafeEqual` to prevent timing attacks. This proves the payload came from PayFlow and wasn't tampered with.

**Q: How does the natural language search work?**
User types "show failed payments from last week". I send that to Claude with today's date and a system prompt explaining valid filter fields (status, from, to, min_amount, max_amount). Claude returns JSON like `{"status":"failed","from":"2026-04-10","to":"2026-04-17"}`. I pass those directly to the existing `listPayments` service. No special parsing — Claude handles the translation from English to structured data.

**Q: What would you improve if this were going to production?**

1. Webhook URL validation — currently any URL is accepted
2. Proper event sourcing — append-only payment events instead of mutable status column
3. Distributed tracing (OpenTelemetry) — trace a request from API → DB → queue → worker
4. The BullMQ worker should be horizontally scalable (multiple workers, currently single process)
5. Webhook delivery should use a dedicated outbound IP to help merchants whitelist
6. Add cursor-based pagination instead of offset — offset becomes slow at large page counts
7. Encryption at rest for sensitive metadata

**Q: How does Redis caching work in your analytics?**
Analytics data (summary stats, daily volume) is computed with SQL aggregations and cached in Redis for 5 minutes. First request hits Postgres and warms the cache. Subsequent requests within 5 minutes hit Redis and return in ~1ms. The tradeoff is 5 minutes of staleness, which is acceptable for a dashboard. I also cache merchant lookups (API key → merchant object) for 5 minutes to avoid a DB hit on every API request.

**Q: Explain the frontend real-time updates.**
I poll the API every 5 seconds using a custom `usePolling` hook. Each poll, I compare the incoming payment IDs against a `useRef` set of previously seen IDs. New IDs trigger an animation (slide down from `y: -10`, blue highlight fade over 2.5 seconds). I deliberately don't use WebSockets — for a dashboard with one merchant, 5-second polling is simple and reliable. WebSockets add complexity (reconnection logic, heartbeats) that isn't justified here.

---

## Numbers to Know

| Metric                               | Value                                   |
| ------------------------------------ | --------------------------------------- |
| Analytics cache TTL                  | 5 minutes                               |
| Idempotency key TTL                  | 24 hours                                |
| API key cache TTL                    | 5 minutes                               |
| Rate limit                           | 100 requests / 60 seconds               |
| Webhook retries                      | 3 (exponential backoff: 30s, 90s, 270s) |
| Webhook timeout                      | 10 seconds                              |
| Payments per page                    | 20 (max 100)                            |
| Fraud fast-path threshold            | ₹5,000 (5,00,000 paise)                 |
| Fraud block threshold (no history)   | ₹5,00,000                               |
| Fraud block threshold (with history) | 200× average AND > ₹50,000              |
| Recent payments for fraud context    | Last 20                                 |
| Frontend poll interval               | 5 seconds                               |
| Live clock interval                  | 1 second                                |

---

## Files and What's In Them

```
backend/src/
  index.ts              — Express app, middleware chain, route mounting, error handler
  config/
    database.ts         — pg Pool, query/queryOne helpers, connection config
    redis.ts            — ioredis client singleton
    migrate.ts          — reads all .sql files from /migrations, runs in order
  middleware/
    auth.ts             — apiKeyAuth (x-api-key header), jwtAuth (Bearer token)
    idempotency.ts      — check Redis cache, intercept res.json to store response
    rateLimiter.ts      — token bucket per merchantId in Redis
  routes/
    payment.routes.ts   — POST /, GET /, GET /:id, POST /:id/capture, POST /:id/refund
    merchant.routes.ts  — register, login, me, regenerate-key, webhook-url
    webhook.routes.ts   — GET /, POST /test, POST /:id/retry
    analytics.routes.ts — summary, daily, nl-query, anomalies
  services/
    payment.service.ts  — createPayment (fraud check + INSERT), capture, refund, list
    webhook.service.ts  — queueWebhookDelivery, listDeliveries, retryDelivery
    analytics.service.ts— getSummary, getDailyVolume (both Redis-cached)
    ai.service.ts       — assessFraudRisk, nlToQueryParams, diagnoseWebhookFailure, generateAnomalyAlert
  workers/
    webhook.worker.ts   — BullMQ Worker, HTTP POST, retry logic, AI diagnosis on failure
  utils/
    generateId.ts       — pay_<nanoid>, ref_<nanoid> ID generators
    hmac.ts             — HMAC-SHA256 signature creation

frontend/src/
  App.tsx               — BrowserRouter, sidebar layout, RequireAuth guard, page transitions
  pages/
    Login.tsx           — register/login tabs, JWT stored in localStorage
    Dashboard.tsx       — stat cards (count-up), area chart, recent payments, anomaly banner
    Payments.tsx        — table, filters, AI search, CreatePaymentPanel modal with fraud result
    Webhooks.tsx        — delivery log table, retry button, AI diagnosis expand row
    Settings.tsx        — account info, API key copy/regenerate, webhook URL
  hooks/
    usePolling.ts       — setInterval wrapper with fnRef pattern (no stale closures)
  lib/
    api.ts              — axios instance, JWT interceptor, 401→logout, formatPaise, STATUS_COLORS
```

---

## How to Run a Demo During Interview

1. `docker-compose up -d` (start Postgres + Redis)
2. `cd backend && npm run dev` (API on :3001)
3. `cd backend && npm run worker` (webhook worker)
4. `cd frontend && npm run dev` (UI on :5173)
5. Open localhost:5173, register account
6. Create a ₹500 payment — shows AI fraud result (risk score, reason)
7. Create a ₹10,00,000 payment — gets blocked, shows Claude's reasoning
8. Go to Webhooks — shows delivery attempts (will fail if no webhook URL set)
9. Go to Settings — copy API key, set webhook URL
10. Dashboard — shows live stats, chart, anomaly detection

---

## What Makes This Different from a Tutorial Project

1. **Idempotency** — most tutorials skip this; it's critical for payment reliability
2. **Separate worker process** — webhooks don't block the API server
3. **Stored blocked payments** — full audit trail, not silent drops
4. **Deterministic fraud rules** — not prompt engineering for binary decisions
5. **Token bucket rate limiting** — not naive fixed-window
6. **HMAC webhook signing** — merchants can verify payload authenticity
7. **Redis for multiple concerns** — caching, rate limiting, idempotency, job queue
8. **No ORM** — explicit SQL with proper aggregations and indexes
9. **Real-time UI** — polling with new-item detection and animation, no blank rows
10. **Two auth modes** — JWT for browser sessions, API key for programmatic access

---

## STAR Pattern — Feature-by-Feature Explanations

> Use these when the interviewer asks "tell me about your project", "walk me through a feature", or "what did you build and why". Each answer uses the STAR format: **Situation → Task → Action → Result**.

---

### Opening Answer — "Tell me about PayFlow"

**Situation:**
I wanted to deeply understand how payment infrastructure works at companies like Razorpay, Stripe, or Juspay — not just use their APIs, but understand what they actually build internally.

**Task:**
Build a complete payment gateway from scratch that handles the full lifecycle: creating payments, fraud detection, capture, refunds, webhook delivery, and a real-time analytics dashboard.

**Action:**
I built a full-stack system — Node.js + Express + TypeScript backend, PostgreSQL for storage, Redis for caching and job queues, BullMQ for async webhook delivery, and a React frontend with real-time updates. I also integrated Claude AI for four distinct use cases: fraud risk assessment, natural language search, anomaly detection, and webhook failure diagnosis.

**Result:**
A working payment gateway with 5 pages, 15+ API endpoints, an async worker process, and production-grade patterns like idempotency, HMAC-signed webhooks, token bucket rate limiting, and Redis caching — all of which you would need to understand and implement if you joined a fintech backend team.

---

### Feature 1 — Payment Creation & Idempotency

**Situation:**
In real payment systems, the biggest reliability problem is duplicate payments. A user clicks "Pay", the network drops before they get a response, so they click again. Without any protection, you've charged them twice.

**Task:**
Implement a mechanism so that retrying a payment request never creates a duplicate — regardless of how many times the client retries.

**Action:**
I implemented idempotency keys. Every payment request must include an `X-Idempotency-Key` header — a unique string the client generates. In middleware, I check Redis first: if that key was seen before, I return the cached original response immediately. If it's new, I intercept `res.json` to cache the response in Redis for 24 hours after a successful write. As a second safety net, I added a `UNIQUE(merchant_id, idempotency_key)` constraint at the DB level so even a race condition (two simultaneous requests, Redis cache miss) gets caught and returns the original payment.

**Result:**
Duplicate payments are impossible — the second request returns in ~1ms from Redis and never touches the database. I can explain exactly why each layer of protection exists and what failure mode it handles.

---

### Feature 2 — Fraud Detection with AI

**Situation:**
Every payment gateway needs fraud detection. The naive approach is hard-coded rules, but they're brittle and don't scale. The other extreme is fully delegating the decision to an AI — which I tried first and it was a disaster: Claude would randomly block ₹500 payments.

**Task:**
Build a fraud detection system that is reliable and deterministic for the block/allow decision, but still produces intelligent, human-readable explanations.

**Action:**
I split the responsibility. The block/allow/review decision is made by deterministic rules I wrote myself — based on the ratio of the new payment amount to the merchant's average over their last 20 payments. A payment that's 200x the average AND over ₹50,000 gets blocked (score 90). A 5x spike gets "review" (score 30). No history + amount under ₹1 lakh gets allowed automatically. Only after the rules run do I call Claude — and its only job is to write one sentence explaining *why* the score is what it is. I also added a fast-path: payments under ₹5,000 skip the AI call entirely for near-zero latency. Risk score, action, and reason are stored with the payment so merchants have a full audit trail. Blocked payments are saved to DB with status=`blocked` — not silently dropped — so merchants can see what was attempted.

**Result:**
Fraud detection is now consistent and auditable. Rules are predictable, Claude adds natural language value without making critical decisions. The UI shows the fraud result immediately after payment creation — risk score bar, action badge, and AI reasoning.

---

### Feature 3 — Webhook Delivery with Retry & AI Diagnosis

**Situation:**
When a payment is captured, the merchant's system needs to be notified — that's how their database gets updated, orders get fulfilled, emails get sent. This notification (webhook) can fail for many reasons: their server is down, wrong URL, timeout, bad SSL. A fire-and-forget HTTP call in the main API thread isn't reliable.

**Task:**
Build a reliable, asynchronous webhook delivery system that retries on failure, survives server restarts, and helps merchants debug failures.

**Action:**
I built two separate things. First, when a payment event fires, I add a job to a BullMQ queue in Redis (not in the API process). A completely separate Node.js worker process consumes that queue — it signs the payload with HMAC-SHA256 using the merchant's secret (`X-PayFlow-Signature: sha256=<hex>`), then POSTs to their webhook URL. If it fails, BullMQ automatically retries up to 3 times with exponential backoff: 30 seconds, then 90, then 270. Every attempt is recorded in the `webhook_deliveries` table with the HTTP status code and response body. On final failure, I send the delivery info to Claude — URL, status, response body — and it diagnoses the likely cause and fix. Merchants see this in the Webhooks page and can also manually retry.

**Result:**
Webhook delivery is decoupled from the API (a slow webhook doesn't block payment responses), survives crashes (jobs persist in Redis), and failed deliveries are explainable (Claude tells you if it's a 404 URL, a 500 server error, a timeout, etc.).

---

### Feature 4 — Redis for Multiple Concerns

**Situation:**
I needed caching, rate limiting, idempotency storage, and a job queue. I could use four separate tools, but that adds operational complexity.

**Task:**
Use Redis as a single infrastructure dependency that handles multiple distinct concerns cleanly.

**Action:**
Redis plays four roles in this project:
1. **Caching** — Analytics summary and daily volume cached for 5 minutes (key: `analytics:<merchantId>:summary`). Merchant objects cached for 5 minutes after API key lookup (key: `merchant:<apiKey>`).
2. **Idempotency** — Payment responses cached for 24 hours (key: `idempotent:<merchantId>:<idempotencyKey>`).
3. **Rate limiting** — Token bucket state stored per API key (key: `rate:<merchantId>`). Tokens refill linearly over time.
4. **Job queue** — BullMQ stores webhook delivery jobs in Redis. Jobs survive server restarts.

**Result:**
One Redis instance, four distinct use cases, each with its own key namespace and TTL. I can explain the purpose, TTL, and eviction strategy for every key in Redis.

---

### Feature 5 — Analytics & AI Anomaly Detection

**Situation:**
Merchants need a dashboard that shows how their payment volume is trending and whether anything unusual is happening — like a spike in failures or a drop in volume.

**Task:**
Build an analytics system that shows real-time stats, a 30-day chart, and intelligent anomaly alerts.

**Action:**
For the stats (total volume, transaction count, success rate, avg transaction), I wrote a single PostgreSQL query using `COUNT(*) FILTER (WHERE ...)` aggregations — this lets me compute multiple counts in one pass. I initially made the mistake of only counting `captured` payments as "successful", which gave 0% success rate because most payments are in `created` state. I fixed it to count `created`, `authorized`, `captured`, and `refunded` as successful. The results are cached in Redis for 5 minutes. For anomaly detection, I compute today's metrics and compare them to a 7-day average using a subquery. That data goes to Claude, which returns a severity level (low/medium/high) and a message. The frontend shows it as a dismissible banner.

**Result:**
The dashboard shows accurate real-time metrics. The anomaly detection has caught real issues — like when all payments were `blocked` status being miscounted as failures, which showed 0% success rate and triggered a HIGH anomaly alert.

---

### Feature 6 — Natural Language Search

**Situation:**
Merchants want to find payments quickly — "show me failed payments from last week" or "payments over ₹5000 this month" — but building a UI for every possible filter combination is impractical.

**Task:**
Let merchants search in plain English and have the system figure out the correct filters.

**Action:**
I added an AI Search box on the Payments page. When the merchant types a query, I send it to Claude with today's date and a system prompt explaining the valid filter fields (status, from, to, min_amount, max_amount in paise). Claude returns a JSON object like `{"status":"failed","from":"2026-04-10","to":"2026-04-17"}`. I pass those directly to the existing `listPayments` service — no additional parsing needed. If Claude returns an empty object (ambiguous query), the existing full list is returned.

**Result:**
Merchants can type natural language queries and get filtered results in ~1-2 seconds. The AI does the translation work; my existing filter infrastructure handles the data retrieval. No new backend code needed — Claude bridges the user's intent to the existing query parameters.

---

### Feature 7 — Real-time Frontend with Polling

**Situation:**
The payments dashboard needs to show new payments as they arrive — without requiring a manual refresh. WebSockets would work but add significant complexity (reconnection logic, server-side connection management, heartbeats).

**Task:**
Implement real-time payment updates that are simple, reliable, and don't cause visual glitches.

**Action:**
I built a `usePolling` custom hook that calls the payments API every 5 seconds. The key detail is using a `useRef` to store the callback — this avoids the stale closure problem where the interval captures an old version of the function. For new payment detection, I track a Set of previously seen payment IDs in a ref. Each poll, I diff the incoming IDs against the known set. New IDs trigger an animation on that row: it slides in from `y: -10` and has a 2.5-second blue background fade. Critically, I do NOT use `opacity: 0` in the initial state — that caused blank rows during the transition. I also added a separate 1-second clock tick that's independent of the polling interval, so the "Live" badge always shows the current time.

**Result:**
New payments appear automatically with a smooth blue highlight animation. No blank rows, no stale closures, no WebSocket infrastructure. The polling approach is simpler and more debuggable than WebSockets for this use case.

---

### Feature 8 — Two Auth Modes (JWT + API Key)

**Situation:**
A payment gateway has two types of users: a merchant managing their dashboard through a browser, and an external system (their backend server) calling the API programmatically.

**Task:**
Support both use cases with the right auth mechanism for each, without complicating the route definitions.

**Action:**
I built two Express middleware functions: `jwtAuth` checks the `Authorization: Bearer <token>` header and verifies a JWT. `apiKeyAuth` checks the `x-api-key` header and looks up the merchant in PostgreSQL (with a 5-minute Redis cache). Dashboard routes use `jwtAuth`. External API routes can use either. JWT tokens expire in 7 days and are stored in localStorage. API keys are regenerable from the Settings page — regenerating invalidates the old key immediately (the Redis cache TTL means it can survive up to 5 minutes, but the DB record is updated instantly). The 401 response from either middleware triggers an auto-logout in the Axios interceptor.

**Result:**
Clean separation of auth concerns. I learned the hard way what happens when you mix them up — early in development, the UI was calling `POST /payments` which was protected by `apiKeyAuth`, but Axios was sending a JWT. Every payment attempt returned 401 and logged the user out. Fixing this by switching the route to `jwtAuth` immediately resolved it.

---

### Closing — "What would you do differently / what did you learn?"

**What I learned:**
1. Never let an LLM make binary decisions — use rules for the decision, LLM for the explanation
2. Idempotency is not optional in payment systems — it's the first thing you implement
3. Async workers must be separate processes, not in-process callbacks
4. Counting "successful" payments wrong (only `captured`) masked real data — query design matters
5. Redis is versatile enough to replace 4 different tools if you're careful with key namespaces and TTLs

**What I'd do in production:**
1. Event sourcing — append-only payment events instead of mutable status column
2. Cursor-based pagination — offset gets slow at large page numbers
3. Distributed tracing — trace a request from API → DB → queue → worker (OpenTelemetry)
4. Webhook IP whitelisting — dedicated outbound IPs merchants can allow-list
5. Proper secret management — environment variables are fine locally, use Vault or AWS Secrets Manager in prod
