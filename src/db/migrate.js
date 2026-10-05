import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function runMigrations(db = null) {
  const database = db || getDb();
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  database.exec(sql);
  return true;
}

// Auto-run if executed directly
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  console.log('Running database migrations...');
  runMigrations();
  console.log('Database migrations completed successfully.');
}
