// 언제 무엇을 가져올지 결정하는 순수 함수들

import { HOUR, MINUTE } from "./time.ts";

export const CONFIG = {
  /** 오늘(KST)부터 며칠 앞까지 탐색할지 */
  discoveryHorizonDays: 14,
  /** 같은 규칙·날짜를 다시 탐색하는 간격 */
  discoveryIntervalMs: 15 * MINUTE,
  /** 한 번 실행에서 쓸 플랩 요청 상한 (Workers 무료 플랜 subrequest 50개 제한 아래로) */
  maxRequestsPerRun: 40,
  /** 연속 실패가 이만큼 쌓이면 추적 중단 */
  maxPollErrors: 5,
  /** 실행 기록 보관 기간 */
  runLogRetentionMs: 7 * 24 * HOUR,
};

/**
 * 신청 마감까지 남은 시간에 따른 폴링 간격.
 * 마감 직전일수록 촘촘하게: 인원이 바뀌는 순간을 놓치지 않아야 레벨 추정이 정확해짐.
 */
export function pollIntervalMs(msUntilDeadline: number): number {
  if (msUntilDeadline > 72 * HOUR) return 60 * MINUTE;
  if (msUntilDeadline > 24 * HOUR) return 15 * MINUTE;
  if (msUntilDeadline > 3 * HOUR) return 5 * MINUTE;
  return 2 * MINUTE;
}

export interface PollState {
  schedule: string;
  deadlineAt: string | null;
  lastPolledAt: string | null;
}

/** 마감 시각. 상세를 아직 못 받았으면 시작 10분 전으로 가정 (관측된 규칙). */
export function deadlineOf(s: { schedule: string; deadlineAt: string | null }): number {
  return s.deadlineAt ? Date.parse(s.deadlineAt) : Date.parse(s.schedule) - 10 * MINUTE;
}

/** 지금 폴링할 차례인지, 얼마나 밀렸는지(우선순위용, 클수록 급함) */
export function pollDue(s: PollState, now: number): { due: boolean; overdueMs: number } {
  if (!s.lastPolledAt) return { due: true, overdueMs: Number.MAX_SAFE_INTEGER };
  const interval = pollIntervalMs(deadlineOf(s) - now);
  // 크론이 1분 단위라 30초 여유를 둬서 "59초 지나서 한 주기 건너뛰기"를 막음
  const overdueMs = now - Date.parse(s.lastPolledAt) - interval + 30_000;
  return { due: overdueMs >= 0, overdueMs };
}

export interface Rule {
  id: number;
  stadiumGroupIds: number[];
  weekdays: number[];
  timeFrom: string;
  timeTo: string;
}

/** 'HH:MM' 문자열 비교로 시간대 포함 여부 (양 끝 포함) */
export function inTimeWindow(time: string, from: string, to: string): boolean {
  return time >= from && time <= to;
}
