// 매치 평균 레벨을 "구간"으로 추정
//
// 플랩이 보여주는 평균 레벨(예: "아마추어3")은 루키를 뺀 참가자 평균을 반올림한 값으로 보임.
//   → 아마3(=6점)이면 실제 평균은 [5.5, 6.5)
//   (수집 데이터 1,630개 전이로 검증: 반올림 가설 모순 12회 vs 내림 가설 29회)
// level-graph의 등급 비율로 등급별 인원도 알 수 있음 (아마추어 k명 → 합은 [4k, 8k]).
// 스냅샷이 쌓일 때마다 "참가자 레벨 합"의 가능한 범위를 이어서 좁힘.
// 모순이 생기면(같은 등급 안에서 사람이 바뀌는 등 관측 못 한 변화) 그 시점부터 다시 시작.

import { GRADE_RANGES, levelToNum, type Grade } from "./levels.ts";

const RATED: Exclude<Grade, "rookie">[] = ["beginner", "amateur", "semipro", "pro"];
const EPS = 1e-9;

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
  /** 평균 레벨 점수 구간 (비기너1=1 … 아마1=4 … 아마5=8 … 프로=12) */
  lo: number;
  hi: number;
  /** 플랩 표시 레벨 */
  label: string;
  /** 표시 레벨 점수 */
  labelNum: number;
  /** 평균에 들어가는 인원 (루키 제외) */
  rated: number;
}

type Counts = Record<(typeof RATED)[number], number>;

const intRange = (lo: number, hi: number): [number, number] => [Math.ceil(lo - EPS), Math.floor(hi + EPS)];

function counts(s: SnapLevel): Counts | null {
  const n = s.confirm ?? 0;
  if (n <= 0) return null;
  const c = {} as Counts;
  for (const g of RATED) {
    const pct = s[`pct_${g}`];
    if (pct == null) return null;
    c[g] = Math.round((pct * n) / 100);
  }
  return c;
}

/** 시간순 스냅샷들로 마지막 시점의 평균 구간 추정. 평가된 참가자가 없으면 null. */
export function estimateLevel(snaps: SnapLevel[]): Estimate | null {
  let sum: [number, number] | null = null; // 레벨 합의 가능한 범위
  let prev: Counts | null = null;
  let last: Estimate | null = null;

  for (const s of snaps) {
    const L = s.average_level === "루키" ? null : levelToNum(s.average_level);
    const c = counts(s);
    const rated = c ? RATED.reduce((n, g) => n + c[g], 0) : 0;
    if (L == null || !c || rated === 0) {
      sum = null; prev = null; last = null;
      continue;
    }
    // 이번 스냅샷만으로 알 수 있는 범위: 등급 구성 ∩ 반올림된 평균
    const gLo = RATED.reduce((t, g) => t + c[g] * GRADE_RANGES[g][0], 0);
    const gHi = RATED.reduce((t, g) => t + c[g] * GRADE_RANGES[g][1], 0);
    // 레벨은 정수라 합도 정수 → 범위를 정수로 좁힘 (예: 1명 평균 아마1이면 합은 정확히 4)
    const cur = intRange(Math.max(gLo, rated * (L - 0.5)), Math.min(gHi, rated * (L + 0.5) - EPS));

    let next = cur;
    if (sum && prev) {
      // 등급별 증감만큼 합이 움직일 수 있는 범위
      let dLo = 0, dHi = 0;
      for (const g of RATED) {
        const d = c[g] - prev[g];
        const [lo, hi] = GRADE_RANGES[g];
        if (d > 0) { dLo += d * lo; dHi += d * hi; }
        else if (d < 0) { dLo += d * hi; dHi += d * lo; }
      }
      const carried: [number, number] = [Math.max(cur[0], sum[0] + dLo), Math.min(cur[1], sum[1] + dHi)];
      const c2 = intRange(carried[0], carried[1]);
      if (c2[0] <= c2[1]) next = c2; // 모순이면 이번 스냅샷 기준으로 재시작
    }
    if (next[0] > next[1]) { sum = null; prev = null; last = null; continue; }
    sum = next;
    prev = c;
    last = { lo: next[0] / rated, hi: next[1] / rated, label: s.average_level!, labelNum: L, rated };
  }
  return last;
}

export type Tier = "low" | "mid" | "high";

/**
 * 정렬용 칸: 각 레벨을 낮은/중간/높은 세 칸으로 나눈 번호. 작을수록 낮은 레벨. (구간 가운데 값 기준)
 * 화면 표시(tier, narrowed): 구간 중앙값을 표시 레벨의 정중앙(예: 아마3 = 6.0)과 비교
 *   high: 중앙값이 정중앙 + 0.1보다 위 / low: 정중앙 - 0.1보다 아래
 *   mid: 정중앙 ±0.1 안이면서 구간이 좁을 때(폭 ≤ 0.8)만 — 넓은 구간의 중앙값은 그냥 레벨 한가운데라 의미 없음
 */
export const TIER_DELTA = 0.1;
export const MID_MAX_WIDTH = 0.8;

export function levelBucket(e: Estimate): { bucket: number; tier: Tier; narrowed: boolean } {
  const mid = (e.lo + e.hi) / 2;
  const bucket = Math.floor((mid + 0.5) * 3 + EPS);
  const d = mid - e.labelNum;
  if (d > TIER_DELTA + EPS) return { bucket, tier: "high", narrowed: true };
  if (d < -TIER_DELTA - EPS) return { bucket, tier: "low", narrowed: true };
  return { bucket, tier: "mid", narrowed: e.hi - e.lo <= MID_MAX_WIDTH + EPS };
}
