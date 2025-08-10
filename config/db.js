// config/db.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'YOUR_SUPABASE_CONNECTION_STRING',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

module.exports = pool;