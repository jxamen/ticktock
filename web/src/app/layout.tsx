import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "TickTock — 관리자",
    description: "자녀 PC 사용 시간 관리 콘솔",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="ko" className="h-full antialiased">
            <head>
                <link
                    rel="stylesheet"
                    as="style"
                    crossOrigin="anonymous"
                    href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
                />
            </head>
            <body className="min-h-full flex flex-col">
                {children}
            </body>
        </html>
    );
}
