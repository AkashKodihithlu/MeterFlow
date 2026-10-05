-- MeterFlow Database Schema
-- Multi-tenant Usage Metering, Quota Enforcement & Billing

PRAGMA foreign_keys = ON;

-- 1. Tenants Table
CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    stripe_customer_id TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 2. Plans Table
CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    monthly_price_cents INTEGER NOT NULL,
    api_calls_quota INTEGER NOT NULL,
    ai_tokens_quota INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
);

-- 3. Subscriptions Table
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES plans(id),
    stripe_subscription_id TEXT UNIQUE,
    status TEXT NOT NULL, -- active, past_due, canceled, incomplete
    current_period_start INTEGER NOT NULL,
    current_period_end INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_status 
ON subscriptions(tenant_id, status);

-- 4. Usage Events Table
CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL, -- api_call, ai_generation
    api_calls_count INTEGER NOT NULL DEFAULT 1,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_nanodollars INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT UNIQUE NOT NULL,
    timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_tenant_time 
ON usage_events(tenant_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_usage_idempotency 
ON usage_events(idempotency_key);

-- 5. Idempotency Records Table (Stores full response for replay)
CREATE TABLE IF NOT EXISTS idempotency_records (
    idempotency_key TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_headers TEXT NOT NULL,
    response_body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_tenant 
ON idempotency_records(tenant_id);

-- 6. Stripe Webhook Events Table (Deduplication store)
CREATE TABLE IF NOT EXISTS webhook_events (
    stripe_event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL, -- processed, ignored, failed
    processed_at INTEGER NOT NULL
);

-- 7. Quota Alerts Table (Background alerting logs)
CREATE TABLE IF NOT EXISTS quota_alerts (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    metric TEXT NOT NULL, -- api_calls, ai_tokens
    threshold INTEGER NOT NULL, -- 80, 100
    usage_count INTEGER NOT NULL,
    quota_limit INTEGER NOT NULL,
    period_start INTEGER NOT NULL,
    alerted_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_alert_unique 
ON quota_alerts(tenant_id, metric, threshold, period_start);

-- 8. Usage Rollups Table (Hourly/Daily aggregated snapshots)
CREATE TABLE IF NOT EXISTS usage_rollups (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    period_start INTEGER NOT NULL,
    period_end INTEGER NOT NULL,
    total_api_calls INTEGER NOT NULL DEFAULT 0,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_nanodollars INTEGER NOT NULL DEFAULT 0,
    total_cost_cents INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_rollups_tenant_period 
ON usage_rollups(tenant_id, period_start, period_end);
