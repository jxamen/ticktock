export default function DevicesPage() {
    return (
        <div>
            <div className="mb-6 flex items-end justify-between">
                <div>
                    <h1 className="text-[22px] font-bold text-heading">디바이스</h1>
                    <p className="mt-1 text-[13px] text-foreground-secondary">
                        내 계정에 연결된 자녀 PC 목록
                    </p>
                </div>
            </div>

            <div className="rounded-xl border border-border bg-background p-10 text-center">
                <p className="text-[14px] text-foreground-secondary">
                    아직 연결된 디바이스가 없습니다.
                </p>
                <p className="mt-1 text-[13px] text-muted">
                    자녀 PC 에서 TickTock 에이전트를 설치하고 페어링 코드를 입력하세요.
                </p>
            </div>
        </div>
    );
}
