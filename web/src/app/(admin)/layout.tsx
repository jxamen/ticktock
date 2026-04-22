import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/env";
import { verifyJwt } from "@/lib/utils/jwt";
import { getMe } from "@/lib/services/auth/auth.service";
import { AUTH_COOKIE } from "@/lib/middleware/auth";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { SidebarProvider } from "@/components/layout/SidebarContext";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    const cookieStore = await cookies();
    const token = cookieStore.get(AUTH_COOKIE)?.value;
    if (!token) redirect("/login");

    const { db, env } = await getEnv();
    const payload = await verifyJwt(token, env.JWT_SECRET);
    if (!payload) redirect("/login");

    const revoked = await env.CACHE.get(`session:blacklist:${payload.jti}`);
    if (revoked) redirect("/login");

    const me = await getMe(payload.sub, {
        db,
        kv: env.CACHE,
        jwtSecret: env.JWT_SECRET,
    });

    return (
        <SidebarProvider>
            <Header userEmail={me.email} displayName={me.displayName} />
            <Sidebar />
            <main className="pt-14 transition-[padding] duration-200 lg:pl-[240px]">
                <div className="mx-auto max-w-[1440px] px-4 py-6 md:px-6">{children}</div>
            </main>
        </SidebarProvider>
    );
}
