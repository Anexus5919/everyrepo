import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/app-schema.ts",
  out: "./migrations/app",
});
