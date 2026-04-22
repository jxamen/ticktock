"use client";

import { useSidebar } from "./SidebarContext";

type Props = {
    userEmail?: string;
    displayName?: string;
};

export function Header({ userEmail, displayName }: Props) {
    const { open, toggle } = useSidebar();
    const initial = (displayName || userEmail || "T").charAt(0).toUpperCase();

    return (
        <header className="fixed top-0 left-0 right-0 z-50 flex h-14 items-center justify-between border-b border-border bg-background px-4">
            {/* 좌측 — 햄버거 + 로고 */}
            <div className="flex items-center gap-3">
                <button
                    onClick={toggle}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-foreground-secondary transition-colors hover:bg-background-secondary hover:text-foreground"
                    aria-label={open ? "메뉴 닫기" : "메뉴 열기"}
                >
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                        <path d="M3 5H17" />
                        <path d="M3 10H17" />
                        <path d="M3 15H17" />
                    </svg>
                </button>
                <a href="/devices" className="flex items-center gap-1.5">
                    <span className="text-[15px] font-bold text-heading">TickTock</span>
                    <span className="text-[11px] text-foreground-secondary">관리 콘솔</span>
                </a>
            </div>

            {/* 우측 */}
            <div className="flex items-center gap-1">
                <a
                    href="/members"
                    className="rounded-lg px-3 py-1.5 text-[14px] text-foreground-secondary transition-colors hover:bg-background-secondary hover:text-foreground"
                >
                    사용자 관리
                </a>
                <a
                    href="/settings"
                    className="rounded-lg px-3 py-1.5 text-[14px] text-foreground-secondary transition-colors hover:bg-background-secondary hover:text-foreground"
                >
                    설정
                </a>
                <form action="/api/auth/logout" method="POST" className="ml-1">
                    <button
                        type="submit"
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground transition-opacity hover:opacity-80"
                        title={userEmail ? `로그아웃 (${userEmail})` : "로그아웃"}
                    >
                        {initial}
                    </button>
                </form>
            </div>
        </header>
    );
}
