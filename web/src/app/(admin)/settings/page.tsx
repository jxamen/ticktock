import { requireSession } from "@/lib/session";
import { getMySeats } from "@/lib/services/plan/plan.service";
import { getMe } from "@/lib/services/auth/auth.service";
import { SeatLimitForm } from "./SeatLimitForm";

export default async function SettingsPage() {
    const { userId, db, env } = await requireSession();
    const [me, seats] = await Promise.all([
        getMe(userId, { db, kv: env.CACHE, jwtSecret: env.JWT_SECRET }),
        getMySeats(userId, { db }),
    ]);

    return (
        <div>
            <div className="mb-6">
                <h1 className="text-[22px] font-bold text-heading">설정</h1>
                <p className="mt-1 text-[13px] text-foreground-secondary">
                    계정과 플랜을 관리합니다
                </p>
            </div>

            <section className="mb-6 rounded-xl border border-border bg-background p-5">
                <h2 className="mb-4 text-[16px] font-semibold text-heading">내 계정</h2>
                <dl className="grid grid-cols-1 gap-4 text-[14px] sm:grid-cols-2">
                    <Row label="이메일" value={me.email} />
                    <Row label="이름" value={me.displayName} />
                    <Row label="휴대폰" value={me.phone || "미등록"} />
                    <Row label="가입일" value={formatDate(me.createdAt)} />
                </dl>
            </section>

            <section className="rounded-xl border border-border bg-background p-5">
                <div className="mb-4 flex items-start justify-between">
                    <div>
                        <h2 className="text-[16px] font-semibold text-heading">플랜 · Seat</h2>
                        <p className="mt-1 text-[13px] text-foreground-secondary">
                            한 seat 당 자녀 Windows 계정 1개
                        </p>
                    </div>
                    <div className="text-right tabular-nums">
                        <div className="text-[20px] font-bold text-heading">
                            {seats.used}
                            <span className="text-[14px] font-normal text-foreground-secondary">
                                {" "}
                                / {seats.seatLimit}
                            </span>
                        </div>
                        <div className="text-[12px] text-muted">사용 중</div>
                    </div>
                </div>

                {seats.seats.length > 0 && (
                    <div className="mb-5 grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
                        {seats.seats.map((s) => (
                            <div
                                key={s.managedUserId}
                                className="flex items-center justify-between rounded-lg border border-border-light px-3 py-2"
                            >
                                <div>
                                    <div className="font-medium text-heading">{s.displayName}</div>
                                    <div className="text-[12px] text-muted">
                                        {s.deviceName} · {s.windowsUsername}
                                    </div>
                                </div>
                                <span
                                    className={`rounded px-2 py-0.5 text-[12px] font-medium ${
                                        s.subscriptionActive
                                            ? "bg-success-light text-success"
                                            : "bg-error-light text-error"
                                    }`}
                                >
                                    {s.subscriptionActive ? "활성" : "만료"}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                <SeatLimitForm current={seats.seatLimit} used={seats.used} />
            </section>
        </div>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <dt className="text-[12px] font-medium text-muted">{label}</dt>
            <dd className="mt-0.5 text-[14px] text-foreground">{value}</dd>
        </div>
    );
}

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("ko-KR");
}
