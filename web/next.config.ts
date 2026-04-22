import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

if (process.env.NODE_ENV === "development") {
    initOpenNextCloudflareForDev();
}

const nextConfig: NextConfig = {
    /* Cloudflare Pages 배포를 위한 설정 */
    allowedDevOrigins: ["busan.local", "client.local", "media.local"],
};

export default nextConfig;
