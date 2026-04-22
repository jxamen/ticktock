import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { devices, devicePermissions } from "@/lib/db/schema";
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
        </div>
    );
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
