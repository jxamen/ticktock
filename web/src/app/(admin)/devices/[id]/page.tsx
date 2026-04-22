import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { commandsIssued, devices, devicePermissions, users } from "@/lib/db/schema";
import {
    listManagedUsers,
    assertDeviceViewer,
} from "@/lib/services/subscription/managed-user.service";
import { ManagedUsersSection } from "./ManagedUsersSection";

type Props = { params: Promise<{ id: string }> };

export default async function DeviceDetailPage({ params }: Props) {
    const { id: deviceId } = await params;
    const { userId, db } = await requireSession();

    try {
        await assertDeviceViewer(userId, deviceId, { db });
    } catch {
        notFound();
    }

    const device = await db
        .select()
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.isActive, true)))
        .get();
    if (!device) notFound();

    const myPerm = await db
        .select({ role: devicePermissions.role })
        .from(devicePermissions)
        .where(and(eq(devicePermissions.userId, userId), eq(devicePermissions.deviceId, deviceId)))
        .get();
    const isOwner = myPerm?.role === "owner";

    const managedUsersRows = await listManagedUsers(userId, deviceId, { db });

    const recentCommands = managedUsersRows.length
        ? await db
              .select({
                  id: commandsIssued.id,
                  managedUserId: commandsIssued.managedUserId,
                  type: commandsIssued.type,
                  status: commandsIssued.status,
                  issuedAt: commandsIssued.issuedAt,
                  actorEmail: users.email,
                  actorDisplayName: users.displayName,
              })
              .from(commandsIssued)
              .innerJoin(users, eq(commandsIssued.issuedBy, users.id))
              .where(
                  inArray(
                      commandsIssued.managedUserId,
                      managedUsersRows.map((m) => m.id),
                  ),
              )
              .orderBy(desc(commandsIssued.issuedAt))
              .limit(20)
              .all()
        : [];

    return (
        <div>
            <nav className="mb-4 text-[13px] text-foreground-secondary">
                <Link href="/devices" className="hover:text-primary">
                    디바이스
                </Link>
                <span className="mx-2">/</span>
                <span className="text-heading">{device.name}</span>
            </nav>

            <div className="mb-6 flex items-end justify-between">
                <div>
                    <h1 className="text-[22px] font-bold text-heading">{device.name}</h1>
                    <p className="mt-1 text-[13px] text-foreground-secondary">
                        에이전트 {device.agentVersion ?? "미설치"} ·{" "}
                        {device.lastSeenAt
                            ? `마지막 접속 ${formatRelative(device.lastSeenAt)}`
                            : "오프라인"}
                    </p>
                </div>
            </div>

            <ManagedUsersSection
                deviceId={deviceId}
                canManage={isOwner}
                initialRows={managedUsersRows.map((r) => ({
                    id: r.id,
                    windowsUsername: r.windowsUsername,
                    displayName: r.displayName,
                    subscriptionStatus: r.subscriptionStatus,
                    subscriptionExpiresAt: r.subscriptionExpiresAt,
                    createdAt: r.createdAt,
                }))}
            />

            {recentCommands.length > 0 && (
                <section className="mt-8">
                    <h2 className="mb-3 text-[16px] font-semibold text-heading">최근 명령</h2>
                    <div className="overflow-x-auto rounded-xl border border-border bg-background">
                        <table className="w-full min-w-[560px] text-[14px]">
                            <thead className="text-[13px] text-foreground-secondary">
                                <tr className="border-b border-border-light">
                                    <th className="px-4 py-3 text-left font-medium">시각</th>
                                    <th className="px-4 py-3 text-left font-medium">대상</th>
                                    <th className="px-4 py-3 text-left font-medium">명령</th>
                                    <th className="px-4 py-3 text-left font-medium">상태</th>
                                    <th className="px-4 py-3 text-left font-medium">발행자</th>
                                </tr>
                            </thead>
                            <tbody>
                                {recentCommands.map((c) => {
                                    const mu = managedUsersRows.find((m) => m.id === c.managedUserId);
                                    return (
                                        <tr
                                            key={c.id}
                                            className="border-b border-border-light last:border-0"
                                        >
                                            <td className="px-4 py-3 text-foreground-secondary tabular-nums">
                                                {formatDateTime(c.issuedAt)}
                                            </td>
                                            <td className="px-4 py-3 font-medium text-heading">
                                                {mu?.displayName ?? "-"}
                                            </td>
                                            <td className="px-4 py-3">
                                                <CommandBadge type={c.type} />
                                            </td>
                                            <td className="px-4 py-3">
                                                <StatusBadge status={c.status} />
                                            </td>
                                            <td className="px-4 py-3 text-foreground-secondary">
                                                {c.actorDisplayName}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
        </div>
    );
}

function CommandBadge({ type }: { type: string }) {
    const label: Record<string, string> = {
        lock: "잠금",
        unlock: "해제",
        set_pin: "PIN 변경",
        grant_bonus: "보너스",
    };
    const tone: Record<string, string> = {
        lock: "bg-error-light text-error",
        unlock: "bg-success-light text-success",
        set_pin: "bg-primary-light text-primary",
        grant_bonus: "bg-warning-light text-warning",
    };
    return (
        <span className={`inline-flex rounded px-2 py-0.5 text-[12px] font-medium ${tone[type] ?? "bg-background-tertiary text-foreground-secondary"}`}>
            {label[type] ?? type}
        </span>
    );
}

function StatusBadge({ status }: { status: string }) {
    const label: Record<string, string> = {
        pending: "대기",
        delivered: "전달됨",
        consumed: "수신됨",
        failed: "실패",
        canceled: "취소",
    };
    const tone: Record<string, string> = {
        pending: "bg-background-tertiary text-foreground-secondary",
        delivered: "bg-info-light text-info",
        consumed: "bg-success-light text-success",
        failed: "bg-error-light text-error",
        canceled: "bg-background-tertiary text-muted",
    };
    return (
        <span className={`inline-flex rounded px-2 py-0.5 text-[12px] font-medium ${tone[status] ?? ""}`}>
            {label[status] ?? status}
        </span>
    );
}

function formatDateTime(iso: string) {
    const d = new Date(iso);
    return d.toLocaleString("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function formatRelative(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "방금 전";
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    const days = Math.floor(hours / 24);
    return `${days}일 전`;
}
