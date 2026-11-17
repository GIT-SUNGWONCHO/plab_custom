-- 알림은 웹푸시만: PC 발송기 목록 삭제, 웹푸시 구독 없는 예전(ntfy) 알림 구독 정리
DROP TABLE IF EXISTS alert_outbox;
DELETE FROM alert_log WHERE topic NOT IN (SELECT topic FROM push_sub);
DELETE FROM alert_sub WHERE topic NOT IN (SELECT topic FROM push_sub);
