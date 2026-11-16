// Worker 진입점: 크론(수집) + HTTP(보드 화면, API)
// 보드 HTML은 텍스트로 번들 (wrangler.toml [[rules]] Text)

import page from "../public/index.html";
import { runCollector } from "./collector.ts";
import { handleFetch, type Env } from "./index.ts";
import { PlabClient } from "./plab.ts";

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCollector(env.DB, new PlabClient(), new Date(controller.scheduledTime)).then((r) => {
        if (r.errors.length) console.error("collector errors", r.errors);
      }),
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
