// Cloudflare Worker 진입점
//  - scheduled: 매분 크론 → 수집기 실행
//  - fetch: 보드 API(공개) + 관리 API (ADMIN_TOKEN 필요)

import { ntfyFetchWith, sendNtfy, TOPIC_RE } from "./alerts.ts";
import { buildBoard, type BoardMatchRow } from "./board.ts";
import { runCollector } from "./collector.ts";
import { estimateLevel, levelBucket, type SnapLevel } from "./estimate.ts";
import { matchUrl, PlabClient, type FetchFn } from "./plab.ts";

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
  /** ntfy.sh 계정 액세스 토큰 (wrangler secret / 대시보드에서 설정) */
  NTFY_TOKEN?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }, // 화면과 같은 주소에서만 쓰므로 CORS 없음
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

/** 관리 API 인증: Authorization: Bearer <ADMIN_TOKEN> 만 받음 (쿼리 문자열은 로그·기록에 남아서 안 받음) */
function authorized(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return timingSafeEqual(header.slice(7), env.ADMIN_TOKEN);
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function handleFetch(
  req: Request,
  env: Env,
  client = new PlabClient(),
  ntfyFetch: FetchFn = ntfyFetchWith(env.NTFY_TOKEN),
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") {
    const last = await env.DB.prepare(
      "SELECT ts, discovered, polled, snapshots, requests, errors IS NOT NULL AS had_errors FROM run_log ORDER BY ts DESC LIMIT 1",
    ).first();
    const tracking = await env.DB.prepare("SELECT COUNT(*) AS n FROM match WHERE tracking = 1").first<number>("n");
    return json({ ok: true, tracking, last_run: last });
  }
  // 보드 조회는 공개 (지인 공유용). 규칙 변경·수동 실행 등 관리 기능만 토큰 필요
  const historyMatch = /^\/api\/matches\/(\d+)\/history$/.exec(path);
  const isPublic = (path === "/api/board" && req.method === "GET") || path === "/api/alerts" || path === "/api/alerts/test"
    || (!!historyMatch && req.method === "GET");

  // --- 매치 레벨·인원 추이 (공개, 화면 팝업용)
  if (historyMatch && req.method === "GET") {
    const id = Number(historyMatch[1]);
    const m = await env.DB.prepare(
      "SELECT id, title, kst_date, kst_time, confirm, max_players, average_level, apply_status FROM match WHERE id = ?",
    ).bind(id).first();
    if (!m) return json({ error: "not found" }, 404);
    const { results: snaps } = await env.DB.prepare(
      `SELECT ts, confirm, average_level, pct_rookie, pct_beginner, pct_amateur, pct_semipro, pct_pro
       FROM snapshot WHERE match_id = ? ORDER BY ts, id`,
    ).bind(id).all<SnapLevel & { ts: string }>();
    const est = estimateLevel(snaps);
    return json({
      match: m,
      estimate: est ? { ...est, ...levelBucket(est) } : null,
      snapshots: snaps.map((s) => ({ ts: s.ts, confirm: s.confirm, average_level: s.average_level })),
    });
  }
  if (!isPublic && !authorized(req, env)) return json({ error: "unauthorized" }, 401);

  // --- 알림 구독 (공개: 토픽 자체가 비밀번호 역할)
  if (path === "/api/alerts") {
    const topic = req.method === "GET" || req.method === "DELETE"
      ? url.searchParams.get("topic") ?? ""
      : "";
    if (req.method === "GET") {
      if (!TOPIC_RE.test(topic)) return json({ error: "topic 형식 오류" }, 400);
      return json(await env.DB.prepare("SELECT * FROM alert_sub WHERE topic = ?").bind(topic).first());
    }
    if (req.method === "DELETE") {
      if (!TOPIC_RE.test(topic)) return json({ error: "topic 형식 오류" }, 400);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM alert_sub WHERE topic = ?").bind(topic),
        env.DB.prepare("DELETE FROM alert_log WHERE topic = ?").bind(topic),
      ]);
      return json({ ok: true });
    }
    if (req.method === "PUT") {
      const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!b || typeof b.topic !== "string" || !TOPIC_RE.test(b.topic)) return json({ error: "topic 형식 오류" }, 400);
      if (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return json({ error: "date 필요" }, 400);
      if (typeof b.from !== "string" || !TIME_RE.test(b.from) || typeof b.to !== "string" || !TIME_RE.test(b.to)) {
        return json({ error: "from/to: 'HH:MM'" }, 400);
      }
      const nowIso = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO alert_sub (topic, date, time_from, time_to, only6, only_ai, only_tf, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(topic) DO UPDATE SET date = excluded.date, time_from = excluded.time_from, time_to = excluded.time_to,
           only6 = excluded.only6, only_ai = excluded.only_ai, only_tf = excluded.only_tf, updated_at = excluded.updated_at`,
      ).bind(b.topic, b.date, b.from, b.to, b.only6 ? 1 : 0, b.onlyAI ? 1 : 0, b.onlyTF ? 1 : 0, nowIso, nowIso).run();
      return json({ ok: true });
    }
    return json({ error: "method" }, 405);
  }
  if (path === "/api/alerts/test" && req.method === "POST") {
    const b = (await req.json().catch(() => null)) as { topic?: unknown } | null;
    const topic = typeof b?.topic === "string" ? b.topic : "";
    if (!TOPIC_RE.test(topic)) return json({ error: "topic 형식 오류" }, 400);
    // 등록된 토픽에만, 1분에 한 번
    const sub = await env.DB.prepare("SELECT topic FROM alert_sub WHERE topic = ?").bind(topic).first();
    if (!sub) return json({ error: "먼저 알림을 켜 주세요" }, 404);
    const key = `alert_test:${topic}`;
    const last = await env.DB.prepare("SELECT value FROM state WHERE key = ?").bind(key).first<string>("value");
    if (last && Date.now() - Date.parse(last) < 60_000) return json({ error: "1분 뒤에 다시 시도해 주세요" }, 429);
    await env.DB.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, new Date().toISOString()).run();
    const ok = await sendNtfy(ntfyFetch, topic, { title: "플랩레이더 테스트 알림", body: "알림이 잘 와요. 조건에 맞는 매치가 생기면 알려드릴게요.", tags: "white_check_mark" })
      .catch(() => false);
    return json({ ok }, ok ? 200 : 502);
  }

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
    const myLevel = Number(url.searchParams.get("my") ?? 6);
    if (!Number.isInteger(myLevel) || myLevel < 1 || myLevel > 12) return json({ error: "my: 1~12" }, 400);
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
      items: buildBoard(rows as BoardMatchRow[], byMatch, { date, from, to, myLevel }),
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
