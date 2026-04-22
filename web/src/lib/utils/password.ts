/**
 * 비밀번호 해싱/검증 — PBKDF2 (Web Crypto API)
 * Cloudflare Workers 호환 (bcrypt 사용 불가)
 */

const ITERATIONS = 100_000;
const KEY_LENGTH = 32; // 256 bits
const SALT_LENGTH = 16;
const ALGORITHM = "PBKDF2";
const HASH_ALGORITHM = "SHA-256";

/** 비밀번호 → 해시 문자열 (salt:hash 형태) */
export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const key = await deriveKey(password, salt);
    const hash = await crypto.subtle.exportKey("raw", key);

    return `${bytesToHex(salt)}:${bytesToHex(new Uint8Array(hash))}`;
}

/** 비밀번호 검증 */
export async function verifyPassword(
    password: string,
    stored: string,
): Promise<boolean> {
    const [saltHex, hashHex] = stored.split(":");
    if (!saltHex || !hashHex) return false;

    const salt = hexToBytes(saltHex);
    const key = await deriveKey(password, salt);
    const hash = await crypto.subtle.exportKey("raw", key);
    const computed = bytesToHex(new Uint8Array(hash));

    return timingSafeEqual(computed, hashHex);
}

// ─── 내부 헬퍼 ───

async function deriveKey(
    password: string,
    salt: Uint8Array,
): Promise<CryptoKey> {
    const encoded = new TextEncoder().encode(password);
    const baseKey = await crypto.subtle.importKey(
        "raw",
        encoded,
        ALGORITHM,
        false,
        ["deriveBits", "deriveKey"],
    );

    return crypto.subtle.deriveKey(
        { name: ALGORITHM, salt: salt.buffer as ArrayBuffer, iterations: ITERATIONS, hash: HASH_ALGORITHM },
        baseKey,
        { name: "AES-GCM", length: KEY_LENGTH * 8 },
        true,
        ["encrypt"],
    );
}

/** 타이밍 공격 방지 비교 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
