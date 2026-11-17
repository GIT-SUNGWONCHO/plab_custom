-- PC 발송기용 보낼 알림 목록: 워커가 쌓고, PC가 가져가서 ntfy로 보낸 뒤 완료 표시
-- (ntfy 무료 한도가 IP 기준이라 Cloudflare·구글 공용 IP에서는 금방 막힘 → 집 IP에서 발송)
CREATE TABLE alert_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payload    TEXT NOT NULL,             -- ntfy JSON 그대로 ({topic, title, message, tags, click, priority})
  created_at TEXT NOT NULL,
  sent_at    TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX alert_outbox_pending ON alert_outbox (sent_at, id);
