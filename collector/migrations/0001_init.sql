-- 관심 조건: 구장 그룹 × 요일 × 시간대 (모두 KST 기준)
CREATE TABLE watch_rule (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  stadium_group_ids TEXT    NOT NULL,          -- JSON 배열, 예: [3, 3639]
  weekdays          TEXT    NOT NULL,          -- JSON 배열, 0=일 ... 6=토
  time_from         TEXT    NOT NULL,          -- 'HH:MM' 경기 시작 시각 하한 (포함)
  time_to           TEXT    NOT NULL,          -- 'HH:MM' 경기 시작 시각 상한 (포함)
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL
);

-- 추적 중인 매치 (최신 상태)
CREATE TABLE match (
  id                INTEGER PRIMARY KEY,       -- 플랩 매치 id
  rule_id           INTEGER,
  title             TEXT,
  stadium_group     TEXT,
  stadium_group_id  INTEGER,
  stadium_id        INTEGER,
  area              TEXT,
  schedule          TEXT    NOT NULL,          -- 경기 시작 (UTC ISO)
  kst_date          TEXT    NOT NULL,          -- 'YYYY-MM-DD'
  kst_time          TEXT    NOT NULL,          -- 'HH:MM'
  deadline_at       TEXT,                      -- 신청 마감 (UTC ISO, 보통 시작 10분 전)
  format            TEXT,
  level_rule        TEXT,                      -- 레벨 조건 ("모든 레벨" 등)
  sex               INTEGER,
  fee               INTEGER,
  max_players       INTEGER,
  min_players       INTEGER,
  confirm           INTEGER,
  apply_status      TEXT,                      -- available / hurry / full ...
  lifecycle         TEXT,                      -- UPCOMING ...
  average_level     TEXT,                      -- "아마추어3"
  average_level_num REAL,                      -- 6
  first_seen_at     TEXT    NOT NULL,
  last_polled_at    TEXT,
  last_changed_at   TEXT,
  tracking          INTEGER NOT NULL DEFAULT 1,
  stop_reason       TEXT,
  poll_errors       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_match_tracking ON match(tracking, last_polled_at);
CREATE INDEX idx_match_date ON match(kst_date, kst_time);

-- 변화가 있을 때만 쌓이는 시계열
CREATE TABLE snapshot (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id          INTEGER NOT NULL,
  ts                TEXT    NOT NULL,          -- 관측 시각 (UTC ISO)
  confirm           INTEGER,
  max_players       INTEGER,
  apply_status      TEXT,
  lifecycle         TEXT,
  average_level     TEXT,
  average_level_num REAL,
  pct_rookie        INTEGER,
  pct_beginner      INTEGER,
  pct_amateur       INTEGER,
  pct_semipro       INTEGER,
  pct_pro           INTEGER,
  raw               TEXT                       -- 원본 일부 (스키마 변경 대비)
);
CREATE INDEX idx_snapshot_match_ts ON snapshot(match_id, ts);

-- 키-값 상태 (마지막 탐색 시각 등)
CREATE TABLE state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 실행 기록 (무언가 한 실행만 남김, 7일 보관)
CREATE TABLE run_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  discovered  INTEGER NOT NULL,
  polled      INTEGER NOT NULL,
  snapshots   INTEGER NOT NULL,
  requests    INTEGER NOT NULL,
  errors      TEXT
);
CREATE INDEX idx_run_log_ts ON run_log(ts);
