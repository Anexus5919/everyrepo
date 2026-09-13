import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/engine-schema.ts",
  out: "./migrations/engine",
});
