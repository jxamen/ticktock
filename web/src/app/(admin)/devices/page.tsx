import Link from "next/link";
import { requireSession } from "@/lib/session";
import { listDevicesWithSummary } from "@/lib/services/subscription/managed-user.service";

export default async function DevicesPage() {
    const { userId, db } = await requireSession();
    const rows = await listDevicesWithSummary(userId, { db });

    return (
        <div>
            <div className="mb-6 flex items-end justify-between">
                <div>
                    <h1 className="text-[22px] font-bold text-heading">디바이스</h1>
                    <p className="mt-1 text-[13px] text-foreground-secondary">
                        내가 관리하는 자녀 PC 목록
                    </p>
                </div>
            </div>

            {rows.length === 0 ? (
                <div className="rounded-xl border border-border bg-background p-10 text-center">
                    <p className="text-[14px] text-foreground-secondary">
                        아직 연결된 디바이스가 없습니다.
                    </p>
                    <p className="mt-1 text-[13px] text-muted">
                        자녀 PC 에서 TickTock 에이전트를 설치하고 페어링 코드를 입력하세요.
                    </p>
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-border bg-background">
                    <table className="w-full min-w-[640px] text-[14px]">
                        <thead className="text-[13px] text-foreground-secondary">
                            <tr className="border-b border-border-light">
                                <th className="px-4 py-3 text-left font-medium">이름</th>
                                <th className="px-4 py-3 text-left font-medium">내 권한</th>
                                <th className="px-4 py-3 text-left font-medium">자녀 계정</th>
                                <th className="px-4 py-3 text-left font-medium">에이전트</th>
                                <th className="px-4 py-3 text-left font-medium">마지막 접속</th>
                                <th className="px-4 py-3 text-right font-medium"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((d) => (
                                <tr key={d.id} className="border-b border-border-light last:border-0 hover:bg-background-secondary/60">
                                    <td className="px-4 py-3 font-medium text-heading">
                                        <Link href={`/devices/${d.id}`} className="hover:text-primary">
                                            {d.name}
                                        </Link>
                                    </td>
                                    <td className="px-4 py-3">
                                        <RoleBadge role={d.role as "owner" | "viewer"} />
                                    </td>
                                    <td className="px-4 py-3 tabular-nums">
                                        <span className="font-medium text-heading">{d.managedUsersActive}</span>
                                        <span className="text-muted"> / {d.managedUsersTotal}</span>
                                        <span className="ml-1 text-[12px] text-muted">활성/전체</span>
                                    </td>
                                    <td className="px-4 py-3 text-foreground-secondary">{d.agentVersion ?? "-"}</td>
                                    <td className="px-4 py-3 text-foreground-secondary tabular-nums">
                                        {d.lastSeenAt ? formatDateTime(d.lastSeenAt) : "-"}
                                    </td>
                                    <td className="px-4 py-3 text-right">
                                        <Link
                                            href={`/devices/${d.id}`}
                                            className="text-[12px] font-medium text-primary hover:underline"
                                        >
                                            관리하기 →
                                        </Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

function RoleBadge({ role }: { role: "owner" | "viewer" }) {
    if (role === "owner") {
        return (
            <span className="inline-flex rounded bg-primary-light px-2 py-0.5 text-[12px] font-medium text-primary">
                owner
            </span>
        );
    }
    return (
        <span className="inline-flex rounded bg-background-tertiary px-2 py-0.5 text-[12px] font-medium text-foreground-secondary">
            viewer
        </span>
    );
}

function formatDateTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString("ko-KR", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}
