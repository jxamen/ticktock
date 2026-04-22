"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = { current: number; used: number };

export function SeatLimitForm({ current, used }: Props) {
    const router = useRouter();
    const [value, setValue] = useState<number>(current);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ type: "error" | "success"; text: string } | null>(null);

    async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setMsg(null);
        setBusy(true);
        try {
            const res = await fetch("/api/v1/me/seat-limit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ seatLimit: value }),
            });
            if (!res.ok) {
                const j = (await res.json().catch(() => null)) as
                    | { error?: { message?: string } }
                    | null;
                setMsg({ type: "error", text: j?.error?.message ?? "변경에 실패했습니다" });
                return;
            }
            setMsg({ type: "success", text: "저장되었습니다" });
            router.refresh();
        } finally {
            setBusy(false);
        }
    }

    const willDrop = value < used;

    return (
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3 border-t border-border-light pt-4">
            <div className="flex-1 min-w-[180px]">
                <label className="block">
                    <span className="mb-1.5 block text-[13px] font-medium text-foreground">
                        seat 한도
                    </span>
                    <input
                        type="number"
                        min={1}
                        max={100}
                        value={value}
                        onChange={(e) => setValue(Number(e.target.value))}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-[14px] text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                </label>
                {willDrop && (
                    <p className="mt-1 text-[12px] text-warning">
                        현재 사용 중인 {used} 개보다 낮습니다. 기존 자녀 계정은 유지되지만 추가 등록이 막힙니다.
                    </p>
                )}
            </div>
            <button
                type="submit"
                disabled={busy || value === current}
                className="rounded-lg bg-primary px-4 py-2.5 text-[14px] font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-40"
            >
                {busy ? "저장 중..." : "저장"}
            </button>
            {msg && (
                <span
                    className={`text-[13px] ${
                        msg.type === "error" ? "text-error" : "text-success"
                    }`}
                >
                    {msg.text}
                </span>
            )}
        </form>
    );
}
