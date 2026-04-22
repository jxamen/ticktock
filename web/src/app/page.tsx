import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { AUTH_COOKIE } from "@/lib/middleware/auth";

export default async function Root() {
    const store = await cookies();
    const token = store.get(AUTH_COOKIE)?.value;
    redirect(token ? "/devices" : "/login");
}
