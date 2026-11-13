// 수집 1회 실행: (1) 관심 규칙으로 매치 탐색 → (2) 추적 중인 매치 폴링 → 변화 있으면 스냅샷 저장

import { levelToNum } from "./levels.ts";
import { PlabClient, PlabNotFoundError, type LevelGraph, type MatchDetail } from "./plab.ts";
import { CONFIG, deadlineOf, inTimeWindow, pollDue, type Rule } from "./schedule.ts";
import { kstDate, kstTime, upcomingKstDates, weekdayOf } from "./time.ts";

export interface RunResult {
  discovered: number;
  polled: number;
  snapshots: number;
  stopped: number;
  requests: number;
  errors: string[];
}

interface MatchRow {
  id: number;
  schedule: string;
  deadline_at: string | null;
  last_polled_at: string | null;
  poll_errors: number;
}

interface SnapshotRow {
  confirm: number | null;
  max_players: number | null;
  apply_status: string | null;
  lifecycle: string | null;
  average_level: string | null;
  pct_rookie: number | null;
  pct_beginner: number | null;
  pct_amateur: number | null;
  pct_semipro: number | null;
  pct_pro: number | null;
}

// 웹 코드의 enum: UPCOMING | CLOSING_SOON | CLOSED | IN_PROGRESS | FINISHED (+ 취소 계열 대비)
const TERMINAL_LIFECYCLES = new Set(["CLOSED", "IN_PROGRESS", "FINISHED"]);
export const isTerminal = (lc: string | null) => !!lc && (TERMINAL_LIFECYCLES.has(lc) || lc.includes("CANCEL"));

export async function loadRules(db: D1Database): Promise<Rule[]> {
  const { results } = await db
    .prepare("SELECT id, stadium_group_ids, weekdays, time_from, time_to FROM watch_rule WHERE active = 1")
    .all<{ id: number; stadium_group_ids: string; weekdays: string; time_from: string; time_to: string }>();
  return results.map((r) => ({
    id: r.id,
    stadiumGroupIds: JSON.parse(r.stadium_group_ids),
    weekdays: JSON.parse(r.weekdays),
    timeFrom: r.time_from,
    timeTo: r.time_to,
  }));
}

export async function runCollector(db: D1Database, client: PlabClient, now = new Date()): Promise<RunResult> {
  const result: RunResult = { discovered: 0, polled: 0, snapshots: 0, stopped: 0, requests: 0, errors: [] };
  const nowIso = now.toISOString();
  const budgetLeft = () => CONFIG.maxRequestsPerRun - client.requests;

  // ---------- 1. 탐색 ----------
  const rules = await loadRules(db);
  const dates = upcomingKstDates(now, CONFIG.discoveryHorizonDays);
  for (const rule of rules) {
    if (rule.stadiumGroupIds.length === 0) continue;
    for (const date of dates) {
      if (!rule.weekdays.includes(weekdayOf(date))) continue;
      if (budgetLeft() < 10) break; // 폴링 몫은 남겨둠
      const key = `discovered:${rule.id}:${date}`;
      const last = await db.prepare("SELECT value FROM state WHERE key = ?").bind(key).first<string>("value");
      if (last && now.getTime() - Date.parse(last) < CONFIG.discoveryIntervalMs) continue;
      try {
        const listed = await client.listMatches(date, rule.stadiumGroupIds);
        const stmts = listed
          .filter((m) => inTimeWindow(m.kstTime, rule.timeFrom, rule.timeTo))
          .filter((m) => Date.parse(m.schedule) > now.getTime())
          .map((m) =>
            db
              .prepare(
                `INSERT INTO match (id, rule_id, title, stadium_group, area, schedule, kst_date, kst_time,
                                    format, level_rule, first_seen_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO NOTHING`,
              )
              .bind(m.id, rule.id, m.title, m.stadiumGroup, m.area, m.schedule, date, m.kstTime,
                    m.format, m.levelRule, nowIso),
          );
        stmts.push(
          db.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(key, nowIso),
        );
        const res = await db.batch(stmts);
        result.discovered += res.slice(0, -1).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
      } catch (e) {
        result.errors.push(`discover ${rule.id} ${date}: ${String(e)}`);
      }
    }
  }

  // ---------- 2. 폴링 ----------
  const { results: tracked } = await db
    .prepare("SELECT id, schedule, deadline_at, last_polled_at, poll_errors FROM match WHERE tracking = 1")
    .all<MatchRow>();

  // 마감이 지난 매치는 추적 종료 (마지막 상태는 직전 폴링에 이미 기록됨)
  const stops: D1PreparedStatement[] = [];
  const live: MatchRow[] = [];
  for (const m of tracked) {
    if (now.getTime() > deadlineOf({ schedule: m.schedule, deadlineAt: m.deadline_at }) + 60_000) {
      stops.push(db.prepare("UPDATE match SET tracking = 0, stop_reason = 'deadline_passed' WHERE id = ?").bind(m.id));
      result.stopped++;
    } else live.push(m);
  }

  const due = live
    .map((m) => ({ m, ...pollDue({ schedule: m.schedule, deadlineAt: m.deadline_at, lastPolledAt: m.last_polled_at }, now.getTime()) }))
    .filter((x) => x.due)
    .sort((a, b) => b.overdueMs - a.overdueMs);

  for (const { m } of due) {
    if (budgetLeft() < 2) break; // 매치당 상세 + 레벨그래프 2회
    try {
      const detail = await client.matchDetail(m.id);
      const graph = await client.levelGraph(m.id);
      const changed = await saveObservation(db, detail, graph, nowIso);
      result.polled++;
      if (changed) result.snapshots++;
      if (isTerminal(detail.lifecycle)) {
        stops.push(db.prepare("UPDATE match SET tracking = 0, stop_reason = ? WHERE id = ?")
          .bind(`lifecycle:${detail.lifecycle}`, m.id));
        result.stopped++;
      }
    } catch (e) {
      if (e instanceof PlabNotFoundError) {
        stops.push(db.prepare("UPDATE match SET tracking = 0, stop_reason = 'not_found' WHERE id = ?").bind(m.id));
        result.stopped++;
      } else {
        result.errors.push(`poll ${m.id}: ${String(e)}`);
        const giveUp = m.poll_errors + 1 >= CONFIG.maxPollErrors;
        if (giveUp) result.stopped++;
        stops.push(
          db.prepare(
            `UPDATE match SET poll_errors = poll_errors + 1, last_polled_at = ?,
                    tracking = CASE WHEN ? THEN 0 ELSE tracking END,
                    stop_reason = CASE WHEN ? THEN 'too_many_errors' ELSE stop_reason END
             WHERE id = ?`,
          ).bind(nowIso, giveUp ? 1 : 0, giveUp ? 1 : 0, m.id),
        );
      }
    }
  }
  if (stops.length) await db.batch(stops);

  result.requests = client.requests;
  if (result.discovered || result.polled || result.errors.length) {
    await db.batch([
      db.prepare("INSERT INTO run_log (ts, discovered, polled, snapshots, requests, errors) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(nowIso, result.discovered, result.polled, result.snapshots, result.requests,
              result.errors.length ? JSON.stringify(result.errors) : null),
      db.prepare("DELETE FROM run_log WHERE ts < ?")
        .bind(new Date(now.getTime() - CONFIG.runLogRetentionMs).toISOString()),
    ]);
  }
  return result;
}

/** 최신 상태를 match에 반영하고, 직전 스냅샷과 다르면 새 스냅샷을 쌓음. 변화 여부 반환. */
export async function saveObservation(
  db: D1Database,
  d: MatchDetail,
  g: LevelGraph,
  nowIso: string,
): Promise<boolean> {
  // 루키는 평균에서 제외되므로, 평균이 "루키"라는 건 평가된 참가자가 없다는 뜻 → 수치 없음
  const avgNum = g.averageLevel === "루키" ? null : levelToNum(g.averageLevel);
  const next: SnapshotRow = {
    confirm: d.confirm,
    max_players: d.max,
    apply_status: d.applyStatus,
    lifecycle: d.lifecycle,
    average_level: g.averageLevel,
    pct_rookie: g.pct.rookie,
    pct_beginner: g.pct.beginner,
    pct_amateur: g.pct.amateur,
    pct_semipro: g.pct.semipro,
    pct_pro: g.pct.pro,
  };
  const prev = await db
    .prepare(
      `SELECT confirm, max_players, apply_status, lifecycle, average_level,
              pct_rookie, pct_beginner, pct_amateur, pct_semipro, pct_pro
       FROM snapshot WHERE match_id = ? ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .bind(d.id)
    .first<SnapshotRow>();
  const changed = !prev || (Object.keys(next) as (keyof SnapshotRow)[]).some((k) => prev[k] !== next[k]);

  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE match SET title = ?, stadium_group = COALESCE(?, stadium_group), stadium_group_id = ?, stadium_id = ?,
              area = COALESCE(?, area), schedule = ?, kst_date = ?, kst_time = ?, deadline_at = ?,
              format = COALESCE(?, format), level_rule = COALESCE(?, level_rule), sex = ?, fee = ?,
              max_players = ?, min_players = ?, confirm = ?, apply_status = ?, lifecycle = ?,
              average_level = ?, average_level_num = ?, last_polled_at = ?, poll_errors = 0,
              last_changed_at = CASE WHEN ? THEN ? ELSE last_changed_at END
       WHERE id = ?`,
    ).bind(
      d.title, d.stadiumGroup, d.stadiumGroupId, d.stadiumId,
      d.area, d.schedule, kstDate(new Date(d.schedule)), kstTime(new Date(d.schedule)), d.deadlineAt,
      d.format, d.levelRule, d.sex, d.fee,
      d.max, d.min, d.confirm, d.applyStatus, d.lifecycle,
      g.averageLevel, avgNum, nowIso,
      changed ? 1 : 0, nowIso,
      d.id,
    ),
  ];
  if (changed) {
    stmts.push(
      db.prepare(
        `INSERT INTO snapshot (match_id, ts, confirm, max_players, apply_status, lifecycle, average_level,
                               average_level_num, pct_rookie, pct_beginner, pct_amateur, pct_semipro, pct_pro, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        d.id, nowIso, next.confirm, next.max_players, next.apply_status, next.lifecycle, next.average_level,
        avgNum, next.pct_rookie, next.pct_beginner, next.pct_amateur, next.pct_semipro, next.pct_pro,
        JSON.stringify({ detail: d.raw, level_graph: g }),
      ),
    );
  }
  await db.batch(stmts);
  return changed;
}
