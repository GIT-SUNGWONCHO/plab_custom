-- 개인 레벨 관측: 레벨 분포(사전 분포) 추정용. 수집할 때마다 쌓임
--   solo:   평가된 신청자가 한 명일 때 → 평균 레벨 = 그 사람 레벨 (lo = hi)
--   person: 한 명만 들어오거나 나갔을 때 평균 변화로 좁힌 그 사람의 레벨 범위
CREATE TABLE level_obs (
  match_id INTEGER NOT NULL,
  kind     TEXT    NOT NULL,            -- 'solo' | 'person'
  key      TEXT    NOT NULL,            -- 같은 관측 중복 방지 (solo: 레벨 번호, person: 스냅샷 시각)
  lo       INTEGER NOT NULL,            -- 레벨 번호 1=비기너1 … 12=프로
  hi       INTEGER NOT NULL,
  ts       TEXT    NOT NULL,
  PRIMARY KEY (match_id, kind, key)
);
