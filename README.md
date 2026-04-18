# PayFlow — Payment Gateway

A production-grade payment gateway built to understand how systems like Razorpay and Stripe work internally. Covers the full lifecycle of a payment — creation, fraud detection, capture, refund, webhook delivery, and analytics — with an AI layer powered by Claude.

---

## Tech Stack

| Layer         | Technology                                       |
| ------------- | ------------------------------------------------ |
| Backend       | Node.js, Express, TypeScript                     |
| Database      | PostgreSQL 16 (raw `pg` driver, no ORM)          |
| Cache / Queue | Redis 7, BullMQ                                  |
| AI            | Anthropic Claude Opus 4.7 (`@anthropic-ai/sdk`)  |
| Frontend      | React 18, TypeScript, Vite                       |
| Styling       | Tailwind CSS, Framer Motion                      |
| Charts        | Recharts                                         |
| Auth          | JWT (dashboard), API Key (external integrations) |
| DevOps        | Docker Compose (Postgres + Redis)                |

---

## Features

### Payments

- Create payments in paise (smallest INR unit) with idempotency key support
- Status lifecycle: `created → authorized → captured → refunded`
- Payments blocked by fraud detection are saved with `blocked` status (not silently dropped)
- Pagination, status filter, and date range filter

### AI Fraud Detection

- Every payment is assessed before creation
- Deterministic rules (amount ratio vs. history, absolute thresholds) decide the action — Claude writes the human-readable reason
- Fast-path for clearly safe amounts (no API call = no latency)
- Risk score (0–100), action (`allow` / `review` / `block`), and reason stored with the payment

### Webhooks

- Events: `payment.captured`, `payment.refunded`, `webhook.test`
- Signed with HMAC-SHA256 (`X-PayFlow-Signature` header)
- BullMQ queue with 3 retries and exponential backoff
- On final failure: Claude diagnoses the likely cause from the URL, HTTP status, and response body
- Retry any failed delivery manually from the UI

### Analytics

- Real-time dashboard: total volume, transaction count, success rate, avg transaction value
- 30-day volume area chart
- **AI Anomaly Detection**: compares today vs. 7-day baseline, flags deviations with severity (low / medium / high)
- **Natural Language Search**: type "show failed payments from last week" — Claude converts it to query filters

### Security & Reliability

- Two auth modes: JWT Bearer (dashboard UI) and `x-api-key` (external/programmatic)
- Token bucket rate limiting (100 req/60s per API key, Redis-backed)
- Idempotency keys — duplicate requests return the cached response, never create duplicate payments
- Passwords hashed with bcrypt
- Helmet security headers on all responses

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        React Frontend                        │
│   Dashboard │ Payments │ Webhooks │ Settings │ Login        │
│   Axios + JWT interceptor │ usePolling (5s) │ Framer Motion │
└───────────────────────┬─────────────────────────────────────┘
                        │ /api/v1 (Vite proxy)
┌───────────────────────▼─────────────────────────────────────┐
│                    Express API Server                        │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐  │
│  │ merchant │  │ payments  │  │ webhooks │  │analytics │  │
│  │  routes  │  │  routes   │  │  routes  │  │  routes  │  │
│  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │              │              │         │
│  ┌────▼──────────────▼──────────────▼──────────────▼─────┐  │
│  │           Services Layer (business logic)             │  │
│  │  payment.service │ webhook.service │ analytics.service│  │
│  │                  ai.service (Claude)                  │  │
│  └────────────┬──────────────────────┬────────────────────┘  │
│               │                      │                       │
│  ┌────────────▼────┐      ┌──────────▼──────────┐           │
│  │   PostgreSQL    │      │   Redis (ioredis)   │           │
│  │  payments       │      │  API key cache      │           │
│  │  merchants      │      │  idempotency keys   │           │
│  │  webhooks       │      │  analytics cache    │           │
│  │  refunds        │      │  rate limit tokens  │           │
│  └─────────────────┘      └─────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
                        │ BullMQ queue
┌───────────────────────▼─────────────────────────────────────┐
│                    Webhook Worker (separate process)         │
│  HTTP POST to merchant URL → retry on failure → AI diagnosis│
└─────────────────────────────────────────────────────────────┘
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Docker Desktop (for Postgres + Redis)

### 1. Start Infrastructure

```bash
docker-compose up -d
```

### 2. Backend Setup

```bash
cd backend
cp .env.example .env
# Fill in ANTHROPIC_API_KEY from https://console.anthropic.com

npm install
npm run migrate      # Create all tables
npm run dev          # API server on :3001
```

In a separate terminal:

```bash
cd backend
npm run worker       # Webhook delivery worker
```

### 3. Frontend Setup

```bash
cd frontend
npm install
npm run dev          # UI on :5173 (proxies /api → :3001)
```

Open `http://localhost:5173`, register an account, and you're live.

---

## API Reference

All routes are prefixed with `/api/v1`.

### Auth

| Method | Route                       | Auth | Description             |
| ------ | --------------------------- | ---- | ----------------------- |
| POST   | `/merchants/register`       | —    | Create merchant account |
| POST   | `/merchants/login`          | —    | Get JWT token           |
| GET    | `/merchants/me`             | JWT  | Current merchant info   |
| POST   | `/merchants/regenerate-key` | JWT  | Rotate API key          |
| PUT    | `/merchants/webhook-url`    | JWT  | Set webhook endpoint    |

### Payments

| Method | Route                   | Auth | Description                |
| ------ | ----------------------- | ---- | -------------------------- |
| POST   | `/payments`             | JWT  | Create payment             |
| GET    | `/payments`             | JWT  | List with filters          |
| GET    | `/payments/:id`         | JWT  | Get single payment         |
| POST   | `/payments/:id/capture` | JWT  | Capture authorized payment |
| POST   | `/payments/:id/refund`  | JWT  | Refund captured payment    |

**Create Payment Request:**

```json
{
  "amount": 50000,
  "currency": "INR",
  "description": "Order #1234"
}
```

Headers: `X-Idempotency-Key: <unique-key>`

**Create Payment Response (201):**

```json
{
  "payment": {
    "id": "pay_abc123",
    "amount": 50000,
    "status": "created",
    "risk_score": 8,
    "risk_action": "allow",
    "risk_reason": "Amount is within normal range for this account."
  }
}
```

**Blocked Payment Response (422):**

```json
{
  "error": { "code": "PAYMENT_BLOCKED", "message": "..." },
  "payment": { "id": "pay_xyz", "status": "blocked", "risk_score": 90 }
}
```

### Analytics

| Method | Route                  | Auth | Description                |
| ------ | ---------------------- | ---- | -------------------------- |
| GET    | `/analytics/summary`   | JWT  | Totals and rates           |
| GET    | `/analytics/daily`     | JWT  | 30-day volume              |
| GET    | `/analytics/anomalies` | JWT  | AI anomaly check           |
| POST   | `/analytics/nl-query`  | JWT  | NL search `{ "q": "..." }` |

### Webhooks

| Method | Route                 | Auth | Description           |
| ------ | --------------------- | ---- | --------------------- |
| GET    | `/webhooks`           | JWT  | Delivery log          |
| POST   | `/webhooks/test`      | JWT  | Send test event       |
| POST   | `/webhooks/:id/retry` | JWT  | Retry failed delivery |

---

## Webhook Signature Verification

```typescript
import crypto from "crypto";

function verifyWebhook(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

---

## Environment Variables

```env
NODE_ENV=development
PORT=3001

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=payflow
DB_USER=postgres
DB_PASSWORD=postgres

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Auth
JWT_SECRET=your-secret-here
JWT_EXPIRES_IN=7d

# Rate Limiting
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000

# AI
ANTHROPIC_API_KEY=sk-ant-...
```

---

## Project Structure

```
├── backend/
│   ├── src/
│   │   ├── config/          # DB, Redis, migration runner
│   │   ├── middleware/       # auth, idempotency, rate limiter
│   │   ├── routes/           # payment, merchant, webhook, analytics
│   │   ├── services/         # payment, webhook, analytics, AI
│   │   ├── workers/          # BullMQ webhook delivery worker
│   │   └── utils/            # ID generation, HMAC signing
│   └── migrations/           # SQL migration files
└── frontend/
    └── src/
        ├── pages/            # Login, Dashboard, Payments, Webhooks, Settings
        ├── hooks/            # usePolling
        └── lib/              # Axios instance, helpers
```

---

## Key Design Decisions

**Why raw `pg` instead of an ORM?**
Explicit SQL gives full control over queries and indexes. ORMs add abstraction that hides what's happening at the DB level — not acceptable for a system where query performance matters.

**Why BullMQ for webhooks?**
Webhook delivery must survive server restarts and support retries with backoff. An in-process retry loop would lose state on crash. BullMQ persists jobs in Redis and handles the retry schedule.

**Why deterministic fraud rules + AI for the reason?**
Letting an LLM make the block/allow decision produced unpredictable results. Hard rules (amount ratio, absolute thresholds) are auditable and consistent. Claude adds value by writing human-readable explanations — something rules can't do well.

**Why idempotency keys?**
Network timeouts cause clients to retry. Without idempotency, a retry creates a duplicate payment. Keys are cached in Redis for 24 hours so repeated requests return the original response.
