// Cloudflare Worker 진입점
//  - scheduled: 매분 크론 → 수집기 실행
//  - fetch: 확인/설정용 작은 API (ADMIN_TOKEN 필요, /health 제외)

import { buildBoard, type BoardMatchRow } from "./board.ts";
import { runCollector } from "./collector.ts";
import type { SnapLevel } from "./estimate.ts";
import { matchUrl, PlabClient } from "./plab.ts";

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

interface RuleInput {
  name?: unknown;
  stadium_group_ids?: unknown;
  weekdays?: unknown;
  time_from?: unknown;
  time_to?: unknown;
  active?: unknown;
}

function validateRule(b: RuleInput): string | null {
  if (typeof b.name !== "string" || !b.name.trim()) return "name 필요";
  if (!Array.isArray(b.stadium_group_ids) || !b.stadium_group_ids.length ||
      !b.stadium_group_ids.every((x) => Number.isInteger(x) && x > 0)) return "stadium_group_ids: 양의 정수 배열";
  if (!Array.isArray(b.weekdays) || !b.weekdays.length ||
      !b.weekdays.every((x) => Number.isInteger(x) && x >= 0 && x <= 6)) return "weekdays: 0(일)~6(토) 배열";
  if (typeof b.time_from !== "string" || !TIME_RE.test(b.time_from)) return "time_from: 'HH:MM'";
  if (typeof b.time_to !== "string" || !TIME_RE.test(b.time_to)) return "time_to: 'HH:MM'";
  if (b.time_from > b.time_to) return "time_from <= time_to 이어야 함";
  return null;
}

function authorized(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const url = new URL(req.url);
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  return token === env.ADMIN_TOKEN;
}

export async function handleFetch(req: Request, env: Env, client = new PlabClient()): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") {
    const last = await env.DB.prepare("SELECT * FROM run_log ORDER BY ts DESC LIMIT 1").first();
    const tracking = await env.DB.prepare("SELECT COUNT(*) AS n FROM match WHERE tracking = 1").first<number>("n");
    return json({ ok: true, tracking, last_run: last });
  }
  if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);

  // --- 구장 검색: 규칙에 넣을 stadium_group id 찾기
  if (path === "/api/stadiums/search" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    if (q.trim().length < 2) return json({ error: "q는 2글자 이상" }, 400);
    return json(await client.searchStadiums(q));
  }

  // --- 관심 규칙
  if (path === "/api/rules" && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM watch_rule ORDER BY id").all();
    return json(results.map((r) => ({
      ...r,
      stadium_group_ids: JSON.parse(r.stadium_group_ids as string),
      weekdays: JSON.parse(r.weekdays as string),
    })));
  }
  if (path === "/api/rules" && req.method === "POST") {
    const b = (await req.json().catch(() => null)) as RuleInput | null;
    const err = b ? validateRule(b) : "JSON 본문 필요";
    if (err || !b) return json({ error: err }, 400);
    const row = await env.DB.prepare(
      `INSERT INTO watch_rule (name, stadium_group_ids, weekdays, time_from, time_to, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(
      (b.name as string).trim(), JSON.stringify(b.stadium_group_ids), JSON.stringify(b.weekdays),
      b.time_from, b.time_to, b.active === false ? 0 : 1, new Date().toISOString(),
    ).first<number>("id");
    return json({ id: row }, 201);
  }
  const ruleMatch = /^\/api\/rules\/(\d+)$/.exec(path);
  if (ruleMatch && req.method === "DELETE") {
    const res = await env.DB.prepare("DELETE FROM watch_rule WHERE id = ?").bind(Number(ruleMatch[1])).run();
    return json({ deleted: res.meta.changes ?? 0 });
  }

  // --- 매치 / 스냅샷 조회
  if (path === "/api/matches" && req.method === "GET") {
    const from = url.searchParams.get("from") ?? "0000-00-00";
    const to = url.searchParams.get("to") ?? "9999-99-99";
    const onlyTracking = url.searchParams.get("tracking") === "1";
    const { results } = await env.DB.prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM snapshot s WHERE s.match_id = m.id) AS snapshot_count
       FROM match m WHERE kst_date BETWEEN ? AND ? ${onlyTracking ? "AND tracking = 1" : ""}
       ORDER BY kst_date, kst_time, id`,
    ).bind(from, to).all<{ id: number }>();
    return json(results.map((m) => ({ ...m, url: matchUrl(m.id) })));
  }
  const snapMatch = /^\/api\/matches\/(\d+)\/snapshots$/.exec(path);
  if (snapMatch && req.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, ts, confirm, max_players, apply_status, lifecycle, average_level, average_level_num,
              pct_rookie, pct_beginner, pct_amateur, pct_semipro, pct_pro
       FROM snapshot WHERE match_id = ? ORDER BY ts, id`,
    ).bind(Number(snapMatch[1])).all();
    return json(results);
  }

  // --- 매치 보드: /api/board?date=YYYY-MM-DD&from=HH:MM&to=HH:MM
  if (path === "/api/board" && req.method === "GET") {
    const date = url.searchParams.get("date") ?? "";
    const from = url.searchParams.get("from") || "00:00";
    const to = url.searchParams.get("to") || "23:59";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "date=YYYY-MM-DD 필요" }, 400);
    if (!TIME_RE.test(from) && from !== "23:59") return json({ error: "from: 'HH:MM'" }, 400);
    if (!TIME_RE.test(to) && to !== "23:59") return json({ error: "to: 'HH:MM'" }, 400);

    const [{ results: rows }, { results: snaps }, { results: dates }, lastRun] = await env.DB.batch<any>([
      env.DB.prepare(
        `SELECT id, title, stadium_group, kst_date, kst_time, schedule, deadline_at, format, level_rule, level_code,
                sex, features, confirm, max_players, min_players, apply_status, average_level
         FROM match WHERE kst_date = ?`,
      ).bind(date),
      env.DB.prepare(
        `SELECT s.match_id, s.confirm, s.average_level, s.pct_rookie, s.pct_beginner, s.pct_amateur, s.pct_semipro, s.pct_pro
         FROM snapshot s JOIN match m ON m.id = s.match_id
         WHERE m.kst_date = ? ORDER BY s.match_id, s.ts, s.id`,
      ).bind(date),
      env.DB.prepare(
        `SELECT kst_date AS date, COUNT(*) AS matches FROM match
         WHERE kst_date >= ? GROUP BY kst_date ORDER BY kst_date`,
      ).bind(new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)),
      env.DB.prepare("SELECT ts FROM run_log ORDER BY ts DESC LIMIT 1"),
    ]);
    const byMatch = new Map<number, SnapLevel[]>();
    for (const s of snaps as (SnapLevel & { match_id: number })[]) {
      if (!byMatch.has(s.match_id)) byMatch.set(s.match_id, []);
      byMatch.get(s.match_id)!.push(s);
    }
    return json({
      filter: { date, from, to },
      updated_at: (lastRun.results[0] as { ts?: string } | undefined)?.ts ?? null,
      dates,
      items: buildBoard(rows as BoardMatchRow[], byMatch, { date, from, to }),
    });
  }

  // --- 실행 기록 / 수동 실행
  if (path === "/api/runs" && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM run_log ORDER BY ts DESC LIMIT 50").all();
    return json(results);
  }
  if (path === "/api/run" && req.method === "POST") {
    return json(await runCollector(env.DB, client));
  }

  return json({ error: "not found" }, 404);
}
