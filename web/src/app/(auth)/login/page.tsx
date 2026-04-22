import { LoginForm } from "./LoginForm";

type Props = {
    searchParams: Promise<{ redirect?: string }>;
};

export default async function LoginPage({ searchParams }: Props) {
    const { redirect } = await searchParams;
    return (
        <div>
            <h2 className="mb-5 text-[18px] font-semibold text-heading">로그인</h2>
            <LoginForm redirectTo={redirect ?? "/devices"} />
            <p className="mt-5 text-center text-[13px] text-foreground-secondary">
                계정이 없으신가요?{" "}
                <a href="/signup" className="font-medium text-primary hover:underline">
                    회원가입
                </a>
            </p>
        </div>
    );
}
