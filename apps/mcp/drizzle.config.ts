import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: new URL("../../.env", import.meta.url), quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/remote/schema.ts",
  out: "./migrations",
  dbCredentials: { url: databaseUrl },
  entities: { roles: { provider: "neon" } },
  strict: true,
  verbose: true,
});
