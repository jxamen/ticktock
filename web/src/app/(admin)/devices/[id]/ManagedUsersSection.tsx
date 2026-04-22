"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type ManagedUser = {
    id: string;
    windowsUsername: string;
    displayName: string;
    subscriptionStatus: "active" | "expired";
    subscriptionExpiresAt: string | null;
    createdAt: string;
};

type Props = {
    deviceId: string;
    canManage: boolean;
    initialRows: ManagedUser[];
};

const UNLIMITED_THRESHOLD = new Date("2099-01-01T00:00:00.000Z").getTime();

export function ManagedUsersSection({ deviceId, canManage, initialRows }: Props) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [addOpen, setAddOpen] = useState(false);
    const [extendTarget, setExtendTarget] = useState<ManagedUser | null>(null);

    function refresh() {
        startTransition(() => router.refresh());
    }

    return (
        <section>
            <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[16px] font-semibold text-heading">자녀 계정</h2>
                {canManage && (
                    <button
                        type="button"
                        onClick={() => setAddOpen(true)}
                        className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
                    >
                        + 자녀 계정 추가
                    </button>
                )}
            </div>

            {initialRows.length === 0 ? (
                <div className="rounded-xl border border-border bg-background p-10 text-center">
                    <p className="text-[14px] text-foreground-secondary">아직 자녀 계정이 없습니다.</p>
                    {canManage && (
                        <p className="mt-1 text-[13px] text-muted">
                            &quot;자녀 계정 추가&quot; 로 Windows 사용자명을 등록하세요.
                        </p>
                    )}
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {initialRows.map((r) => (
                        <ManagedUserCard
                            key={r.id}
                            row={r}
                            canManage={canManage}
                            onExtend={() => setExtendTarget(r)}
                            onRefresh={refresh}
                        />
                    ))}
                </div>
            )}

            {isPending && (
                <p className="mt-3 text-[12px] text-muted">업데이트 중...</p>
            )}

            {addOpen && (
                <AddManagedUserModal
                    deviceId={deviceId}
                    onClose={() => setAddOpen(false)}
                    onSuccess={() => {
                        setAddOpen(false);
                        refresh();
                    }}
                />
            )}

            {extendTarget && (
                <ExtendModal
                    target={extendTarget}
                    onClose={() => setExtendTarget(null)}
                    onSuccess={() => {
                        setExtendTarget(null);
                        refresh();
                    }}
                />
            )}
        </section>
    );
}

function ManagedUserCard({
    row,
    canManage,
    onExtend,
    onRefresh,
}: {
    row: ManagedUser;
    canManage: boolean;
    onExtend: () => void;
    onRefresh: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const isUnlimited =
        row.subscriptionExpiresAt !== null &&
        new Date(row.subscriptionExpiresAt).getTime() >= UNLIMITED_THRESHOLD;

    async function action(path: string, body?: object) {
        if (!confirm("진행하시겠습니까?")) return;
        setBusy(true);
        try {
            const res = await fetch(path, {
                method: path.endsWith("/managed-users/" + row.id) ? "DELETE" : "POST",
                headers: body ? { "Content-Type": "application/json" } : {},
                body: body ? JSON.stringify(body) : undefined,
            });
            if (!res.ok) {
                const j = (await res.json().catch(() => null)) as
                    | { error?: { message?: string } }
                    | null;
                alert(j?.error?.message ?? "요청 실패");
                return;
            }
            onRefresh();
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="rounded-xl border border-border bg-background p-4">
            <div className="flex items-start justify-between">
                <div>
                    <div className="text-[15px] font-semibold text-heading">{row.displayName}</div>
                    <div className="mt-0.5 text-[12px] text-muted font-mono">{row.windowsUsername}</div>
                </div>
                <StatusBadge status={row.subscriptionStatus} />
            </div>

            <div className="mt-4 border-t border-border-light pt-3 text-[13px]">
                <div className="flex justify-between">
                    <span className="text-foreground-secondary">만료</span>
                    <span className="tabular-nums font-medium text-heading">
                        {row.subscriptionExpiresAt === null
                            ? "미시작"
                            : isUnlimited
                              ? "무제한"
                              : formatDate(row.subscriptionExpiresAt)}
                    </span>
                </div>
                {!isUnlimited && row.subscriptionExpiresAt !== null && (
                    <div className="mt-1 flex justify-between">
                        <span className="text-foreground-secondary">남은 기간</span>
                        <span className="tabular-nums text-foreground-secondary">
                            {formatRemaining(row.subscriptionExpiresAt)}
                        </span>
                    </div>
                )}
            </div>

            {canManage && (
                <div className="mt-4 flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={onExtend}
                        disabled={busy}
                        className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
                    >
                        연장
                    </button>
                    <button
                        type="button"
                        onClick={() =>
                            action(
                                `/api/v1/managed-users/${row.id}/subscription/admin-grant`,
                                { note: "관리자 무제한 부여" },
                            )
                        }
                        disabled={busy}
                        className="rounded-lg border border-border px-3 py-1.5 text-[12px] font-semibold text-foreground hover:bg-background-secondary disabled:opacity-60"
                    >
                        무제한
                    </button>
                    <button
                        type="button"
                        onClick={() =>
                            action(
                                `/api/v1/managed-users/${row.id}/subscription/revoke`,
                                {},
                            )
                        }
                        disabled={busy || row.subscriptionStatus === "expired"}
                        className="rounded-lg border border-border px-3 py-1.5 text-[12px] font-semibold text-foreground-secondary hover:bg-background-secondary disabled:opacity-40"
                    >
                        구독 취소
                    </button>
                    <button
                        type="button"
                        onClick={() => action(`/api/v1/managed-users/${row.id}`)}
                        disabled={busy}
                        className="ml-auto rounded-lg border border-error/30 px-3 py-1.5 text-[12px] font-semibold text-error hover:bg-error-light disabled:opacity-60"
                    >
                        삭제
                    </button>
                </div>
            )}
        </div>
    );
}

function StatusBadge({ status }: { status: "active" | "expired" }) {
    if (status === "active") {
        return (
            <span className="inline-flex rounded bg-success-light px-2 py-0.5 text-[12px] font-medium text-success">
                활성
            </span>
        );
    }
    return (
        <span className="inline-flex rounded bg-error-light px-2 py-0.5 text-[12px] font-medium text-error">
            만료
        </span>
    );
}

function AddManagedUserModal({
    deviceId,
    onClose,
    onSuccess,
}: {
    deviceId: string;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        const fd = new FormData(e.currentTarget);
        const payload = {
            windowsUsername: String(fd.get("windowsUsername") ?? "").trim(),
            displayName: String(fd.get("displayName") ?? "").trim(),
        };
        try {
            const res = await fetch(`/api/v1/devices/${deviceId}/managed-users`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const j = (await res.json().catch(() => null)) as
                    | { error?: { message?: string } }
                    | null;
                setError(j?.error?.message ?? "추가에 실패했습니다");
                return;
            }
            onSuccess();
        } finally {
            setBusy(false);
        }
    }

    return (
        <ModalShell onClose={onClose} title="자녀 계정 추가">
            <form onSubmit={onSubmit} className="space-y-3">
                <Field label="Windows 사용자명">
                    <input
                        name="windowsUsername"
                        required
                        maxLength={64}
                        pattern="[a-zA-Z0-9._\-]+"
                        className={inputClass}
                        placeholder="예: child1"
                    />
                </Field>
                <Field label="표시 이름">
                    <input
                        name="displayName"
                        required
                        maxLength={50}
                        className={inputClass}
                        placeholder="예: 큰아들"
                    />
                </Field>
                {error && (
                    <div className="rounded-lg bg-error-light px-3 py-2 text-[13px] text-error">
                        {error}
                    </div>
                )}
                <div className="mt-4 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-background-secondary"
                    >
                        취소
                    </button>
                    <button
                        type="submit"
                        disabled={busy}
                        className="rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
                    >
                        {busy ? "추가 중..." : "추가"}
                    </button>
                </div>
            </form>
        </ModalShell>
    );
}

function ExtendModal({
    target,
    onClose,
    onSuccess,
}: {
    target: ManagedUser;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [months, setMonths] = useState<1 | 3 | 12>(1);
    const [amount, setAmount] = useState<number>(0);
    const [note, setNote] = useState("");

    async function onSubmit() {
        setError(null);
        setBusy(true);
        try {
            const res = await fetch(`/api/v1/managed-users/${target.id}/subscription/extend`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ months, amountKrw: amount, note: note || undefined }),
            });
            if (!res.ok) {
                const j = (await res.json().catch(() => null)) as
                    | { error?: { message?: string } }
                    | null;
                setError(j?.error?.message ?? "연장에 실패했습니다");
                return;
            }
            onSuccess();
        } finally {
            setBusy(false);
        }
    }

    return (
        <ModalShell onClose={onClose} title={`${target.displayName} 구독 연장`}>
            <div className="space-y-4">
                <div>
                    <div className="mb-2 text-[13px] font-medium text-foreground">기간</div>
                    <div className="flex gap-2">
                        {([1, 3, 12] as const).map((m) => (
                            <button
                                key={m}
                                type="button"
                                onClick={() => setMonths(m)}
                                className={`flex-1 rounded-lg border px-3 py-2.5 text-[13px] font-medium transition-colors ${
                                    months === m
                                        ? "border-primary bg-primary-light text-primary"
                                        : "border-border text-foreground hover:bg-background-secondary"
                                }`}
                            >
                                {m === 12 ? "1년" : `${m}개월`}
                            </button>
                        ))}
                    </div>
                </div>
                <Field label="결제 금액 (KRW, 선택)">
                    <input
                        type="number"
                        min={0}
                        step={100}
                        value={amount}
                        onChange={(e) => setAmount(Number(e.target.value) || 0)}
                        className={inputClass}
                    />
                </Field>
                <Field label="메모 (선택)">
                    <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        maxLength={500}
                        className={inputClass}
                        placeholder="예: 수동 결제 확인됨"
                    />
                </Field>
                {error && (
                    <div className="rounded-lg bg-error-light px-3 py-2 text-[13px] text-error">
                        {error}
                    </div>
                )}
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-background-secondary"
                    >
                        취소
                    </button>
                    <button
                        type="button"
                        onClick={onSubmit}
                        disabled={busy}
                        className="rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
                    >
                        {busy ? "처리 중..." : "연장"}
                    </button>
                </div>
            </div>
        </ModalShell>
    );
}

function ModalShell({
    title,
    onClose,
    children,
}: {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
}) {
    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
            onClick={onClose}
        >
            <div
                className="w-[calc(100%-2rem)] max-w-[420px] rounded-xl bg-background p-5 shadow-lg"
                onClick={(e) => e.stopPropagation()}
            >
                <h3 className="mb-4 text-[16px] font-semibold text-heading">{title}</h3>
                {children}
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-foreground">{label}</span>
            {children}
        </label>
    );
}

const inputClass =
    "w-full rounded-lg border border-border bg-background px-3 py-2.5 text-[14px] text-foreground outline-none transition-all placeholder:text-muted focus:border-primary focus:ring-2 focus:ring-primary/20";

function formatDate(iso: string) {
    const d = new Date(iso);
    return d.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function formatRemaining(iso: string) {
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return "만료됨";
    const days = Math.ceil(diff / (86400 * 1000));
    if (days < 30) return `${days}일`;
    const months = Math.floor(days / 30);
    return `약 ${months}개월 (${days}일)`;
}
