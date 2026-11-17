-- 웹푸시 구독: 기기(토픽)마다 하나. 있으면 ntfy 대신 웹푸시로 보냄
CREATE TABLE push_sub (
  topic      TEXT PRIMARY KEY,          -- alert_sub.topic 과 같은 기기 id
  endpoint   TEXT NOT NULL,             -- 애플/구글 푸시 서버의 이 기기 배달 주소
  p256dh     TEXT NOT NULL,             -- 기기 공개키 (내용 암호화용)
  auth       TEXT NOT NULL,             -- 기기와 나눈 비밀값
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
