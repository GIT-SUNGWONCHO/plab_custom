// KST(UTC+9, 서머타임 없음) 날짜 계산 헬퍼

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC 시각 → KST 'YYYY-MM-DD' */
export function kstDate(d: Date): string {
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** UTC 시각 → KST 'HH:MM' */
export function kstTime(d: Date): string {
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(11, 16);
}

/** 'YYYY-MM-DD' → 요일 (0=일 ... 6=토) */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 오늘(KST)부터 days일 동안의 날짜 목록 */
export function upcomingKstDates(now: Date, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) out.push(kstDate(new Date(now.getTime() + i * DAY_MS)));
  return out;
}

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
