import { getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { PLANS } from '../config/plans.js';
import crypto from 'crypto';

export function seed(db = null) {
  const database = db || getDb();
  runMigrations(database);

  console.log('Seeding MeterFlow database...');

  // 1. Seed Plans
  const insertPlan = database.prepare(`
    INSERT OR REPLACE INTO plans (id, name, monthly_price_cents, api_calls_quota, ai_tokens_quota, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `);

  insertPlan.run(
    PLANS.free.id,
    PLANS.free.name,
    PLANS.free.monthly_price_cents,
    PLANS.free.quotas.api_calls,
    PLANS.free.quotas.ai_tokens
  );

  insertPlan.run(
    PLANS.pro.id,
    PLANS.pro.name,
    PLANS.pro.monthly_price_cents,
    PLANS.pro.quotas.api_calls,
    PLANS.pro.quotas.ai_tokens
  );

  const now = Date.now();
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const endOfMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59, 999).getTime();

  // Helper to upsert tenant & subscription
  const upsertTenant = database.prepare(`
    INSERT OR REPLACE INTO tenants (id, name, email, stripe_customer_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const upsertSubscription = database.prepare(`
    INSERT OR REPLACE INTO subscriptions (id, tenant_id, plan_id, stripe_subscription_id, status, current_period_start, current_period_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Tenant 1: Default Free Tenant (clean, 0 usage)
  upsertTenant.run('tenant_default_free', 'Acme Free Starter', 'starter@acme.test', 'cus_free_demo_1', now, now);
  upsertSubscription.run('sub_free_demo_1', 'tenant_default_free', 'free', null, 'active', startOfMonth, endOfMonth, now, now);

  // Tenant 2: Boundary Test Tenant (starts at 998 API calls for exact boundary testing: 999, 1000, 1001)
  upsertTenant.run('tenant_boundary_test', 'Boundary Limits Tester', 'tester@limits.test', 'cus_boundary_demo', now, now);
  upsertSubscription.run('sub_boundary_demo', 'tenant_boundary_test', 'free', null, 'active', startOfMonth, endOfMonth, now, now);

  // Clear existing usage for clean boundary seeding
  database.prepare('DELETE FROM usage_events WHERE tenant_id = ?').run('tenant_boundary_test');
  database.prepare('DELETE FROM idempotency_records WHERE tenant_id = ?').run('tenant_boundary_test');

  const insertUsage = database.prepare(`
    INSERT INTO usage_events (id, tenant_id, event_type, api_calls_count, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, cost_nanodollars, idempotency_key, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Pre-seed 998 API calls for tenant_boundary_test
  insertUsage.run(
    'seed_usage_boundary_998',
    'tenant_boundary_test',
    'api_call',
    998,
    0,
    0,
    0,
    0,
    0,
    998 * 1000000,
    'seed_idem_boundary_init',
    startOfMonth + 1000
  );

  // Tenant 3: Pro Enterprise Tenant (high volume)
  upsertTenant.run('tenant_pro_corp', 'Hyperion Pro Corp', 'billing@hyperion.test', 'cus_pro_demo_2', now, now);
  upsertSubscription.run('sub_pro_demo_2', 'tenant_pro_corp', 'pro', 'sub_stripe_pro_active', 'active', startOfMonth, endOfMonth, now, now);

  // Tenant 4: Stripe Upgrade Candidate (Starts as Free, will be upgraded to Pro via Checkout/Webhook)
  upsertTenant.run('tenant_stripe_upgrade', 'Stripe Upgrade Customer', 'stripe_user@demo.test', 'cus_stripe_test_123', now, now);
  upsertSubscription.run('sub_stripe_upgrade_init', 'tenant_stripe_upgrade', 'free', null, 'active', startOfMonth, endOfMonth, now, now);

  // Tenant 5: Past Due / Lapsed Plan (to demonstrate 402 Payment Required)
  upsertTenant.run('tenant_past_due', 'Lapsed Account Inc', 'lapsed@debt.test', 'cus_lapsed_demo', now, now);
  upsertSubscription.run('sub_lapsed_demo', 'tenant_past_due', 'pro', 'sub_lapsed_stripe', 'past_due', startOfMonth, endOfMonth, now, now);

  console.log('Seeding completed successfully:');
  console.log(' - Plans: free (1,000 calls / 100k tokens), pro (50,000 calls / 5M tokens)');
  console.log(' - Tenants:');
  console.log('   * tenant_default_free (Free, 0 used)');
  console.log('   * tenant_boundary_test (Free, 998/1000 used for boundary probes)');
  console.log('   * tenant_pro_corp (Pro, 50k quota)');
  console.log('   * tenant_stripe_upgrade (Free, ready for Stripe checkout upgrade)');
  console.log('   * tenant_past_due (Pro, past_due status for 402 testing)');

  return true;
}

// Auto-run if executed directly
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seed();
}
