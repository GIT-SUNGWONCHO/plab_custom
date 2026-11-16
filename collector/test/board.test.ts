import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBoard, type BoardMatchRow } from "../src/board.ts";
import { estimateLevel, levelBucket, type SnapLevel } from "../src/estimate.ts";

// 등급별 인원으로 스냅샷 만들기 (퍼센트는 플랩처럼 반올림)
function snap(avg: string | null, g: { r?: number; b?: number; a?: number; s?: number; p?: number }): SnapLevel {
  const c = { r: 0, b: 0, a: 0, s: 0, p: 0, ...g };
  const n = c.r + c.b + c.a + c.s + c.p;
  const pct = (k: number) => (n ? Math.round((k * 100) / n) : 0);
  return {
    confirm: n, average_level: avg,
    pct_rookie: pct(c.r), pct_beginner: pct(c.b), pct_amateur: pct(c.a), pct_semipro: pct(c.s), pct_pro: pct(c.p),
  };
}

test("스냅샷 하나면 표시 레벨의 반올림 구간 전체", () => {
  const e = estimateLevel([snap("아마추어3", { a: 10 })])!;
  assert.equal(e.labelNum, 6);
  assert.ok(Math.abs(e.lo - 5.5) < 1e-6 && Math.abs(e.hi - 6.5) < 1e-6);
  assert.equal(e.rated, 10);
  assert.deepEqual(levelBucket(e), { bucket: 19, tier: "mid", narrowed: false });
});

test("루키는 평균에서 빠짐", () => {
  const e = estimateLevel([snap("아마추어5", { r: 1, a: 1 })])!;
  assert.equal(e.rated, 1);
  assert.equal(e.labelNum, 8);
});

test("평균이 3→4로 바뀌는 순간 = 3과 4의 경계 근처라는 정보", () => {
  // 아마추어 10명 평균 아마3 (합 55~65) → 아마추어 1명 추가 후 아마4 (평균 ≥ 6.5 → 합 ≥ 71.5)
  // 새 사람은 최대 8 → 이전 합 ≥ 63.5, 이후 합 ∈ [71.5, 73]
  const e = estimateLevel([snap("아마추어3", { a: 10 }), snap("아마추어4", { a: 11 })])!;
  assert.equal(e.labelNum, 7);
  assert.ok(Math.abs(e.lo - 71.5 / 11) < 1e-6, `lo=${e.lo}`);
  assert.ok(e.hi <= 73 / 11 + 1e-6, `hi=${e.hi}`);
  const b = levelBucket(e);
  assert.equal(b.tier, "low"); // 아마4 중 낮은 편
  assert.equal(b.narrowed, true);
});

test("다시 3으로 내려오면 '높은 3'", () => {
  // 위 상황에서 아마추어 1명이 빠져 다시 아마3 → 합 ∈ [63.5, 65) / 10
  const e = estimateLevel([snap("아마추어3", { a: 10 }), snap("아마추어4", { a: 11 }), snap("아마추어3", { a: 10 })])!;
  assert.equal(e.labelNum, 6);
  assert.ok(e.lo >= 6.35 - 1e-6, `lo=${e.lo}`);
  assert.equal(levelBucket(e).tier, "high");
});

test("모순이 생기면 그 시점부터 다시 추정", () => {
  // 비기너만 있는데 평균 아마5 → 불가능 → null, 다음 정상 스냅샷부터 재시작
  const e = estimateLevel([snap("아마추어5", { b: 3 }), snap("아마추어3", { a: 10 })])!;
  assert.equal(e.labelNum, 6);
  assert.equal(levelBucket(e).narrowed, false);
});

test("평가된 참가자가 없으면 추정 없음", () => {
  assert.equal(estimateLevel([snap("루키", {})]), null);
  assert.equal(estimateLevel([snap("루키", { r: 2 })]), null);
  assert.equal(estimateLevel([]), null);
});

// ---------- 보드 ----------
let nextId = 1;
function row(p: Partial<BoardMatchRow>): BoardMatchRow {
  const id = p.id ?? nextId++;
  return {
    id, title: `구장 ${id}`, stadium_group: "구장", kst_date: "2026-11-22", kst_time: "12:00",
    schedule: "2026-11-22T03:00:00Z", deadline_at: null, format: "6 vs 6", level_rule: "모든 레벨",
    level_code: 0, sex: 0, features: "[]", confirm: 12, max_players: 18, min_players: 10,
    apply_status: "available", average_level: "아마추어3", ...p,
  };
}
const F = { date: "2026-11-22", from: "10:00", to: "17:00" };

test("거르기: 날짜·시간대, 레벨 제한 매치, 여자 매치", () => {
  const rows = [
    row({ id: 1 }),
    row({ id: 2, kst_time: "09:00" }),
    row({ id: 3, kst_time: "17:00" }), // 끝 포함
    row({ id: 4, kst_time: "18:00" }),
    row({ id: 5, kst_date: "2026-11-21" }),
    row({ id: 6, level_code: 3, level_rule: "아마추어2 이하" }),
    row({ id: 7, level_code: 5, level_rule: "아마추어4 이상" }),
    row({ id: 8, sex: -1 }), // 여자
    row({ id: 9, sex: 1 }), // 남자는 남김
    row({ id: 10, level_code: null, level_rule: "일반" }), // 아직 상세를 못 받은 매치
    row({ id: 11, level_code: null, level_rule: "아마추어2 이하" }),
  ];
  const ids = buildBoard(rows, new Map(), F).map((x) => x.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 3, 9, 10]);
});

test("정렬: 레벨 칸 → 선호도 → 10명 이상 → 시작 시각, 마감은 맨 아래", () => {
  const S = new Map<number, SnapLevel[]>([
    [1, [snap("아마추어3", { a: 10 })]], // 아마3 중간, 6vs6
    [2, [snap("아마추어3", { a: 10 }), snap("아마추어4", { a: 11 }), snap("아마추어3", { a: 10 })]], // 높은 3
    [3, [snap("아마추어2", { a: 10 })]], // 아마2 → 더 낮음 → 맨 위
    [4, [snap("아마추어3", { a: 10 })]], // 아마3 중간, 6vs6 + AI리포트
    [5, [snap("아마추어3", { a: 5 })]], // 아마3 중간, 6vs6, 5명
    [6, [snap("아마추어3", { a: 10 })]], // 아마3 중간, 5vs5
    [7, [snap("아마추어3", { a: 10 })]], // 마감
    [8, [snap("루키", { r: 2 })]], // 추정 없음
    [9, [snap("아마추어3", { a: 10 })]], // 1번과 같은 조건, 더 이른 시각
  ]);
  const rows = [
    row({ id: 1, kst_time: "13:00" }),
    row({ id: 2 }),
    row({ id: 3 }),
    row({ id: 4, features: '["ai_report","screen"]' }),
    row({ id: 5, confirm: 5 }),
    row({ id: 6, format: "5 vs 5" }),
    row({ id: 7, apply_status: "full", confirm: 18 }),
    row({ id: 8, confirm: 2, average_level: "루키" }),
    row({ id: 9, kst_time: "11:00" }),
  ];
  const board = buildBoard(rows, S, F);
  assert.deepEqual(board.map((x) => x.id), [3, 4, 9, 1, 5, 6, 2, 8, 7]);
  const first = board[0];
  assert.equal(first.estimate?.label, "아마추어2");
  const ai = board.find((x) => x.id === 4)!;
  assert.equal(ai.preference, 2);
  assert.equal(ai.aiReport, true);
  assert.equal(board.find((x) => x.id === 5)!.enoughPlayers, false);
  assert.equal(board.find((x) => x.id === 2)!.estimate?.tier, "high");
});
