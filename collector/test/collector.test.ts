import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { runCollector } from "../src/collector.ts";
import { handleFetch, type Env } from "../src/index.ts";
import { PlabClient } from "../src/plab.ts";
import { CONFIG } from "../src/schedule.ts";
import { MINUTE } from "../src/time.ts";
import { asD1, D1Shim } from "./d1-shim.ts";

// ---------- 가짜 플랩 서버 ----------
interface FakeMatch {
  id: number;
  date: string; // KST
  time: string; // KST HH:MM
  group: number;
  confirm: number;
  max: number;
  avg: string | null;
  pct: { rookie: number; beginner: number; amateur: number; semipro: number; pro: number };
  status: string;
  lifecycle: string;
  gone?: boolean;
}

function utcSchedule(date: string, time: string) {
  return new Date(Date.parse(`${date}T${time}:00+09:00`)).toISOString();
}

class FakePlab {
  matches = new Map<number, FakeMatch>();
  calls: string[] = [];
  userAgents = new Set<string>();

  add(m: Partial<FakeMatch> & Pick<FakeMatch, "id" | "date" | "time">) {
    this.matches.set(m.id, {
      group: 3, confirm: 0, max: 18, avg: null, status: "available", lifecycle: "UPCOMING",
      pct: { rookie: 0, beginner: 0, amateur: 0, semipro: 0, pro: 0 }, ...m,
    });
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    this.calls.push(url.pathname + url.search);
    this.userAgents.add(new Headers(init?.headers).get("user-agent") ?? "");
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    const notFound = () => new Response(JSON.stringify({ data: { error_code: "not_found" } }), { status: 404 });

    if (url.pathname === "/api/v3/social-matches/") {
      const date = url.searchParams.get("date");
      const groups = url.searchParams.getAll("stadium_group_id").map(Number);
      const results = [...this.matches.values()]
        .filter((m) => !m.gone && m.date === date && groups.includes(m.group))
        .map((m) => ({
          id: m.id, time: m.time, title: `구장${m.group}`,
          attributes: {
            stadium_group: `그룹${m.group}`, area_label: "서울 송파", format: "6vs6", level: "일반",
            participants: { label: `${m.confirm}/${m.max}` }, schedule: utcSchedule(m.date, m.time),
          },
        }));
      return ok({ count: results.length, next: null, previous: null, results });
    }
    const detail = /^\/api\/v3\/social-matches\/(\d+)\/$/.exec(url.pathname);
    if (detail) {
      const m = this.matches.get(Number(detail[1]));
      if (!m || m.gone) return notFound();
      const schedule = utcSchedule(m.date, m.time);
      return ok({
        match: {
          id: m.id, title: `구장${m.group}`, schedule, lifecycle: m.lifecycle, apply_status: m.status,
          state_expires_at: new Date(Date.parse(schedule) - 10 * MINUTE).toISOString(),
          stadium: { id: m.group * 10, group_id: m.group, name: `그룹${m.group}`, area_group: "서울", area: "송파구" },
          format: "6 vs 6", level_label: "모든 레벨", sex: 0, pricing: { final_fee: 10000 },
          participants: { confirm: m.confirm, max: m.max, min: 10, female_count: 0 },
          applicant_progress: { phase: null },
        },
      });
    }
    const graph = /^\/api\/v3\/social-matches\/(\d+)\/level-graph\/$/.exec(url.pathname);
    if (graph) {
      const m = this.matches.get(Number(graph[1]));
      if (!m || m.gone) return notFound();
      const grades = Object.fromEntries(Object.entries(m.pct).map(([k, v]) => [k, { percentage: v, label: k }]));
      return ok({ average_level: m.avg, grades });
    }
    return notFound();
  };
}

// 금요일 12:00 KST
const T0 = new Date("2026-11-13T03:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * MINUTE);

let db: D1Shim;
let plab: FakePlab;
const run = (now: Date) => runCollector(asD1(db), new PlabClient(plab.fetch), now);

function addRule(groups = [3], weekdays = [6], from = "10:00", to = "14:00") {
  db.db.prepare(
    "INSERT INTO watch_rule (name, stadium_group_ids, weekdays, time_from, time_to, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("토요일 낮", JSON.stringify(groups), JSON.stringify(weekdays), from, to, T0.toISOString());
}

describe("수집기", () => {
  beforeEach(() => {
    db = new D1Shim();
    plab = new FakePlab();
    plab.add({ id: 1, date: "2026-11-14", time: "09:00" }); // 시간대 밖
    plab.add({ id: 2, date: "2026-11-14", time: "11:00", confirm: 5, avg: "아마추어2",
               pct: { rookie: 20, beginner: 0, amateur: 80, semipro: 0, pro: 0 } });
    plab.add({ id: 3, date: "2026-11-14", time: "13:00", confirm: 16, avg: "아마추어4", status: "hurry",
               pct: { rookie: 0, beginner: 0, amateur: 88, semipro: 12, pro: 0 } });
    plab.add({ id: 4, date: "2026-11-21", time: "12:00", confirm: 1, avg: "아마추어5",
               pct: { rookie: 0, beginner: 0, amateur: 100, semipro: 0, pro: 0 } });
    plab.add({ id: 5, date: "2026-11-15", time: "12:00" }); // 일요일 → 규칙 요일 밖
    plab.add({ id: 6, date: "2026-11-14", time: "12:00", group: 99 }); // 다른 구장
    addRule();
  });

  test("탐색: 구장·요일·시간대에 맞는 매치만 추적", async () => {
    const r = await run(T0);
    assert.deepEqual(r.errors, []);
    assert.equal(r.discovered, 3);
    assert.deepEqual(db.rows("SELECT id FROM match ORDER BY id").map((x) => x.id), [2, 3, 4]);
    // 토요일 2개(11/14, 11/21)만 목록 조회, 구장 필터 포함
    const lists = plab.calls.filter((c) => c.startsWith("/api/v3/social-matches/?"));
    assert.equal(lists.length, 2);
    assert.ok(lists.every((c) => c.includes("stadium_group_id=3")));
    assert.deepEqual([...plab.userAgents], ["plab-radar/0.1 (personal use)"]);
  });

  test("첫 폴링에서 상세·레벨을 match와 snapshot에 저장", async () => {
    const r = await run(T0);
    assert.equal(r.polled, 3);
    assert.equal(r.snapshots, 3);
    const m2 = db.rows("SELECT * FROM match WHERE id = 2")[0];
    assert.equal(m2.confirm, 5);
    assert.equal(m2.average_level, "아마추어2");
    assert.equal(m2.average_level_num, 5);
    assert.equal(m2.kst_date, "2026-11-14");
    assert.equal(m2.kst_time, "11:00");
    assert.equal(m2.stadium_group_id, 3);
    assert.equal(m2.deadline_at, "2026-11-14T01:50:00.000Z");
    const s = db.rows("SELECT * FROM snapshot WHERE match_id = 3")[0];
    assert.equal(s.confirm, 16);
    assert.equal(s.pct_semipro, 12);
    assert.equal(JSON.parse(s.raw).level_graph.averageLevel, "아마추어4");
  });

  test("평균이 '루키'면 평가된 참가자가 없는 것 → 수치 평균은 null", async () => {
    plab.matches.get(2)!.avg = "루키";
    await run(T0);
    const m2 = db.rows("SELECT average_level, average_level_num FROM match WHERE id = 2")[0];
    assert.deepEqual(m2, { average_level: "루키", average_level_num: null });
  });

  test("변화 없으면 스냅샷을 쌓지 않고, 바뀌면 쌓음", async () => {
    await run(T0);
    // 1분 뒤: 마감까지 ~22시간 → 5분 주기라 아무것도 안 함, 탐색도 15분 간격이라 건너뜀
    const r1 = await run(at(1));
    assert.equal(r1.requests, 0);

    // 6분 뒤: 2번 매치에 한 명 들어와 평균이 바뀜
    const m = plab.matches.get(2)!;
    m.confirm = 6;
    m.avg = "아마추어3";
    m.pct = { rookie: 17, beginner: 0, amateur: 83, semipro: 0, pro: 0 };
    // 2번(마감 ~22h50m 전, 5분 주기)만 차례. 3번은 마감 24h50m 전이라 15분, 4번은 8일 뒤라 60분 주기
    const r2 = await run(at(6));
    assert.equal(r2.polled, 1);
    assert.equal(r2.snapshots, 1);
    const snaps = db.rows("SELECT confirm, average_level FROM snapshot WHERE match_id = 2 ORDER BY id");
    assert.deepEqual(snaps, [
      { confirm: 5, average_level: "아마추어2" },
      { confirm: 6, average_level: "아마추어3" },
    ]);
    // 16분 뒤: 3번 차례. 변화가 없으니 스냅샷은 그대로, last_polled_at만 갱신
    const r3 = await run(at(16));
    assert.ok(r3.polled >= 1);
    assert.equal(db.rows("SELECT COUNT(*) AS n FROM snapshot WHERE match_id = 3")[0].n, 1);
    assert.equal(db.rows("SELECT last_polled_at FROM match WHERE id = 3")[0].last_polled_at, at(16).toISOString());
  });

  test("목록에 새로 열린 매치는 다음 탐색 주기에 추가", async () => {
    await run(T0);
    plab.add({ id: 7, date: "2026-11-14", time: "14:00" });
    assert.equal((await run(at(5))).discovered, 0); // 15분 안 됨
    assert.equal((await run(at(16))).discovered, 1);
  });

  test("마감 지나면 추적 종료, 사라진 매치는 not_found", async () => {
    await run(T0);
    plab.matches.get(3)!.gone = true;
    await run(at(16));
    assert.equal(db.rows("SELECT stop_reason FROM match WHERE id = 3")[0].stop_reason, "not_found");

    // 11/14 11:00 KST 매치(2번)의 마감 10:50 KST = 01:50Z, 그 뒤 실행
    const after = new Date("2026-11-14T01:52:00Z");
    const r = await run(after);
    const m2 = db.rows("SELECT tracking, stop_reason FROM match WHERE id = 2")[0];
    assert.deepEqual(m2, { tracking: 0, stop_reason: "deadline_passed" });
    assert.ok(r.stopped >= 1);
    assert.equal(db.rows("SELECT tracking FROM match WHERE id = 4")[0].tracking, 1);
  });

  test("마감 임박(CLOSING_SOON)은 계속 추적, CLOSED·FINISHED 등은 종료", async () => {
    await run(T0);
    plab.matches.get(2)!.lifecycle = "CLOSING_SOON";
    await run(at(6));
    assert.equal(db.rows("SELECT tracking FROM match WHERE id = 2")[0].tracking, 1);
    plab.matches.get(2)!.lifecycle = "CLOSED";
    await run(at(12));
    assert.equal(db.rows("SELECT stop_reason FROM match WHERE id = 2")[0].stop_reason, "lifecycle:CLOSED");
  });

  test("한 번 실행의 요청 수 상한 지키기, 남은 건 다음 실행에", async () => {
    for (let i = 0; i < 30; i++) plab.add({ id: 100 + i, date: "2026-11-14", time: "12:00" });
    const r1 = await run(T0);
    assert.ok(r1.requests <= CONFIG.maxRequestsPerRun, `requests=${r1.requests}`);
    const polledFirst = r1.polled;
    assert.ok(polledFirst < 33);
    const r2 = await run(at(1));
    assert.equal(polledFirst + r2.polled, 33); // 첫 폴링 못 한 것들이 다음 실행에서 처리됨
  });

  test("연속 실패 5번이면 추적 중단", async () => {
    await run(T0);
    const realFetch = plab.fetch;
    plab.fetch = async (input, init) =>
      input.includes("/social-matches/2/") ? new Response("oops", { status: 500 }) : realFetch(input, init);
    for (let i = 1; i <= 5; i++) await run(at(6 * i));
    const m2 = db.rows("SELECT tracking, stop_reason, poll_errors FROM match WHERE id = 2")[0];
    assert.deepEqual(m2, { tracking: 0, stop_reason: "too_many_errors", poll_errors: 5 });
    assert.ok(db.rows("SELECT errors FROM run_log WHERE errors IS NOT NULL").length >= 5);
  });
});

describe("API", () => {
  const env = () => ({ DB: asD1(db), ADMIN_TOKEN: "secret" }) as Env;
  const req = (path: string, init: RequestInit = {}, token: string | null = "secret") =>
    new Request(`https://x.dev${path}`, {
      ...init,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    });

  beforeEach(() => {
    db = new D1Shim();
    plab = new FakePlab();
  });

  test("토큰 없으면 401, /health는 공개", async () => {
    assert.equal((await handleFetch(req("/api/rules", {}, null), env())).status, 401);
    assert.equal((await handleFetch(req("/api/rules", {}, "wrong"), env())).status, 401);
    const h = await handleFetch(req("/health", {}, null), env());
    assert.equal(h.status, 200);
    assert.equal(((await h.json()) as { ok: boolean }).ok, true);
  });

  test("규칙 추가·검증·조회·삭제", async () => {
    const bad = await handleFetch(req("/api/rules", { method: "POST", body: JSON.stringify({ name: "x", stadium_group_ids: [3], weekdays: [7], time_from: "10:00", time_to: "14:00" }) }), env());
    assert.equal(bad.status, 400);
    const created = await handleFetch(req("/api/rules", { method: "POST", body: JSON.stringify({ name: "토요일", stadium_group_ids: [3, 3639], weekdays: [6], time_from: "10:00", time_to: "14:00" }) }), env());
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: number };
    const list = (await (await handleFetch(req("/api/rules"), env())).json()) as { stadium_group_ids: number[] }[];
    assert.deepEqual(list[0].stadium_group_ids, [3, 3639]);
    const del = await handleFetch(req(`/api/rules/${id}`, { method: "DELETE" }), env());
    assert.deepEqual(await del.json(), { deleted: 1 });
  });

  test("수동 실행 후 매치·스냅샷 조회", async () => {
    plab.add({ id: 2, date: "2026-11-14", time: "11:00", confirm: 5, avg: "아마추어2" });
    addRule();
    const client = new PlabClient(plab.fetch);
    // 수동 실행은 현재 시각 기준이라 직접 runCollector로 T0 실행
    await runCollector(asD1(db), client, T0);
    const matches = (await (await handleFetch(req("/api/matches?from=2026-11-14&to=2026-11-14"), env(), client)).json()) as { id: number; url: string; snapshot_count: number }[];
    assert.equal(matches.length, 1);
    assert.equal(matches[0].url, "https://www.plabfootball.com/match/2/");
    assert.equal(matches[0].snapshot_count, 1);
    const snaps = (await (await handleFetch(req("/api/matches/2/snapshots"), env(), client)).json()) as unknown[];
    assert.equal(snaps.length, 1);
  });
});
