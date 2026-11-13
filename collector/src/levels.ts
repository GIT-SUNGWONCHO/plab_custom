// 플랩 레벨 → 순서형 점수.
// 루키(0)는 미평가 상태라 매치 평균 레벨 계산에서 제외됨.
//   비기너1~3 = 1~3, 아마추어1~5 = 4~8, 세미프로1~3 = 9~11, 프로 = 12

export const GRADE_RANGES = {
  rookie: [0, 0],
  beginner: [1, 3],
  amateur: [4, 8],
  semipro: [9, 11],
  pro: [12, 12],
} as const;

export type Grade = keyof typeof GRADE_RANGES;
export const GRADES = Object.keys(GRADE_RANGES) as Grade[];

const PREFIX: Record<string, Grade> = {
  루키: "rookie",
  비기너: "beginner",
  아마추어: "amateur",
  세미프로: "semipro",
  프로: "pro",
};

/** "아마추어3" → 6, "프로" → 12, "루키" → 0. 알 수 없으면 null. */
export function levelToNum(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = /^(루키|비기너|아마추어|세미프로|프로)\s*(\d)?$/.exec(label.trim());
  if (!m) return null;
  const grade = PREFIX[m[1]];
  const [lo, hi] = GRADE_RANGES[grade];
  if (lo === hi) return m[2] ? null : lo;
  if (!m[2]) return null; // 그룹 이름만 있으면 정확한 점수를 알 수 없음
  const n = lo + Number(m[2]) - 1;
  return n >= lo && n <= hi ? n : null;
}

const NAMES: string[] = [
  "루키",
  "비기너1", "비기너2", "비기너3",
  "아마추어1", "아마추어2", "아마추어3", "아마추어4", "아마추어5",
  "세미프로1", "세미프로2", "세미프로3",
  "프로",
];

export function numToLevel(n: number): string | null {
  return Number.isInteger(n) ? NAMES[n] ?? null : null;
}
