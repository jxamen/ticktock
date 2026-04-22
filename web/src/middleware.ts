import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/middleware/auth";

/**
 * Edge middleware — 인증 쿠키가 없으면 (admin) 영역을 /login 으로 리다이렉트.
 * 실제 JWT 서명 검증은 API Route / Server Component 에서 수행한다
 * (미들웨어는 Workers runtime 보다 훨씬 제한적이라 JWT 검증을 여기서 하지 않는다).
 */

const PROTECTED_PREFIXES = ["/devices", "/schedule", "/usage", "/commands", "/members", "/settings"];
const AUTH_PREFIXES = ["/login", "/signup"];

export function middleware(req: NextRequest) {
    const { pathname } = req.nextUrl;
    const token = req.cookies.get(AUTH_COOKIE)?.value;

    if (PROTECTED_PREFIXES.some((p) => pathname.startsWith(p)) && !token) {
        const url = req.nextUrl.clone();
        url.pathname = "/login";
        url.searchParams.set("redirect", pathname);
        return NextResponse.redirect(url);
    }

    if (AUTH_PREFIXES.some((p) => pathname === p) && token) {
        const url = req.nextUrl.clone();
        url.pathname = "/devices";
        return NextResponse.redirect(url);
    }

    return NextResponse.next();
}

export const config = {
    matcher: [
        /*
         * 정적 파일·API·Next internals 는 미들웨어 스킵
         * /api/* 는 API Route 내부에서 자체 인증
         */
        "/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)",
    ],
};
