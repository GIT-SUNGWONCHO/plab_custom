-- 보드 필터·정렬용 매치 속성
--   level_code: 참가 레벨 제한 (0 = 일반/모든 레벨, 3 = 아마추어2 이하, 5 = 아마추어4 이상 ...)
--   features:   JSON 배열, 예: ["ai_report","screen"]
--   sex(기존):   0 = 성별 무관, 1 = 남자, -1 = 여자
ALTER TABLE match ADD COLUMN level_code INTEGER;
ALTER TABLE match ADD COLUMN features TEXT;
