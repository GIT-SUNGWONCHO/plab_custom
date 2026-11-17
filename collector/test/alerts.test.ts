import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { isQuietHour, runAlerts } from "../src/alerts.ts";
import { handleFetch, type Env } from "../src/index.ts";
import { asD1, D1Shim } from "./d1-shim.ts";

let db: D1Shim;
let sent: { topic: string; title: string; body: string; click?: string }[];
let pushOk = true;
// 가짜 발송: 실제 웹푸시 대신 보낸 내용을 기록
const ntfy = async (topic: string, msg: { title: string; body: string; click?: string }) => {
  if (!pushOk) return false;
  sent.push({ topic, ...msg });
  return true;
};
const PUSH = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "BXX", auth: "aaa" } };

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
  db.db.prepare("INSERT INTO push_sub (topic, endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, 'k', 'a', 'x', 'x')").run(TOPIC, PUSH.endpoint);
}

beforeEach(() => {
  db = new D1Shim();
  sent = [];
  pushOk = true;
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
  assert.equal(sent[0].title, "12명 모임 · 11/22(일) 12:00 · 아마3");
  assert.equal(sent[0].body, "구장 1\n12/18명 · 6vs6");
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
  pushOk = false;
  const morning = new Date("2026-11-20T23:05:00Z"); // 08:05 KST
  assert.equal((await runAlerts(asD1(db), ntfy, morning)).failed, 1);
  pushOk = true;
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
  assert.equal((await call("/api/alerts", "PUT", { topic: "짧음", date: "2026-11-22", from: "10:00", to: "17:00", push: PUSH })).status, 400);
  assert.equal((await call("/api/alerts/test", "POST", { topic: TOPIC })).status, 404); // 구독 전
  // 웹푸시 구독 정보 없음 / 푸시 서버가 아닌 주소 → 거절
  assert.equal((await call("/api/alerts", "PUT", { topic: TOPIC, date: "2026-11-22", from: "10:00", to: "17:00" })).status, 400);
  assert.equal((await call("/api/alerts", "PUT", { topic: TOPIC, date: "2026-11-22", from: "10:00", to: "17:00", push: { ...PUSH, endpoint: "https://evil.example/x" } })).status, 400);
  assert.equal((await call("/api/alerts", "PUT", { topic: TOPIC, date: "2026-11-22", from: "10:00", to: "17:00", only6: true, push: PUSH })).status, 200);
  const got = (await (await call(`/api/alerts?topic=${TOPIC}`)).json()) as { only6: number; time_to: string };
  assert.deepEqual([got.only6, got.time_to], [1, "17:00"]);
  assert.equal((await call("/api/alerts/test", "POST", { topic: TOPIC })).status, 200);
  assert.equal(sent.at(-1)!.title, "플랩레이더 테스트 알림");
  assert.equal((await call("/api/alerts/test", "POST", { topic: TOPIC })).status, 429); // 1분 제한
  assert.equal((await call(`/api/alerts?topic=${TOPIC}`, "DELETE")).status, 200);
  assert.equal(await (await call(`/api/alerts?topic=${TOPIC}`)).json(), null);
});

test("웹푸시: 구독이 있는 기기는 웹푸시로, 410이면 구독 지움, 구독 없으면 실패", async () => {
  const { makeDeliver } = await import("../src/alerts.ts");
  const nodeCrypto = await import("node:crypto");
  const { b64urlEncode } = await import("../src/webpush.ts");
  const db = new D1Shim();
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const pubRaw = b64urlEncode(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]));
  void publicKey;
  const ua = nodeCrypto.createECDH("prime256v1"); ua.generateKeys();
  await asD1(db).prepare("INSERT INTO push_sub (topic, endpoint, p256dh, auth, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', 'x')")
    .bind("plabradar-pushpushpush", "https://web.push.apple.com/abc", b64urlEncode(ua.getPublicKey()), b64urlEncode(nodeCrypto.randomBytes(16))).run();
  const hits: string[] = [];
  let pushStatus = 201;
  const pushFetch = async (url: string, init?: RequestInit) => {
    hits.push(url);
    assert.match(new Headers(init?.headers).get("authorization") ?? "", /^vapid t=.+, k=/);
    assert.equal(new Headers(init?.headers).get("content-encoding"), "aes128gcm");
    return new Response("", { status: pushStatus });
  };
  const d = makeDeliver(asD1(db), { publicKey: pubRaw, privateJwk: JSON.stringify(jwk), subject: "https://x.dev" }, pushFetch);
  const msg = { title: "t", body: "b" };
  assert.equal(await d("plabradar-pushpushpush", msg), true);
  assert.deepEqual(hits, ["https://web.push.apple.com/abc"]);
  assert.equal(await d("plabradar-nosubnosub", msg), false); // 구독 없는 기기
  assert.equal(hits.length, 1);
  pushStatus = 410;
  assert.equal(await d("plabradar-pushpushpush", msg), false);
  assert.equal(await asD1(db).prepare("SELECT COUNT(*) AS n FROM push_sub").first("n"), 0);
});

test("알림을 켤 때 이미 대상인 매치는 안 보내고, 이후 새로 대상이 된 것만", async () => {
  addMatch(1, { confirm: 12, avg: "아마추어3" }); // 켜기 전부터 10명 넘음
  const env = { DB: asD1(db), ADMIN_TOKEN: "secret" } as Env;
  const put = await handleFetch(new Request("https://x.dev/api/alerts", { method: "PUT", body: JSON.stringify({ topic: TOPIC, date: "2026-11-22", from: "10:00", to: "17:00", push: PUSH }) }), env, undefined, ntfy);
  assert.equal(put.status, 200);
  assert.equal((await runAlerts(asD1(db), ntfy, NOW)).sent, 0);
  addMatch(2, { time: "13:00", confirm: 11, avg: "아마추어2" }); // 켠 뒤 새로 대상
  db.db.prepare("UPDATE match SET confirm = 15 WHERE id = 1").run(); // 이미 보낸 것으로 친 매치가 마감임박으로 → 다음 단계는 감
  db.db.prepare("UPDATE snapshot SET confirm = 15 WHERE match_id = 1").run();
  await runAlerts(asD1(db), ntfy, new Date(NOW.getTime() + 60_000));
  assert.deepEqual(sent.map((m) => m.title).sort(), ["11명 모임 · 11/22(일) 13:00 · 아마2", "마감임박 · 11/22(일) 12:00 · 아마3"].sort());
});
