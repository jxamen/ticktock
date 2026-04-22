import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/**
 * D1 바인딩으로부터 Drizzle 클라이언트를 생성한다.
 * Next.js API Route에서: const db = createDb(env.DB)
 */
export function createDb(d1: D1Database) {
    return drizzle(d1, { schema });
}

export type Database = ReturnType<typeof createDb>;
