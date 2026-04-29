const pool = require("./db");

let migrationPromise = null;

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_id BIGINT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      email TEXT,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin', 'analyst')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      code_challenge TEXT,
      code_challenge_method TEXT DEFAULT 'S256',
      redirect_uri TEXT,
      client_type TEXT DEFAULT 'web',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_codes (
      code_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_challenge TEXT NOT NULL,
      code_challenge_method TEXT DEFAULT 'S256',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER,
      ip TEXT,
      response_time_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      id BIGSERIAL PRIMARY KEY,
      ip TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
    CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON auth_codes(expires_at);
    CREATE INDEX IF NOT EXISTS idx_request_logs_user ON request_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_ip_time ON auth_rate_limits(ip, created_at);
  `);
}

function ensureMigrated() {
  if (!migrationPromise) {
    migrationPromise = runMigrations().catch((err) => {
      console.error("Migration failed:", err.message);
      migrationPromise = null;
      throw err;
    });
  }
  return migrationPromise;
}

module.exports = { ensureMigrated };
