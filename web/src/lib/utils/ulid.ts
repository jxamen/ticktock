/**
 * ULID 생성 유틸 — 외부 패키지 없이 crypto.randomUUID 기반으로 생성.
 * 정렬 가능한 시간 기반 고유 ID.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, len: number): string {
    let str = "";
    for (let i = len; i > 0; i--) {
        const mod = now % 32;
        str = ENCODING[mod] + str;
        now = (now - mod) / 32;
    }
    return str;
}

function encodeRandom(len: number): string {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let str = "";
    for (let i = 0; i < len; i++) {
        str += ENCODING[bytes[i] % 32];
    }
    return str;
}

export function generateUlid(): string {
    const time = encodeTime(Date.now(), 10);
    const random = encodeRandom(16);
    return time + random;
}
