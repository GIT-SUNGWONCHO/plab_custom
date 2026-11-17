// 매치 평균 레벨을 "점수 구간"으로 추정
//
// 플랩 내부에서 레벨은 0.1~5.0 점수 구간 (웹 코드의 레벨표):
//   비기너1 0.1~1.0 · 비기너2 1.1~1.4 · 비기너3 1.5~2.0 · 아마1 2.1~2.2 · 아마2 2.3~2.4 · 아마3 2.5~2.6
//   아마4 2.7~2.8 · 아마5 2.9~3.0 · 세미1 3.1~3.3 · 세미2 3.4~3.6 · 세미3 3.7~4.0 · 프로 4.1~5.0
// 사람마다 소수 한 자리 점수를 가짐. 평균 레벨 표시는 루키 제외 평균 점수를 소수 첫째 자리로
// 반올림해서 레벨표에 넣은 것으로 봄 → 아마3(2.5~2.6)이면 2.45 ≤ 평균 < 2.65
//   (수집 데이터 1,639개 전이 검증: 반올림 방식·'최댓값 이하' 방식 모두 모순 8회로 구분 안 됨,
//    예전 '레벨 간격 같음' 가정은 12회. 반올림 방식은 레벨 구간의 가운데가 그 레벨의 대표 점수와 같아서 채택)
// level-graph의 등급 비율로 등급별 인원도 알 수 있음 (아마추어 k명 → 점수 합은 [2.1k, 3.0k]).
// 스냅샷이 쌓일 때마다 "점수 합"의 가능한 범위를 이어서 좁힘. 계산은 0.1점 = 1 정수 단위.
// 모순이 생기면(같은 등급 안에서 사람이 바뀌는 등 관측 못 한 변화) 그 시점부터 다시 시작.

import { levelToNum, type Grade } from "./levels.ts";

const RATED: Exclude<Grade, "rookie">[] = ["beginner", "amateur", "semipro", "pro"];
const EPS = 1e-9;

/** 레벨 번호(1=비기너1 … 12=프로)별 점수 구간, 0.1점 단위 정수 */
export const SCORE_BANDS: Record<number, [number, number]> = {
  1: [1, 10], 2: [11, 14], 3: [15, 20], 4: [21, 22], 5: [23, 24], 6: [25, 26],
  7: [27, 28], 8: [29, 30], 9: [31, 33], 10: [34, 36], 11: [37, 40], 12: [41, 50],
};
/** 등급별 점수 범위 (0.1점 단위)와 레벨 번호 범위 */
const GRADE_SCORE: Record<Exclude<Grade, "rookie">, [number, number]> = {
  beginner: [1, 20], amateur: [21, 30], semipro: [31, 40], pro: [41, 50],
};
const GRADE_LEVELS: Record<Exclude<Grade, "rookie">, [number, number]> = {
  beginner: [1, 3], amateur: [4, 8], semipro: [9, 11], pro: [12, 12],
};
/** 평균 표시 레벨 L의 평균 점수 구간: [최솟값 - 0.05, 최댓값 + 0.05) (0.1점 단위라 ±0.5) */
const bandOfAverage = (L: number): [number, number] => [SCORE_BANDS[L][0] - 0.5, SCORE_BANDS[L][1] + 0.5];
/** 한 사람의 점수(0.1점 단위) → 레벨 번호 */
const levelOfScore = (x: number): number => {
  for (let L = 1; L <= 12; L++) if (x <= SCORE_BANDS[L][1]) return L;
  return 12;
};

export interface SnapLevel {
  confirm: number | null;
  average_level: string | null;
  pct_rookie: number | null;
  pct_beginner: number | null;
  pct_amateur: number | null;
  pct_semipro: number | null;
  pct_pro: number | null;
}

export interface Estimate {
  /** 평균 점수 구간 (플랩 점수, 예: 2.53 ~ 2.58) */
  lo: number;
  hi: number;
  /** 플랩 표시 레벨 */
  label: string;
  /** 표시 레벨 번호 (1=비기너1 … 6=아마3 … 12=프로) */
  labelNum: number;
  /** 이 표시 레벨이 뜻하는 평균 점수 구간 (bandLo 이상 ~ bandHi 미만, 예: 아마3 = 2.45 ~ 2.65) */
  bandLo: number;
  bandHi: number;
  /** 평균에 들어가는 인원 (루키 제외) */
  rated: number;
}

type Counts = Record<(typeof RATED)[number], number>;

const intRange = (lo: number, hi: number): [number, number] => [Math.ceil(lo - EPS), Math.floor(hi + EPS)];

/**
 * 루키 포함 등급별 인원. 비율이 없거나, 인원과 비율이 서로 맞지 않으면 null.
 * (상세와 레벨그래프를 받는 사이에 사람이 들고 나면 비율이 다른 인원 기준이라 합이 안 맞음.
 *  비율은 정수 %라 인원이 맞으면 round(pct×n/100)의 합은 항상 n)
 */
function allCounts(s: SnapLevel): Record<Grade, number> | null {
  const n = s.confirm ?? 0;
  if (n <= 0) return null;
  const c = {} as Record<Grade, number>;
  let total = 0;
  for (const g of ["rookie", ...RATED] as Grade[]) {
    const pct = s[`pct_${g}`];
    if (pct == null) return null;
    c[g] = Math.round((pct * n) / 100);
    total += c[g];
  }
  return total === n ? c : null;
}

function counts(s: SnapLevel): Counts | null {
  const a = allCounts(s);
  if (!a) return null;
  const { rookie: _r, ...rated } = a;
  return rated as Counts;
}

export type GradeName = Grade;

export interface TraceStep {
  /** 이 시점의 평균 추정 (평가된 참가자가 없거나 모순이면 null) */
  estimate: Estimate | null;
  /** 직전 스냅샷 대비 등급별 인원 변화 (루키 포함). 0인 등급은 빠짐 */
  changes: { grade: GradeName; delta: number }[];
  /**
   * 한 명만 들어오거나 나갔을 때 그 사람의 레벨 범위 (레벨 번호).
   * 등급 범위보다 좁혀졌을 때만 값이 있음. 예: 아마추어 +1인데 [7, 8] → 아마4~5
   */
  person: { grade: GradeName; delta: 1 | -1; lo: number; hi: number } | null;
}

const ALL: Grade[] = ["rookie", ...RATED];

/** 스냅샷마다 평균 추정과 들어오고 나간 사람 정보를 계산 (레벨 추이 팝업용) */
export function traceLevels(snaps: SnapLevel[]): TraceStep[] {
  let sum: [number, number] | null = null; // 레벨 합의 가능한 범위
  let prev: Counts | null = null;
  let prevAll: Record<Grade, number> | null = null;
  const out: TraceStep[] = [];

  for (const s of snaps) {
    const n = s.confirm ?? 0;
    // 루키 포함 전체 등급 인원 (변화 표시용). 0명이면 모두 0, 비율이 없거나 안 맞으면 변화 표시 안 함
    const all = n === 0 ? (Object.fromEntries(ALL.map((g) => [g, 0])) as Record<Grade, number>) : allCounts(s);
    const changes = prevAll && all
      ? ALL.map((g) => ({ grade: g, delta: all[g] - prevAll![g] })).filter((x) => x.delta !== 0)
      : [];
    if (all) prevAll = all;

    const L = s.average_level === "루키" ? null : levelToNum(s.average_level);
    const c = counts(s);
    const rated = c ? RATED.reduce((t, g) => t + c[g], 0) : 0;
    if (L == null || !c || rated === 0) {
      sum = null; prev = null;
      out.push({ estimate: null, changes, person: null });
      continue;
    }
    // 이번 스냅샷만으로 알 수 있는 범위: 등급 구성 ∩ 평균 레벨 구간 (0.1점 단위 정수 합)
    const gLo = RATED.reduce((t, g) => t + c[g] * GRADE_SCORE[g][0], 0);
    const gHi = RATED.reduce((t, g) => t + c[g] * GRADE_SCORE[g][1], 0);
    // 평균 레벨 L → band[0] ≤ 평균 < band[1] → 합 S는 rated*band[0] ≤ S < rated*band[1] (S는 정수)
    const band = bandOfAverage(L);
    const cur: [number, number] = [
      Math.max(gLo, Math.ceil(rated * band[0] - EPS)),
      Math.min(gHi, Math.ceil(rated * band[1] - EPS) - 1),
    ];

    let next = cur;
    let carriedOk = false;
    const prevSum = sum;
    if (sum && prev) {
      // 등급별 증감만큼 합이 움직일 수 있는 범위
      let dLo = 0, dHi = 0;
      for (const g of RATED) {
        const d = c[g] - prev[g];
        const [lo, hi] = GRADE_SCORE[g];
        if (d > 0) { dLo += d * lo; dHi += d * hi; }
        else if (d < 0) { dLo += d * hi; dHi += d * lo; }
      }
      const c2 = intRange(Math.max(cur[0], sum[0] + dLo), Math.min(cur[1], sum[1] + dHi));
      if (c2[0] <= c2[1]) { next = c2; carriedOk = true; } // 모순이면 이번 스냅샷 기준으로 재시작
    }
    if (next[0] > next[1]) {
      sum = null; prev = null;
      out.push({ estimate: null, changes, person: null });
      continue;
    }

    // 평가 등급에서 정확히 한 명만 바뀌었으면 그 사람의 레벨 범위: 합의 차이 ∩ 등급 범위
    let person: TraceStep["person"] = null;
    const ratedChanges = changes.filter((x) => x.grade !== "rookie");
    if (carriedOk && prevSum && ratedChanges.length === 1 && Math.abs(ratedChanges[0].delta) === 1) {
      const { grade, delta } = ratedChanges[0];
      const g = grade as Exclude<Grade, "rookie">;
      const [gl, gh] = GRADE_SCORE[g];
      const [lo, hi] = delta === 1
        ? [Math.max(gl, next[0] - prevSum[1]), Math.min(gh, next[1] - prevSum[0])]
        : [Math.max(gl, prevSum[0] - next[1]), Math.min(gh, prevSum[1] - next[0])];
      if (lo <= hi) {
        const [ll, lh] = [levelOfScore(lo), levelOfScore(hi)];
        if (ll > GRADE_LEVELS[g][0] || lh < GRADE_LEVELS[g][1]) person = { grade, delta: delta as 1 | -1, lo: ll, hi: lh };
      }
    }

    sum = next;
    prev = c;
    out.push({
      estimate: {
        lo: next[0] / rated / 10, hi: next[1] / rated / 10, label: s.average_level!, labelNum: L,
        bandLo: band[0] / 10, bandHi: band[1] / 10, rated,
      },
      changes,
      person,
    });
  }
  return out;
}

/** 시간순 스냅샷들로 마지막 시점의 평균 구간 추정. 평가된 참가자가 없으면 null. */
export function estimateLevel(snaps: SnapLevel[]): Estimate | null {
  const t = traceLevels(snaps);
  return t.length ? t[t.length - 1].estimate : null;
}

export type Tier = "low" | "mid" | "high";

/**
 * 평균 레벨과 인원만으로 나오는 기본 범위 (플랩 점수). 점수가 0.1 단위라 인원이 적으면 레벨 구간 양끝에 못 닿음.
 * 예: 2명 · 아마3 → 점수 합 4.9~5.2 → 2.45~2.6
 */
export function baselineRange(labelNum: number, rated: number): [number, number] {
  const [bLo, bHi] = bandOfAverage(labelNum); // 0.1점 단위, bLo 이상 bHi 미만
  const n = Math.max(1, rated);
  const sLo = Math.max(Math.ceil(bLo * n - EPS), n);
  const sHi = Math.min(Math.ceil(bHi * n - EPS) - 1, 50 * n);
  return [sLo / n / 10, sHi / n / 10];
}

/**
 * 정렬용 칸: 각 레벨의 점수 구간을 낮은/중간/높은 세 칸으로 나눈 번호. 작을수록 낮음. (추정 구간 가운데 값 기준)
 * 화면 표시(tier, narrowed): 먼저 추정 구간을 "평균 레벨과 인원만으로 나오는 기본 범위"와 비교
 *   기본 범위와 같으면(등급 구성·들고 난 기록으로 새로 알게 된 게 없으면) 표시 없음, 정렬은 가운데 칸
 *   더 좁혀졌으면: 추정 중앙을 레벨 구간의 정중앙(예: 아마3 = 2.55)과 비교
 *   high: 정중앙보다 레벨 폭의 10% 넘게 위 / low: 10% 넘게 아래
 *   mid: 그 사이이면서 추정 구간이 아주 좁을 때(레벨 폭의 30% 이하)만
 */
export const TIER_DELTA = 0.1;
export const MID_MAX_WIDTH = 0.3;

export function levelBucket(e: Estimate): { bucket: number; tier: Tier; narrowed: boolean } {
  const w = e.bandHi - e.bandLo;
  const [bl, bh] = baselineRange(e.labelNum, e.rated);
  if (e.lo <= bl + 1e-6 && e.hi >= bh - 1e-6) return { bucket: e.labelNum * 3 + 1, tier: "mid", narrowed: false };
  const mid = (e.lo + e.hi) / 2;
  const third = Math.min(2, Math.max(0, Math.floor(((mid - e.bandLo) / w) * 3 + EPS)));
  const bucket = e.labelNum * 3 + third;
  const d = mid - (e.bandLo + e.bandHi) / 2;
  if (d > TIER_DELTA * w + EPS) return { bucket, tier: "high", narrowed: true };
  if (d < -TIER_DELTA * w - EPS) return { bucket, tier: "low", narrowed: true };
  return { bucket, tier: "mid", narrowed: e.hi - e.lo <= MID_MAX_WIDTH * w + EPS };
}
