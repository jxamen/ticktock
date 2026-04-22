import { SignupForm } from "./SignupForm";

export default function SignupPage() {
    return (
        <div>
            <h2 className="mb-5 text-[18px] font-semibold text-heading">회원가입</h2>
            <SignupForm />
            <p className="mt-5 text-center text-[13px] text-foreground-secondary">
                이미 계정이 있으신가요?{" "}
                <a href="/login" className="font-medium text-primary hover:underline">
                    로그인
                </a>
            </p>
        </div>
    );
}
