// ntfy 알림
//
// 구독(alert_sub)마다: 그 날짜·시간대·토글 조건의 보드를 만들고, 초록(평균 아마3 이하) 매치 중
//   ① 신청 10명 이상이 됐을 때  → 'ten'
//   ② 마감임박(신청 15명 이상)이 됐을 때 → 'soon'
// 를 한 번씩 ntfy로 보냄. 자정~08시(KST)에는 보내지 않고, 그때까지 조건이 남아 있으면 08시 이후에 보냄.

import { buildBoard, type BoardItem, type BoardMatchRow } from "./board.ts";
import type { SnapLevel } from "./estimate.ts";
import type { FetchFn } from "./plab.ts";
import { kstDate } from "./time.ts";

export const NTFY_BASE = "https://ntfy.sh";
export const TOPIC_RE = /^[A-Za-z0-9_-]{12,64}$/;
export const QUIET_HOURS = { from: 0, to: 8 }; // KST, [from, to)
export const MAX_SENDS_PER_RUN = 8; // 수집 38 + 알림 8 < 무료 플랜 subrequest 50
/** ntfy 무료 계정 하루 250건 → 여유를 두고 200건에서 멈춤 (전체 사용자 합계) */
export const MAX_SENDS_PER_DAY = 200;
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

export function messageFor(it: BoardItem, kind: AlertKind): { title: string; body: string; tags: string } {
  const lv = shortLevel(it.estimate?.label);
  const title = kind === "soon" ? `마감임박 ${it.time} ${lv}` : `${it.time} ${lv} 매치 ${it.confirm}명 모임`;
  const extra = [it.format?.replace(/\s/g, ""), it.aiReport ? "AI리포트" : ""].filter(Boolean).join(" · ");
  const body = `${it.title}\n신청 ${it.confirm}/${it.max ?? "?"}명${extra ? " · " + extra : ""}`;
  return { title, body, tags: kind === "soon" ? "rotating_light" : "soccer" };
}

/** ntfy로 한 건 보내기. 한글 제목은 헤더에 못 넣으므로 JSON 방식으로 보냄 */
export async function sendNtfy(
  fetchFn: FetchFn,
  topic: string,
  msg: { title: string; body: string; tags: string; click?: string },
): Promise<boolean> {
  const res = await fetchFn(NTFY_BASE, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic, title: msg.title, message: msg.body, tags: [msg.tags], click: msg.click, priority: 4 }),
  });
  if (!res.ok) console.error("ntfy failed", res.status, (await res.text().catch(() => "")).slice(0, 300));
  return res.ok;
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

/** ntfy.sh 계정 토큰이 있으면 붙이는 fetch (토큰 없으면 IP 기준 공용 한도 → Cloudflare 공용 IP라 금방 막힘) */
export function ntfyFetchWith(token: string | undefined): FetchFn {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
}

/** 실제로 보낸 알림 종류 (하루 상한 계산용). 'ten_skipped'는 마감임박 때문에 생략한 기록이라 제외 */
export const SENT_KINDS = "('ten', 'soon', 'test')";
export const MAX_SENDS_PER_SUB_PER_RUN = 3;
export const MAX_TESTS_PER_DAY = 30;
export const MAX_SUBSCRIPTIONS = 50;

/** 오늘(UTC, ntfy 한도 기준) 실제로 보낸 알림 수 */
export async function sentTodayCount(db: D1Database, now: Date): Promise<number> {
  return (await db
    .prepare(`SELECT COUNT(*) AS n FROM alert_log WHERE ts >= ? AND kind IN ${SENT_KINDS}`)
    .bind(now.toISOString().slice(0, 10) + "T00:00:00.000Z")
    .first<number>("n")) ?? 0;
}

export async function runAlerts(db: D1Database, fetchFn: FetchFn, now = new Date()): Promise<AlertRunResult> {
  const result: AlertRunResult = { sent: 0, failed: 0, skippedQuiet: false };
  const today = kstDate(now);
  const nowIso = now.toISOString();
  // 지난 날짜 구독은 정리
  await db.prepare("DELETE FROM alert_sub WHERE date < ?").bind(today).run();
  if (isQuietHour(now)) { result.skippedQuiet = true; return result; }

  // 하루 상한 (ntfy 계정 한도는 UTC 자정 기준으로 초기화 → 여기서도 UTC 날짜로 셈)
  const budget = Math.min(MAX_SENDS_PER_RUN, MAX_SENDS_PER_DAY - (await sentTodayCount(db, now)));
  if (budget <= 0) return result;
  // 순서를 매번 섞어서, 계속 실패하는 구독이 다른 구독을 막지 않게 함
  const { results: subs } = await db.prepare("SELECT * FROM alert_sub ORDER BY RANDOM()").all<AlertSub>();
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
      // 마감임박을 보냈거나 같이 보낼 매치는 10명 알림 생략 (기록만, 하루 상한에는 안 셈)
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
      const ok = await sendNtfy(fetchFn, sub.topic, { ...messageFor(item, kind), click: item.url }).catch(() => false);
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
