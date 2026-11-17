// Worker 진입점: 크론(수집) + HTTP(보드 화면, API)
// 보드 HTML은 텍스트로 번들 (wrangler.toml [[rules]] Text)

import page from "../public/index.html";
import { ntfyFetchWith, runAlerts } from "./alerts.ts";
import { runCollector } from "./collector.ts";
import { handleFetch, type Env } from "./index.ts";
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
        const a = await runAlerts(env.DB, ntfyFetchWith(env.NTFY_TOKEN), now).catch((e) => {
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
    return handleFetch(req, env);
  },
} satisfies ExportedHandler<Env>;
