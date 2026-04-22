import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createDb, type Database } from "./db";

/**
 * Next.js API Route / Server Component 에서 Cloudflare 바인딩에 접근한다.
 *
 * 사용법:
 *   const { db, env } = await getEnv();
 */
export async function getEnv() {
    const { env } = await getCloudflareContext();
    const cfEnv = env as unknown as CloudflareEnv;
    const db = createDb(cfEnv.DB);

    return { db, env: cfEnv };
}

export type { Database };
