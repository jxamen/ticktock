"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSidebar } from "./SidebarContext";

type NavItem = {
    label: string;
    href: string;
    icon: React.ReactNode;
};

type NavGroup = {
    title?: string;
    items: NavItem[];
};

/* ─── 아이콘 (토스 스타일 — 연한 배경 + 진한 선) ─── */

function DevicesIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-primary">
            <rect x="2.5" y="4" width="15" height="10" rx="1.5" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.3" />
            <path d="M7 17H13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M10 14V17" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
    );
}

function ScheduleIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-accent-indigo">
            <circle cx="10" cy="10" r="7.5" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.3" />
            <path d="M10 5.5V10L13 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
    );
}

function UsageIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-accent-green">
            <rect x="2.5" y="11" width="4" height="7" rx="1" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1" />
            <rect x="8" y="6" width="4" height="12" rx="1" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1" />
            <rect x="13.5" y="8.5" width="4" height="9.5" rx="1" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1" />
        </svg>
    );
}

function CommandsIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-accent-orange">
            <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.3" />
            <path d="M5.5 7.5L7.5 9.5L5.5 11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9 12H14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
    );
}

function MembersIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-accent-sky">
            <circle cx="10" cy="7" r="3.5" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.3" />
            <path d="M3.5 17.5C3.5 14.19 6.19 11.5 9.5 11.5H10.5C13.81 11.5 16.5 14.19 16.5 17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}

function AuditIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-accent-gray">
            <path d="M4 3.5H12L16 7.5V16.5C16 17.05 15.55 17.5 15 17.5H4C3.45 17.5 3 17.05 3 16.5V4.5C3 3.95 3.45 3.5 4 3.5Z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.3" />
            <path d="M12 3.5V7.5H16" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <path d="M6 11H13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M6 14H11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
    );
}

function SettingsIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-accent-gray">
            <circle cx="10" cy="10" r="2.5" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.3" />
            <path d="M10 3V5M10 15V17M3 10H5M15 10H17M5.22 5.22L6.64 6.64M13.36 13.36L14.78 14.78M5.22 14.78L6.64 13.36M13.36 6.64L14.78 5.22" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
    );
}

/* ─── 네비게이션 구성 ─── */

const NAV_GROUPS: NavGroup[] = [
    {
        title: "관리",
        items: [
            { label: "디바이스", href: "/devices", icon: <DevicesIcon /> },
            { label: "스케줄", href: "/schedule", icon: <ScheduleIcon /> },
            { label: "사용량", href: "/usage", icon: <UsageIcon /> },
            { label: "명령 히스토리", href: "/commands", icon: <CommandsIcon /> },
        ],
    },
    {
        title: "계정",
        items: [
            { label: "사용자 관리", href: "/members", icon: <MembersIcon /> },
            { label: "감사 로그", href: "/audit-logs", icon: <AuditIcon /> },
            { label: "설정", href: "/settings", icon: <SettingsIcon /> },
        ],
    },
];

export function Sidebar() {
    const { open } = useSidebar();
    const pathname = usePathname();

    return (
        <aside
            className={`fixed top-14 left-0 bottom-0 z-40 flex flex-col border-r border-sidebar-border bg-sidebar-bg transition-[width] duration-200 ${
                open ? "w-[240px]" : "w-0 overflow-hidden"
            }`}
        >
            <nav className="flex-1 overflow-y-auto py-4">
                {NAV_GROUPS.map((group, idx) => (
                    <div key={idx} className={idx > 0 ? "mt-6" : ""}>
                        {group.title && (
                            <div className="px-4 pb-1 text-[11px] font-medium uppercase tracking-wider text-sidebar-heading">
                                {group.title}
                            </div>
                        )}
                        <ul>
                            {group.items.map((item) => {
                                const active =
                                    pathname === item.href ||
                                    (item.href !== "/" && pathname.startsWith(item.href));
                                return (
                                    <li key={item.href}>
                                        <Link
                                            href={item.href}
                                            className={`mx-2 my-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] transition-colors ${
                                                active
                                                    ? "bg-sidebar-bg-active font-semibold text-sidebar-fg-active"
                                                    : "text-sidebar-fg hover:bg-sidebar-bg-hover"
                                            }`}
                                        >
                                            <span className="flex h-5 w-5 items-center justify-center">{item.icon}</span>
                                            <span>{item.label}</span>
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                ))}
            </nav>

            <div className="border-t border-sidebar-border px-4 py-3 text-[11px] text-sidebar-heading">
                TickTock v0.1.6
            </div>
        </aside>
    );
}
