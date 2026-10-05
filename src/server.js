import { env } from './config/env.js';
import { createApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { workerService } from './services/workerService.js';

// 1. Ensure migrations are applied on startup
try {
  runMigrations();
} catch (err) {
  console.error('Failed to run database migrations:', err);
  process.exit(1);
}

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 MeterFlow Engine running at: http://localhost:${env.PORT}`);
  console.log(`   Environment : ${env.NODE_ENV}`);
  console.log(`   Database    : ${env.DATABASE_PATH}`);
  console.log(`====================================================`);
});

// Periodic background job execution
let workerTimer = null;
if (env.WORKER_INTERVAL_MS > 0 && env.NODE_ENV !== 'test') {
  workerTimer = setInterval(async () => {
    try {
      await workerService.runAllJobs();
    } catch (err) {
      console.error('[Worker Error]', err.message);
    }
  }, env.WORKER_INTERVAL_MS);
}

// Graceful shutdown handling
function handleShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  if (workerTimer) clearInterval(workerTimer);
  server.close(() => {
    console.log('MeterFlow HTTP server closed.');
    process.exit(0);
  });
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

export { server };
