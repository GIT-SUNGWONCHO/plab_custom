// 매치 보드: 거르기 + 정렬 (순수 함수)
//
// 1. 거르기: 날짜·시작 시간대, 참가 레벨 제한 없는(일반) 매치만, 여자 매치 제외
// 1. 평균이 내 레벨 이하인 매치(초록) 먼저 (내 레벨과 같으면 그 레벨 중 높은 쪽은 제외), 그다음 나머지
// 2. 각 그룹 안에서 마감임박(신청 15명 이상) 먼저
// 3. 경기 시작 시각 순
// 4. 같은 시각이면: 레벨 칸 낮은 순 → 6vs6 → 신청 10명 이상 (AI리포트는 정렬에 안 씀 — 화면에서 필터로)
// 4. 그다음 신청 인원 10명 미만은 아래로
// 5. 그래도 같으면 경기 시작이 빠른 순
// 마감된 매치도 같은 규칙으로 정렬 (화면에서 기본은 '마감 제외')

import { estimateLevel, levelBucket, type Estimate, type SnapLevel, type Tier } from "./estimate.ts";
import { matchUrl } from "./plab.ts";

export interface BoardMatchRow {
  id: number;
  title: string | null;
  stadium_group: string | null;
  kst_date: string;
  kst_time: string;
  schedule: string;
  deadline_at: string | null;
  format: string | null;
  level_rule: string | null;
  level_code: number | null;
  sex: number | null;
  features: string | null;
  confirm: number | null;
  max_players: number | null;
  min_players: number | null;
  apply_status: string | null;
  average_level: string | null;
}

export interface BoardFilter {
  date: string; // KST 'YYYY-MM-DD'
  from: string; // 'HH:MM'
  to: string;
  /** 내 레벨 점수 (아마3 = 6) */
  myLevel?: number;
}

export interface BoardItem {
  id: number;
  url: string;
  title: string;
  date: string;
  time: string;
  deadlineAt: string | null;
  format: string | null;
  is6v6: boolean;
  aiReport: boolean;
  /** AI리포트 여부를 아직 모르면 false (상세·목록 정보 수집 전) */
  aiKnown: boolean;
  sex: number | null;
  confirm: number;
  max: number | null;
  applyStatus: string | null;
  full: boolean;
  /** 마감임박: 마감 전이고 신청 CLOSING_SOON_PLAYERS명 이상 (플랩의 hurry는 6명 이상이라 쓰지 않음) */
  closingSoon: boolean;
  averageLevel: string | null;
  estimate: (Estimate & { tier: Tier; narrowed: boolean }) | null;
  bucket: number | null;
  /** 평균이 내 레벨 이하 (초록 표시) */
  atOrBelowMine: boolean;
  preference: number;
  enoughPlayers: boolean;
}

export const MIN_RELIABLE_PLAYERS = 10;
export const CLOSING_SOON_PLAYERS = 15;

const isUnrestricted = (m: BoardMatchRow) =>
  m.level_code != null ? m.level_code === 0 : m.level_rule == null || m.level_rule === "일반" || m.level_rule === "모든 레벨";

export function buildBoard(rows: BoardMatchRow[], snapsByMatch: Map<number, SnapLevel[]>, f: BoardFilter): BoardItem[] {
  const my = f.myLevel ?? 6;
  const items = rows
    .filter((m) => m.kst_date === f.date && m.kst_time >= f.from && m.kst_time <= f.to)
    .filter(isUnrestricted)
    .filter((m) => m.sex !== -1)
    .map((m): BoardItem => {
      const features: string[] = m.features ? JSON.parse(m.features) : [];
      const est = estimateLevel(snapsByMatch.get(m.id) ?? []);
      const b = est ? levelBucket(est) : null;
      const is6v6 = (m.format ?? "").replace(/\s/g, "") === "6vs6";
      const aiReport = features.includes("ai_report");
      const confirm = m.confirm ?? 0;
      return {
        id: m.id,
        url: matchUrl(m.id),
        title: m.title ?? m.stadium_group ?? `매치 ${m.id}`,
        date: m.kst_date,
        time: m.kst_time,
        deadlineAt: m.deadline_at,
        format: m.format,
        is6v6,
        aiReport,
        aiKnown: m.features != null,
        sex: m.sex,
        confirm,
        max: m.max_players,
        applyStatus: m.apply_status,
        full: m.apply_status === "full",
        closingSoon: m.apply_status !== "full" && confirm >= CLOSING_SOON_PLAYERS,
        averageLevel: m.average_level,
        estimate: est && b ? { ...est, tier: b.tier, narrowed: b.narrowed } : null,
        bucket: b ? b.bucket : null,
        atOrBelowMine: !!est && !!b &&
          (est.labelNum < my || (est.labelNum === my && !(b.narrowed && b.tier === "high"))),
        preference: is6v6 ? 1 : 0,
        enoughPlayers: confirm >= MIN_RELIABLE_PLAYERS,
      };
    });

  return items.sort(
    (a, b) =>
      Number(b.atOrBelowMine) - Number(a.atOrBelowMine) ||
      Number(b.closingSoon) - Number(a.closingSoon) ||
      a.time.localeCompare(b.time) ||
      (a.bucket ?? 99) - (b.bucket ?? 99) ||
      b.preference - a.preference ||
      Number(b.enoughPlayers) - Number(a.enoughPlayers) ||
      a.id - b.id,
  );
}
