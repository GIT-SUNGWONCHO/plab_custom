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

test("스냅샷 하나면 표시 레벨의 반올림 구간 전체 (플랩 점수)", () => {
  // 아마추어 10명 평균 아마3 → 평균 점수 2.45 이상 2.65 미만 → 합(0.1점 단위) 245~264
  const e = estimateLevel([snap("아마추어3", { a: 10 })])!;
  assert.equal(e.labelNum, 6);
  assert.ok(Math.abs(e.lo - 2.45) < 1e-9 && Math.abs(e.hi - 2.64) < 1e-9, `${e.lo}~${e.hi}`);
  assert.deepEqual([e.bandLo, e.bandHi], [2.45, 2.65]);
  assert.equal(e.rated, 10);
  assert.deepEqual(levelBucket(e), { bucket: 19, tier: "mid", narrowed: false });
});

test("루키는 평균에서 빠짐", () => {
  const e = estimateLevel([snap("아마추어5", { r: 1, a: 1 })])!;
  assert.equal(e.rated, 1);
  assert.equal(e.labelNum, 8);
});

test("평균이 3→4로 바뀌는 순간 = 3과 4의 경계 근처라는 정보", () => {
  // 아마추어 10명 아마3 (합 245~264) → 1명 추가 후 아마4 (11명, 합 292~313)
  // 새 사람은 최대 3.0 → 합 ≤ 264+30 = 294 → 평균 2.65~2.67 → 아마4(2.65~2.85) 중 낮은 쪽
  const e = estimateLevel([snap("아마추어3", { a: 10 }), snap("아마추어4", { a: 11 })])!;
  assert.equal(e.labelNum, 7);
  assert.ok(Math.abs(e.lo - 292 / 110) < 1e-9 && Math.abs(e.hi - 294 / 110) < 1e-9, `${e.lo}~${e.hi}`);
  const b = levelBucket(e);
  assert.equal(b.tier, "low");
  assert.equal(b.narrowed, true);
});

test("다시 3으로 내려오면 '높은 3'", () => {
  // 위 상황에서 아마추어 1명이 빠져 다시 아마3 → 합 ∈ [63.5, 65) / 10
  const e = estimateLevel([snap("아마추어3", { a: 10 }), snap("아마추어4", { a: 11 }), snap("아마추어3", { a: 10 })])!;
  assert.equal(e.labelNum, 6);
  assert.ok(e.lo >= 2.62 - 1e-9, `lo=${e.lo}`); // 합 262~264 → 2.62~2.64
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

test("정렬: 내 레벨 이하(그 안은 마감임박 → 시각 순) → 나머지는 마감임박 → 레벨 칸 → 6vs6 → 10명 이상 → 시각", () => {
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
  // 내 레벨(아마3) 이하 먼저: 3(아마2) → 아마3 중간들(6vs6 먼저, AI리포트는 무관) → 높은 3(2) → 추정 없음(8) → 마감(7)
  const board = buildBoard(rows, S, F);
  // 초록 그룹(3,9,4,7,1,5,6)은 시작 시각 순: 9(11:00) → 12:00끼리는 다음 기준 → 1(13:00)
  // 마감(7)도 맨 아래로 빼지 않고 같은 규칙으로 섞임 (화면에서 기본은 '마감 제외')
  assert.deepEqual(board.map((x) => x.id), [9, 3, 4, 7, 5, 6, 1, 2, 8]);
  assert.equal(board.find((x) => x.id === 2)!.atOrBelowMine, false); // 아마3 중 높은 쪽
  assert.equal(board.find((x) => x.id === 9)!.atOrBelowMine, true);

  // 마감임박(신청 15명 이상)은 내 레벨 이하 그룹 안에서 먼저
  rows.find((r) => r.id === 2)!.confirm = 15; // 높은 3 → 내 레벨 이하 아님 → 그 그룹 안에서만 먼저
  rows.find((r) => r.id === 6)!.confirm = 16; // 아마3 중간, 5vs5
  rows.find((r) => r.id === 1)!.apply_status = "hurry"; // 플랩 hurry(6명+)는 무시
  const b2 = buildBoard(rows, S, F);
  assert.deepEqual(b2.map((x) => x.id), [6, 9, 3, 4, 7, 5, 1, 2, 8]);

  // 내 레벨을 아마4로 바꾸면 높은 3(2번)도 우선 그룹 → 마감임박끼리 레벨 낮은 6번 다음 2번
  assert.deepEqual(buildBoard(rows, S, { ...F, myLevel: 7 }).map((x) => x.id).slice(0, 2), [6, 2]);
  assert.equal(b2.find((x) => x.id === 1)!.closingSoon, false);
  assert.equal(b2.find((x) => x.id === 7)!.closingSoon, false); // 마감은 마감임박 아님
  assert.equal(board.find((x) => x.id === 3)!.estimate?.label, "아마추어2");
  const ai = board.find((x) => x.id === 4)!;
  assert.equal(ai.preference, 1); // 6vs6만 가점
  assert.equal(ai.aiReport, true);
  assert.equal(ai.aiKnown, true);
  assert.equal(buildBoard([row({ id: 99, features: null })], new Map(), F)[0].aiKnown, false);
  assert.equal(board.find((x) => x.id === 5)!.enoughPlayers, false);
  assert.equal(board.find((x) => x.id === 2)!.estimate?.tier, "high");
});

test("초록 아닌 매치도 시작 시각 순 (레벨 낮은 순 아님)", () => {
  const S = new Map<number, SnapLevel[]>([
    [1, [snap("아마추어4", { a: 10 })]],
    [2, [snap("아마추어5", { a: 10 })]],
    [3, [snap("아마추어4", { a: 10 })]],
  ]);
  const rows = [row({ id: 1, kst_time: "17:00" }), row({ id: 2, kst_time: "10:00" }), row({ id: 3, kst_time: "12:00" })];
  assert.deepEqual(buildBoard(rows, S, F).map((x) => x.id), [2, 3, 1]);
});

test("신청 마감 시각이 지난 매치는 '마감'으로 (수집이 멈춰 상태가 신청가능으로 남아도)", () => {
  const r = row({ id: 1, schedule: "2026-11-22T03:00:00Z", deadline_at: "2026-11-22T02:50:00Z", apply_status: "available", confirm: 16 });
  const before = buildBoard([r], new Map(), F, Date.parse("2026-11-22T02:49:00Z"))[0];
  const after = buildBoard([r], new Map(), F, Date.parse("2026-11-22T02:51:00Z"))[0];
  assert.deepEqual([before.full, before.closingSoon], [false, true]);
  assert.deepEqual([after.full, after.closingSoon], [true, false]);
});

test("1명 평균 아마1이면 점수 2.1~2.2 → 아마1 한가운데, 높은 쪽 아님", () => {
  const e = estimateLevel([snap("아마추어1", { a: 1 })])!;
  assert.ok(Math.abs(e.lo - 2.1) < 1e-9 && Math.abs(e.hi - 2.2) < 1e-9);
  assert.equal(levelBucket(e).tier, "mid");
});

test("●는 구간이 아주 좁을 때만 (넓으면 표시 없음)", () => {
  const wide = estimateLevel([snap("아마추어3", { a: 6 })])!;
  assert.equal(levelBucket(wide).narrowed, false);
  // 레벨 폭(0.2)의 30% 이하로 좁고 가운데면 ●
  const narrow = { lo: 2.54, hi: 2.57, label: "아마추어3", labelNum: 6, bandLo: 2.45, bandHi: 2.65, rated: 10 };
  assert.deepEqual([levelBucket(narrow).tier, levelBucket(narrow).narrowed], ["mid", true]);
});

test("한 명이 들어와 평균이 3→4로 오르면 그 사람은 아마4~5", async () => {
  const { traceLevels } = await import("../src/estimate.ts");
  const t = traceLevels([snap("아마추어3", { a: 10 }), snap("아마추어4", { a: 11 })]);
  assert.deepEqual(t[1].changes, [{ grade: "amateur", delta: 1 }]);
  // 합이 264 이하 → 292 이상으로 → 새 사람 ≥ 2.8 (아마4 상단 이상) → 아마4~5
  assert.deepEqual(t[1].person, { grade: "amateur", delta: 1, lo: 7, hi: 8 });
  // 평균이 안 바뀐 입장은 등급만 알고 범위는 등급 전체 → person 없음
  const t2 = traceLevels([snap("아마추어3", { a: 10 }), snap("아마추어3", { a: 11 })]);
  assert.deepEqual(t2[1].changes, [{ grade: "amateur", delta: 1 }]);
  assert.equal(t2[1].person, null);
  // 루키 입장도 변화에 표시
  const t3 = traceLevels([snap("아마추어3", { a: 10 }), snap("아마추어3", { a: 10, r: 1 })]);
  assert.deepEqual(t3[1].changes, [{ grade: "rookie", delta: 1 }]);
});

test("인원과 비율이 안 맞는 스냅샷(사이에 사람이 들어옴)은 추정에 안 씀", async () => {
  const { traceLevels } = await import("../src/estimate.ts");
  // 2명인데 비율은 3명 기준(루키·비기너·아마추어 1명씩 → 33/33/33) → 합 3 ≠ 2 → 버림
  const bad = { confirm: 2, average_level: "비기너3", pct_rookie: 33, pct_beginner: 33, pct_amateur: 33, pct_semipro: 0, pct_pro: 0 };
  const t = traceLevels([snap("아마추어3", { a: 1, b: 1 }), bad, snap("비기너3", { r: 1, b: 1, a: 1 })]);
  assert.equal(t[1].estimate, null);
  assert.deepEqual(t[1].changes, []);
  // 그다음 정상 스냅샷의 변화는 마지막 정상 스냅샷 기준 (+1 루키)
  assert.deepEqual(t[2].changes, [{ grade: "rookie", delta: 1 }]);
});

test("비율이 없는 스냅샷은 가짜 증감을 만들지 않음", async () => {
  const { traceLevels } = await import("../src/estimate.ts");
  const nul = { confirm: 10, average_level: "아마추어3", pct_rookie: null, pct_beginner: null, pct_amateur: null, pct_semipro: null, pct_pro: null };
  const t = traceLevels([snap("아마추어3", { a: 10 }), nul, snap("아마추어3", { a: 10 })]);
  assert.deepEqual(t[1].changes, []);
  assert.deepEqual(t[2].changes, []);
});

test("단서 없이 인원만 적어서 치우친 범위는 표시 없음 (2명 · 아마3)", () => {
  const s: SnapLevel = { confirm: 2, average_level: "아마추어3", pct_rookie: 0, pct_beginner: 0, pct_amateur: 100, pct_semipro: 0, pct_pro: 0 };
  const e = estimateLevel([s])!;
  assert.ok(Math.abs(e.lo - 2.45) < 1e-9 && Math.abs(e.hi - 2.6) < 1e-9);
  assert.deepEqual(levelBucket(e), { bucket: 19, tier: "mid", narrowed: false });
});

test("기본 범위: 2명 아마3 = 2.45~2.6, 10명 = 2.45~2.64", async () => {
  const { baselineRange } = await import("../src/estimate.ts");
  const r2 = baselineRange(6, 2), r10 = baselineRange(6, 10);
  assert.ok(Math.abs(r2[0] - 2.45) < 1e-9 && Math.abs(r2[1] - 2.6) < 1e-9);
  assert.ok(Math.abs(r10[0] - 2.45) < 1e-9 && Math.abs(r10[1] - 2.64) < 1e-9);
});

test("개인 레벨 관측: 혼자일 때 레벨 + 한 명 들고 남, 사전 분포는 관측 쪽으로", async () => {
  const { levelObservations, levelPrior } = await import("../src/estimate.ts");
  const snap = (ts: string, confirm: number, avg: string, amateur = 100, rookie = 0): SnapLevel & { ts: string } =>
    ({ ts, confirm, average_level: avg, pct_rookie: rookie, pct_beginner: 0, pct_amateur: amateur, pct_semipro: 0, pct_pro: 0 });
  const obs = levelObservations(7, [snap("t0", 0, "루키", 0), snap("t1", 1, "아마추어3"), snap("t2", 2, "아마추어4")]);
  assert.deepEqual(obs.map((o) => [o.kind, o.lo, o.hi]), [["solo", 6, 6], ["person", 7, 8]]);
  const w = levelPrior([{ lo: 8, hi: 8, n: 30 }, { lo: 4, hi: 8, n: 10 }]);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(w[8] > w[6] && w[6] > w[1]);
});
