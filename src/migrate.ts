import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const { db } = await import("./db.js");

const migrationsDirectory = join(process.cwd(), "migrations");

async function run() {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = (await readdir(migrationsDirectory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  for (const filename of files) {
    const applied = await db.query<{ filename: string }>("SELECT filename FROM schema_migrations WHERE filename = $1", [filename]);
    if (applied.rowCount) continue;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(join(migrationsDirectory, filename), "utf8"));
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      console.info(`Applied ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

run().then(() => db.end()).catch(async (error) => {
  console.error(error);
  await db.end();
  process.exitCode = 1;
});
