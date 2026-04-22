export default function AuthLayout({ children }: { children: React.ReactNode }) {
    return (
        <main className="flex min-h-screen items-center justify-center bg-background-secondary px-4">
            <div className="w-full max-w-[420px]">
                <div className="mb-8 text-center">
                    <h1 className="text-[22px] font-bold text-heading">TickTock</h1>
                    <p className="mt-1 text-[13px] text-foreground-secondary">
                        자녀 PC 사용 시간 관리 콘솔
                    </p>
                </div>
                <div className="rounded-xl border border-border bg-background p-6 shadow-sm">
                    {children}
                </div>
            </div>
        </main>
    );
}
