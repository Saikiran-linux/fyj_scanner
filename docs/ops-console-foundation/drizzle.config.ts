import { defineConfig } from "drizzle-kit";

// Table DDL is generated/applied from src/db/schema.ts.
// RLS policies + GUC helpers + the ops_app role live in db/policies.sql and are
// applied separately (`npm run db:policies`) AFTER migrate, on every deploy.
//
// Use the Neon DIRECT (non-pooled) connection string for migrations.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
});
