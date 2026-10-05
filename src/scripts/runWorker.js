import { workerService } from '../services/workerService.js';
import { runMigrations } from '../db/migrate.js';

async function main() {
  console.log('MeterFlow Background Worker Executing...');
  runMigrations();
  const summary = await workerService.runAllJobs();
  console.log('Worker execution results:', JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
