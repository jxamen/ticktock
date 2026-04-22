"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = { redirectTo: string };

export function LoginForm({ redirectTo }: Props) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setError(null);

        const form = e.currentTarget;
        const fd = new FormData(form);
        const payload = {
            email: String(fd.get("email") ?? "").trim(),
            password: String(fd.get("password") ?? ""),
        };

        const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const body = (await res.json().catch(() => null)) as
                | { error?: { message?: string } }
                | null;
            setError(body?.error?.message ?? "로그인에 실패했습니다");
            return;
        }

        startTransition(() => {
            router.replace(redirectTo);
            router.refresh();
        });
    }

    return (
        <form onSubmit={onSubmit} className="space-y-4">
            <Field label="이메일">
                <input
                    type="email"
                    name="email"
                    required
                    autoComplete="email"
                    className={inputClass}
                    placeholder="you@example.com"
                />
            </Field>
            <Field label="비밀번호">
                <input
                    type="password"
                    name="password"
                    required
                    autoComplete="current-password"
                    className={inputClass}
                    placeholder="8자 이상"
                />
            </Field>

            {error && (
                <div className="rounded-lg bg-error-light px-3 py-2 text-[13px] text-error">
                    {error}
                </div>
            )}

            <button
                type="submit"
                disabled={pending}
                className="w-full rounded-lg bg-primary py-3 text-[14px] font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
            >
                {pending ? "처리 중..." : "로그인"}
            </button>
        </form>
    );
}

const inputClass =
    "w-full rounded-lg border border-border bg-background px-3 py-2.5 text-[14px] text-foreground outline-none transition-all placeholder:text-muted focus:border-primary focus:ring-2 focus:ring-primary/20";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-foreground">{label}</span>
            {children}
        </label>
    );
}
