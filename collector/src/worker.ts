// Worker 진입점: 크론(수집) + HTTP(보드 화면, API)
// 보드 HTML은 텍스트로 번들 (wrangler.toml [[rules]] Text)

import page from "../public/index.html";
import relayInstall from "../relay/install.ps1";
import relayScript from "../relay/plab-relay.ps1";
import icon192 from "../public/icons/icon-192.png";
import icon512 from "../public/icons/icon-512.png";
import appleIcon from "../public/icons/apple-touch-icon.png";
import { MANIFEST, SW_JS } from "./pwa.ts";

// 정적 파일: 경로 → [내용, 형식]
const STATIC: Record<string, [BodyInit, string]> = {
  "/sw.js": [SW_JS, "text/javascript; charset=utf-8"],
  "/manifest.webmanifest": [MANIFEST, "application/manifest+json; charset=utf-8"],
  "/icons/icon-192.png": [icon192, "image/png"],
  "/icons/icon-512.png": [icon512, "image/png"],
  "/icons/apple-touch-icon.png": [appleIcon, "image/png"],
  "/apple-touch-icon.png": [appleIcon, "image/png"],
};
import { makeDeliver, runAlerts } from "./alerts.ts";
import { runCollector } from "./collector.ts";
import { handleFetch, makeNtfyFetch, vapidOf, type Env } from "./index.ts";
import { PlabClient } from "./plab.ts";

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date(controller.scheduledTime);
    ctx.waitUntil(
      (async () => {
        try {
          const r = await runCollector(env.DB, new PlabClient(), now);
          if (r.errors.length) console.error("collector errors", r.errors);
        } catch (e) {
          console.error("collector failed", e);
        }
        // 수집 직후 알림 판단 (수집 실패와 상관없이 실행)
        const ntfyFetch = makeNtfyFetch(env);
        const a = await runAlerts(env.DB, ntfyFetch, now, makeDeliver(env.DB, ntfyFetch, vapidOf(env))).catch((e) => {
          console.error("alerts error", e);
          return null;
        });
        if (a && (a.sent || a.failed)) console.log("alerts", a);
      })(),
    );
  },
  fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return Promise.resolve(
        new Response(page, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        }),
      );
    }
    const st = req.method === "GET" ? STATIC[pathname] : undefined;
    if (st) {
      // 서비스워커는 매번 새로 확인해야 업데이트가 바로 반영됨
      const cache = pathname === "/sw.js" ? "no-cache" : "public, max-age=86400";
      return Promise.resolve(new Response(st[0], { headers: { "content-type": st[1], "cache-control": cache } }));
    }
    // PC 알림 발송기 설치 스크립트 (비밀값 없음, 공개)
    const ps = pathname === "/relay/install.ps1" ? relayInstall : pathname === "/relay/plab-relay.ps1" ? relayScript : null;
    if (req.method === "GET" && ps) {
      return Promise.resolve(new Response(ps, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" } }));
    }
    return handleFetch(req, env);
  },
} satisfies ExportedHandler<Env>;
