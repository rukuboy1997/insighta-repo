const { Pool } = require("pg");
const { v7: uuidv7 } = require("uuid");
const { readFileSync } = require("fs");
const path = require("path");

// Load .env if it exists (optional, for local dev)
try {
  require("dotenv").config({ path: path.join(__dirname, "../.env") });
} catch (_) {}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Error: DATABASE_URL environment variable is required");
  process.exit(1);
}

async function createTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      gender VARCHAR(10) NOT NULL,
      gender_probability REAL NOT NULL,
      age INTEGER NOT NULL,
      age_group VARCHAR(20) NOT NULL,
      country_id VARCHAR(2) NOT NULL,
      country_name VARCHAR(100) NOT NULL,
      country_probability REAL NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_gender ON profiles(gender);
    CREATE INDEX IF NOT EXISTS idx_profiles_age_group ON profiles(age_group);
    CREATE INDEX IF NOT EXISTS idx_profiles_country_id ON profiles(country_id);
    CREATE INDEX IF NOT EXISTS idx_profiles_age ON profiles(age);
    CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON profiles(created_at);
    CREATE INDEX IF NOT EXISTS idx_profiles_gender_probability ON profiles(gender_probability);
    CREATE INDEX IF NOT EXISTS idx_profiles_country_probability ON profiles(country_probability);
  `);
  console.log("Table and indexes ready.");
}

async function seed() {
  const pool = new Pool({ connectionString: DATABASE_URL });

  // Try to find seed file relative to this script, or relative to cwd
  const candidates = [
    path.join(__dirname, "../../attached_assets/seed_profiles_1776965510671.json"),
    path.join(process.cwd(), "seed_profiles_1776965510671.json"),
    path.join(__dirname, "../seed_profiles_1776965510671.json"),
  ];

  let filePath = null;
  for (const p of candidates) {
    try {
      require("fs").accessSync(p);
      filePath = p;
      break;
    } catch (_) {}
  }

  if (!filePath) {
    console.error("Could not find seed_profiles_1776965510671.json. Place it in the project root or next to this script.");
    process.exit(1);
  }

  const { profiles } = JSON.parse(readFileSync(filePath, "utf-8"));
  console.log(`Found ${profiles.length} profiles. Seeding...`);

  const client = await pool.connect();
  try {
    await createTable(client);

    // Batch insert in chunks of 100
    const CHUNK_SIZE = 100;
    let inserted = 0;
    let skipped = 0;

    for (let i = 0; i < profiles.length; i += CHUNK_SIZE) {
      const chunk = profiles.slice(i, i + CHUNK_SIZE);
      const values = [];
      const placeholders = chunk.map((p, j) => {
        const base = j * 9;
        values.push(uuidv7(), p.name, p.gender, p.gender_probability, p.age, p.age_group, p.country_id, p.country_name, p.country_probability);
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9})`;
      });

      const result = await client.query(
        `INSERT INTO profiles (id,name,gender,gender_probability,age,age_group,country_id,country_name,country_probability)
         VALUES ${placeholders.join(",")}
         ON CONFLICT (name) DO NOTHING`,
        values
      );
      inserted += result.rowCount || 0;
      skipped += chunk.length - (result.rowCount || 0);
      process.stdout.write(`\rProgress: ${Math.min(i + CHUNK_SIZE, profiles.length)}/${profiles.length}`);
    }

    console.log(`\nDone. Inserted: ${inserted}, Skipped (duplicates): ${skipped}`);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
