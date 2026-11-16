import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { isQuietHour, runAlerts } from "../src/alerts.ts";
import { handleFetch, type Env } from "../src/index.ts";
import { asD1, D1Shim } from "./d1-shim.ts";

let db: D1Shim;
let sent: { topic: string; title: string; message: string; click?: string }[];
let ntfyOk = true;
const ntfy = async (_input: string, init?: RequestInit) => {
  if (!ntfyOk) return new Response("nope", { status: 500 });
  sent.push(JSON.parse(String(init?.body)));
  return new Response("{}", { status: 200 });
};

const TOPIC = "plabradar-test-topic-1";
// 11/22(일) 12:00 KST 경기. 지금은 11/20 12:00 KST (낮)
const NOW = new Date("2026-11-20T03:00:00Z");

function addMatch(id: number, o: { time?: string; confirm: number; avg: string; format?: string; features?: string[]; amateur?: number; status?: string }) {
  const time = o.time ?? "12:00";
  const schedule = new Date(Date.parse(`2026-11-22T${time}:00+09:00`)).toISOString();
  db.db.prepare(
    `INSERT INTO match (id, title, stadium_group, schedule, kst_date, kst_time, deadline_at, format, level_rule, level_code, sex,
                        features, confirm, max_players, apply_status, average_level, first_seen_at)
     VALUES (?, ?, '그룹', ?, '2026-11-22', ?, NULL, ?, '모든 레벨', 0, 0, ?, ?, 18, ?, ?, ?)`,
  ).run(id, `구장 ${id}`, schedule, time, o.format ?? "6 vs 6", JSON.stringify(o.features ?? []), o.confirm, o.status ?? "available", o.avg, NOW.toISOString());
  const n = o.confirm, a = o.amateur ?? n;
  db.db.prepare(
    `INSERT INTO snapshot (match_id, ts, confirm, max_players, apply_status, average_level, pct_rookie, pct_beginner, pct_amateur, pct_semipro, pct_pro)
     VALUES (?, ?, ?, 18, 'available', ?, 0, 0, ?, 0, 0)`,
  ).run(id, NOW.toISOString(), n, o.avg, Math.round((a * 100) / n));
}
function subscribe(extra: Partial<{ only6: number; only_ai: number; only_tf: number; from: string; to: string }> = {}) {
  db.db.prepare(
    `INSERT INTO alert_sub (topic, date, time_from, time_to, only6, only_ai, only_tf, created_at, updated_at)
     VALUES (?, '2026-11-22', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(TOPIC, extra.from ?? "10:00", extra.to ?? "17:00", extra.only6 ?? 0, extra.only_ai ?? 0, extra.only_tf ?? 0, NOW.toISOString(), NOW.toISOString());
}

beforeEach(() => {
  db = new D1Shim();
  sent = [];
  ntfyOk = true;
});

test("밤 0~8시(KST)는 조용히", () => {
  assert.equal(isQuietHour(new Date("2026-11-20T15:30:00Z")), true); // 00:30 KST
  assert.equal(isQuietHour(new Date("2026-11-20T22:59:00Z")), true); // 07:59 KST
  assert.equal(isQuietHour(new Date("2026-11-20T23:00:00Z")), false); // 08:00 KST
});

test("초록 + 10명 이상 → '모임' 알림 한 번, 초록 아님·10명 미만은 안 보냄", async () => {
  subscribe();
  addMatch(1, { confirm: 12, avg: "아마추어3" });
  addMatch(2, { confirm: 12, avg: "아마추어4" }); // 초록 아님
  addMatch(3, { confirm: 8, avg: "아마추어2" }); // 10명 미만
  addMatch(4, { time: "18:00", confirm: 12, avg: "아마추어3" }); // 시간대 밖
  const r = await runAlerts(asD1(db), ntfy, NOW);
  assert.equal(r.sent, 1);
  assert.equal(sent[0].topic, TOPIC);
  assert.match(sent[0].title, /12:00 아마3 매치 12명 모임/);
  assert.equal(sent[0].click, "https://www.plabfootball.com/match/1/");
  // 다시 돌려도 같은 알림은 안 감
  await runAlerts(asD1(db), ntfy, new Date(NOW.getTime() + 60_000));
  assert.equal(sent.length, 1);
});

test("마감임박(15명+)이 되면 따로 알림, 처음부터 15명이면 마감임박만", async () => {
  subscribe();
  addMatch(1, { confirm: 12, avg: "아마추어3" });
  await runAlerts(asD1(db), ntfy, NOW);
  db.db.prepare("UPDATE match SET confirm = 15 WHERE id = 1").run();
  db.db.prepare("UPDATE snapshot SET confirm = 15 WHERE match_id = 1").run();
  addMatch(2, { confirm: 16, avg: "아마추어3" });
  await runAlerts(asD1(db), ntfy, new Date(NOW.getTime() + 60_000));
  const titles = sent.map((m) => m.title);
  assert.equal(titles.length, 3);
  assert.match(titles[0], /모임/);
  assert.equal(titles.filter((t) => t.startsWith("마감임박")).length, 2);
});

test("구독 조건(6vs6만·AI리포트만)이 알림에도 적용", async () => {
  subscribe({ only6: 1, only_ai: 1 });
  addMatch(1, { confirm: 12, avg: "아마추어3", format: "5 vs 5", features: ["ai_report"] });
  addMatch(2, { confirm: 12, avg: "아마추어3", features: [] });
  addMatch(3, { confirm: 12, avg: "아마추어3", features: ["ai_report"] });
  await runAlerts(asD1(db), ntfy, NOW);
  assert.deepEqual(sent.map((m) => m.click), ["https://www.plabfootball.com/match/3/"]);
});

test("밤에는 안 보내고 아침에 보냄, 실패하면 다음에 다시", async () => {
  subscribe();
  addMatch(1, { confirm: 12, avg: "아마추어3" });
  const night = new Date("2026-11-20T16:00:00Z"); // 01:00 KST
  assert.equal((await runAlerts(asD1(db), ntfy, night)).skippedQuiet, true);
  assert.equal(sent.length, 0);
  ntfyOk = false;
  const morning = new Date("2026-11-20T23:05:00Z"); // 08:05 KST
  assert.equal((await runAlerts(asD1(db), ntfy, morning)).failed, 1);
  ntfyOk = true;
  assert.equal((await runAlerts(asD1(db), ntfy, new Date(morning.getTime() + 60_000))).sent, 1);
});

test("지난 날짜 구독은 지움", async () => {
  subscribe();
  await runAlerts(asD1(db), ntfy, new Date("2026-11-23T03:00:00Z"));
  assert.equal(db.rows("SELECT COUNT(*) n FROM alert_sub")[0].n, 0);
});

test("API: 구독 저장·조회·테스트·삭제 (토큰 없이)", async () => {
  const env = { DB: asD1(db), ADMIN_TOKEN: "secret" } as Env;
  const call = (path: string, method = "GET", body?: unknown) =>
    handleFetch(new Request(`https://x.dev${path}`, { method, body: body ? JSON.stringify(body) : undefined }), env, undefined, ntfy);
  assert.equal((await call("/api/alerts", "PUT", { topic: "짧음", date: "2026-11-22", from: "10:00", to: "17:00" })).status, 400);
  assert.equal((await call("/api/alerts/test", "POST", { topic: TOPIC })).status, 404); // 구독 전
  assert.equal((await call("/api/alerts", "PUT", { topic: TOPIC, date: "2026-11-22", from: "10:00", to: "17:00", only6: true })).status, 200);
  const got = (await (await call(`/api/alerts?topic=${TOPIC}`)).json()) as { only6: number; time_to: string };
  assert.deepEqual([got.only6, got.time_to], [1, "17:00"]);
  assert.equal((await call("/api/alerts/test", "POST", { topic: TOPIC })).status, 200);
  assert.equal(sent.at(-1)!.title, "플랩레이더 테스트 알림");
  assert.equal((await call("/api/alerts/test", "POST", { topic: TOPIC })).status, 429); // 1분 제한
  assert.equal((await call(`/api/alerts?topic=${TOPIC}`, "DELETE")).status, 200);
  assert.equal(await (await call(`/api/alerts?topic=${TOPIC}`)).json(), null);
});

test("하루 발송 상한(200건)에 닿으면 더 안 보냄", async () => {
  subscribe();
  addMatch(1, { confirm: 12, avg: "아마추어3" });
  const ins = db.db.prepare("INSERT INTO alert_log (topic, match_id, kind, ts) VALUES ('other', ?, 'ten', ?)");
  for (let i = 0; i < 200; i++) ins.run(1000 + i, NOW.toISOString());
  assert.equal((await runAlerts(asD1(db), ntfy, NOW)).sent, 0);
});
