/**
 * 인증 쿠키 빌더.
 * Cloudflare Workers / Edge 런타임에서 안전하게 동작하도록 raw 문자열을 반환한다.
 */
export function buildAuthCookie(name: string, value: string, expUnixSec: number): string {
    const expiresMs = expUnixSec * 1000;
    const expires = new Date(expiresMs).toUTCString();
    const parts = [
        `${name}=${value}`,
        "Path=/",
        `Expires=${expires}`,
        "HttpOnly",
        "SameSite=Lax",
    ];
    if (process.env.NODE_ENV === "production") {
        parts.push("Secure");
    }
    return parts.join("; ");
}

export function clearAuthCookie(name: string): string {
    const parts = [
        `${name}=`,
        "Path=/",
        "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=0",
    ];
    if (process.env.NODE_ENV === "production") {
        parts.push("Secure");
    }
    return parts.join("; ");
}
