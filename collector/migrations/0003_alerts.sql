-- ntfy 알림 구독: 토픽마다 조건 하나 (보드에서 🔔로 현재 필터를 저장)
CREATE TABLE alert_sub (
  topic      TEXT PRIMARY KEY,          -- ntfy 토픽 (무작위 문자열, 사실상 비밀번호 역할)
  date       TEXT NOT NULL,             -- KST 'YYYY-MM-DD'
  time_from  TEXT NOT NULL,             -- 'HH:MM'
  time_to    TEXT NOT NULL,
  only6      INTEGER NOT NULL DEFAULT 0,
  only_ai    INTEGER NOT NULL DEFAULT 0,
  only_tf    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 보낸 알림 (같은 매치·같은 종류는 한 번만)
CREATE TABLE alert_log (
  topic    TEXT NOT NULL,
  match_id INTEGER NOT NULL,
  kind     TEXT NOT NULL,               -- 'ten' (초록 + 신청 10명 이상) | 'soon' (초록 + 마감임박)
  ts       TEXT NOT NULL,
  PRIMARY KEY (topic, match_id, kind)
);
