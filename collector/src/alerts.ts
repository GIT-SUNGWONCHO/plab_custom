// 웹푸시 알림
//
// 구독(alert_sub + 이 기기의 웹푸시 구독 push_sub)마다: 그 날짜·시간대·토글 조건의 보드를 만들고,
// 초록(평균 아마3 이하) 매치 중
//   ① 신청 10명 이상이 됐을 때  → 'ten'
//   ② 마감임박(신청 15명 이상)이 됐을 때 → 'soon'
// 를 한 번씩 웹푸시로 보냄. 자정~08시(KST)에는 보내지 않고, 그때까지 조건이 남아 있으면 08시 이후에 보냄.
// 웹푸시가 안 되면 그냥 안 감 (다른 방법으로 대신 보내지 않음).

import { buildBoard, type BoardItem, type BoardMatchRow } from "./board.ts";
import type { SnapLevel } from "./estimate.ts";
import type { FetchFn } from "./plab.ts";
import { kstDate } from "./time.ts";
import { sendWebPush, type VapidKeys } from "./webpush.ts";

/** 기기 id (화면에서 무작위로 만들어 localStorage에 저장) */
export const TOPIC_RE = /^[A-Za-z0-9_-]{12,64}$/;
export const QUIET_HOURS = { from: 0, to: 8 }; // KST, [from, to)
export const MAX_SENDS_PER_RUN = 8; // 수집 38 + 알림 8 < 무료 플랜 subrequest 50
const MY_LEVEL = 6; // 아마3 고정

export interface AlertSub {
  topic: string;
  date: string;
  time_from: string;
  time_to: string;
  only6: number;
  only_ai: number;
  only_tf: number;
}

export type AlertKind = "ten" | "soon";

export function isQuietHour(now: Date): boolean {
  const h = Number(new Date(now.getTime() + 9 * 3600_000).toISOString().slice(11, 13));
  return h >= QUIET_HOURS.from && h < QUIET_HOURS.to;
}

/** 보드에서 이 구독의 토글 조건을 적용하고, 알림 대상 이벤트를 고름 */
export function pickEvents(items: BoardItem[], sub: AlertSub): { item: BoardItem; kind: AlertKind }[] {
  const out: { item: BoardItem; kind: AlertKind }[] = [];
  for (const it of items) {
    if (it.full || !it.atOrBelowMine) continue;
    if (sub.only6 && !it.is6v6) continue;
    if (sub.only_ai && !it.aiReport) continue;
    if (sub.only_tf && !it.title.includes("더에프필드")) continue;
    if (it.closingSoon) out.push({ item: it, kind: "soon" });
    if (it.enoughPlayers) out.push({ item: it, kind: "ten" });
  }
  return out;
}

const shortLevel = (l: string | undefined) => (l ?? "").replace("아마추어", "아마").replace("세미프로", "세미");

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
/** 알림용 짧은 구장명: 반복되는 앞부분(플랩 스타디움, 서울) 제거 */
export const shortStadium = (t: string) => t.replace(/^플랩\s*스타디움\s*/, "").replace(/^서울\s*/, "").trim();

/**
 * 휴대폰 알림 문구: 제목은 "무슨 일 · 언제 · 레벨", 본문은 "어디서" + "인원·형식"
 *   12명 모임 · 11/22(일) 12:00 · 아마3
 *   가산 벽산디지털밸리 6차 2구장
 *   12/18명 · 6vs6 · AI리포트
 */
export function messageFor(it: BoardItem, kind: AlertKind): { title: string; body: string } {
  const lv = shortLevel(it.estimate?.label);
  const d = new Date(`${it.date}T00:00:00Z`);
  const when = `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAY[d.getUTCDay()]}) ${it.time}`;
  const head = kind === "soon" ? "마감임박" : `${it.confirm}명 모임`;
  const title = [head, when, lv].filter(Boolean).join(" · ");
  const extra = [`${it.confirm}/${it.max ?? "?"}명`, it.format?.replace(/\s/g, ""), it.aiReport ? "AI리포트" : ""].filter(Boolean).join(" · ");
  return { title, body: `${shortStadium(it.title)}\n${extra}` };
}

async function loadBoardRows(db: D1Database, date: string) {
  const { results: rows } = await db
    .prepare(
      `SELECT id, title, stadium_group, kst_date, kst_time, schedule, deadline_at, format, level_rule, level_code,
              sex, features, confirm, max_players, min_players, apply_status, average_level
       FROM match WHERE kst_date = ?`,
    )
    .bind(date)
    .all<BoardMatchRow>();
  const { results: snaps } = await db
    .prepare(
      `SELECT s.match_id, s.confirm, s.average_level, s.pct_rookie, s.pct_beginner, s.pct_amateur, s.pct_semipro, s.pct_pro
       FROM snapshot s JOIN match m ON m.id = s.match_id
       WHERE m.kst_date = ? ORDER BY s.match_id, s.ts, s.id`,
    )
    .bind(date)
    .all<SnapLevel & { match_id: number }>();
  const byMatch = new Map<number, SnapLevel[]>();
  for (const s of snaps) {
    if (!byMatch.has(s.match_id)) byMatch.set(s.match_id, []);
    byMatch.get(s.match_id)!.push(s);
  }
  return { rows, byMatch };
}

export interface AlertRunResult {
  sent: number;
  failed: number;
  skippedQuiet: boolean;
}

export const MAX_SENDS_PER_SUB_PER_RUN = 3;
export const MAX_TESTS_PER_DAY = 30;
export const MAX_SUBSCRIPTIONS = 50;

export type AlertMsg = { title: string; body: string; click?: string; tag?: string };
/** 한 기기로 알림 한 건 보내기 (성공 여부) */
export type Deliver = (topic: string, msg: AlertMsg) => Promise<boolean>;

/** 웹푸시 허용 푸시 서버 (아무 주소로나 요청을 보내지 않게) */
export const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
export const isPushEndpoint = (u: string) => {
  try { const x = new URL(u); return x.protocol === "https:" && PUSH_HOSTS.some((r) => r.test(x.hostname)); } catch { return false; }
};

/**
 * 웹푸시로 보내기. 이 기기 구독이 없거나 VAPID 설정이 없으면 실패.
 * 푸시 서버가 "구독 없음(404/410)"이라고 하면 저장된 구독을 지움 (앱을 지웠거나 권한을 끈 경우).
 */
export function makeDeliver(db: D1Database, vapid: VapidKeys | null, pushFetch?: FetchFn): Deliver {
  return async (topic, msg) => {
    if (!vapid) return false;
    const sub = await db.prepare("SELECT endpoint, p256dh, auth FROM push_sub WHERE topic = ?").bind(topic)
      .first<{ endpoint: string; p256dh: string; auth: string }>();
    if (!sub) return false;
    const r = await sendWebPush(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      { title: msg.title, body: msg.body, url: msg.click ?? "/", tag: msg.tag },
      vapid,
      pushFetch,
    ).catch((e) => { console.error("webpush error", String(e)); return "error" as const; });
    if (r === "gone") await db.prepare("DELETE FROM push_sub WHERE topic = ?").bind(topic).run();
    return r === "ok";
  };
}

/**
 * 알림을 켜거나 조건을 바꾼 순간: 그 조건에서 이미 대상인 매치는 '보낸 것'으로 표시해서 한꺼번에 오지 않게 함.
 * 이후 새로 조건을 넘는 매치(또는 10명 → 마감임박처럼 다음 단계)만 알림이 감.
 */
export async function baselineAlerts(db: D1Database, sub: AlertSub, now = new Date()): Promise<number> {
  const { rows, byMatch } = await loadBoardRows(db, sub.date);
  const items = buildBoard(rows, byMatch, { date: sub.date, from: sub.time_from, to: sub.time_to, myLevel: MY_LEVEL }, now.getTime());
  const events = pickEvents(items, sub);
  if (!events.length) return 0;
  const nowIso = now.toISOString();
  await db.batch(events.map(({ item, kind }) =>
    db.prepare("INSERT OR IGNORE INTO alert_log (topic, match_id, kind, ts) VALUES (?, ?, ?, ?)").bind(sub.topic, item.id, kind, nowIso)));
  return events.length;
}

export async function runAlerts(db: D1Database, deliver: Deliver, now = new Date()): Promise<AlertRunResult> {
  const result: AlertRunResult = { sent: 0, failed: 0, skippedQuiet: false };
  const today = kstDate(now);
  const nowIso = now.toISOString();
  // 지난 날짜 구독은 정리
  await db.prepare("DELETE FROM alert_sub WHERE date < ?").bind(today).run();
  if (isQuietHour(now)) { result.skippedQuiet = true; return result; }

  const budget = MAX_SENDS_PER_RUN;
  // 순서를 매번 섞어서, 계속 실패하는 구독이 다른 구독을 막지 않게 함
  // 웹푸시 구독이 있는 기기만
  const { results: subs } = await db
    .prepare("SELECT a.* FROM alert_sub a JOIN push_sub p ON p.topic = a.topic ORDER BY RANDOM()")
    .all<AlertSub>();
  if (!subs.length) return result;
  const boards = new Map<string, Awaited<ReturnType<typeof loadBoardRows>>>();

  for (const sub of subs) {
    if (result.sent + result.failed >= budget) break;
    if (!boards.has(sub.date)) boards.set(sub.date, await loadBoardRows(db, sub.date));
    const { rows, byMatch } = boards.get(sub.date)!;
    const items = buildBoard(rows, byMatch, { date: sub.date, from: sub.time_from, to: sub.time_to, myLevel: MY_LEVEL }, now.getTime());
    const events = pickEvents(items, sub);
    if (!events.length) continue;
    const { results: sentRows } = await db
      .prepare("SELECT match_id, kind FROM alert_log WHERE topic = ?")
      .bind(sub.topic)
      .all<{ match_id: number; kind: string }>();
    const already = new Set(sentRows.map((r) => `${r.match_id}:${r.kind}`));
    let usedForSub = 0;
    for (const { item, kind } of events) {
      if (already.has(`${item.id}:${kind}`)) continue;
      // 마감임박을 보냈거나 같이 보낼 매치는 10명 알림 생략 (기록만)
      if (kind === "ten") {
        if (already.has(`${item.id}:ten_skipped`)) continue;
        if (already.has(`${item.id}:soon`) || events.some((e) => e.item.id === item.id && e.kind === "soon")) {
          await db.prepare("INSERT OR IGNORE INTO alert_log (topic, match_id, kind, ts) VALUES (?, ?, 'ten_skipped', ?)")
            .bind(sub.topic, item.id, nowIso).run();
          continue;
        }
      }
      if (result.sent + result.failed >= budget || usedForSub >= MAX_SENDS_PER_SUB_PER_RUN) break;
      // 먼저 자리를 잡고(겹친 실행이 같은 알림을 두 번 보내지 않게) 보냄. 실패하면 자리 반납 → 다음에 다시
      const claim = await db.prepare("INSERT OR IGNORE INTO alert_log (topic, match_id, kind, ts) VALUES (?, ?, ?, ?)")
        .bind(sub.topic, item.id, kind, nowIso).run();
      if (!claim.meta.changes) continue;
      usedForSub++;
      const ok = await deliver(sub.topic, { ...messageFor(item, kind), click: item.url, tag: `${item.id}-${kind}` }).catch(() => false);
      if (ok) result.sent++;
      else {
        result.failed++;
        await db.prepare("DELETE FROM alert_log WHERE topic = ? AND match_id = ? AND kind = ?").bind(sub.topic, item.id, kind).run();
        break; // 이 구독은 이번 실행에서 그만 (계속 실패하는 토픽이 예산을 다 쓰지 않게)
      }
    }
  }
  return result;
}
