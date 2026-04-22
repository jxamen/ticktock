import { defineConfig } from "drizzle-kit";

export default defineConfig({
    out: "./migrations",
    schema: "./src/lib/db/schema/index.ts",
    dialect: "sqlite",
});
