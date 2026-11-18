# 플랩레이더 DB 구조 (Cloudflare D1 `plab-radar`)

2026-11-18 기준. 행 수는 그날 조회한 값이에요. 시각은 따로 적지 않으면 UTC ISO 문자열이에요 (KST = UTC + 9시간).
마이그레이션 원본: `collector/migrations/`

## 한눈에 보기

| 표 | 행 수 | 한 줄 설명 |
|---|---|---|
| `match` | 657 | 매치마다 최신 상태 한 줄 |
| `snapshot` | 2,735 | 매치 상태가 바뀔 때마다 한 줄씩 쌓이는 기록 (추이·추정의 원재료) |
| `level_obs` | 377 | 개인 레벨 관측 (사전 분포 계산용) |
| `run_log` | 7,037 | 수집기 실행 기록 (매분, 최근 며칠만 보관) |
| `alert_sub` | 1 | 기기별 알림 조건 |
| `push_sub` | 1 | 기기별 웹푸시 구독 정보 |
| `alert_log` | 5 | 보낸 알림 기록 (같은 알림 두 번 안 보내기용) |
| `watch_rule` | 1 | 관심 구장·요일·시간 규칙 |
| `state` | 9 | 여러 설정·상태 값 (키-값) |

```
watch_rule ──(탐색)──▶ match ──1:N──▶ snapshot ──(추출)──▶ level_obs
                         │
alert_sub ──1:1── push_sub
    └──1:N── alert_log ──▶ match
```

---

## match — 매치 최신 상태

| 열 | 형식 | 뜻 |
|---|---|---|
| `id` | 정수, 기본키 | 플랩 매치 번호 (`plabfootball.com/match/{id}/`) |
| `rule_id` | 정수 | 이 매치를 찾은 관심 규칙 |
| `title` | 글자 | 매치 이름 (예: 플랩 스타디움 가산 벽산디지털밸리 6차 2구장) |
| `stadium_group`, `stadium_group_id`, `stadium_id`, `area` | | 구장 그룹·구장·지역 |
| `schedule` | UTC 시각 | 경기 시작 |
| `kst_date`, `kst_time` | 'YYYY-MM-DD', 'HH:MM' | 경기 시작 (한국 시간) |
| `deadline_at` | UTC 시각 | 신청 마감 (보통 시작 10분 전) |
| `format` | 글자 | 6 vs 6 등 |
| `level_rule`, `level_code` | | 참가 레벨 제한 (0 = 제한 없음) |
| `sex` | 정수 | 0 무관 · 1 남자 · −1 여자 |
| `features` | JSON | 매치 특징 코드 (예: `["ai_report"]`) |
| `fee` | 정수 | 참가비 |
| `max_players`, `min_players`, `confirm` | 정수 | 정원 · 최소 인원 · 지금 신청 인원 |
| `apply_status`, `lifecycle` | 글자 | 플랩 상태 (available·hurry·full / UPCOMING·CLOSED 등) |
| `average_level`, `average_level_num` | | 플랩 평균 레벨 (예: 아마추어3 / 6) |
| `first_seen_at`, `last_polled_at`, `last_changed_at` | UTC 시각 | 처음 찾은 · 마지막 확인 · 마지막 변화 |
| `tracking`, `stop_reason`, `poll_errors` | | 추적 중 여부 · 멈춘 이유 · 연속 실패 수 |

## snapshot — 변화 기록

매치 상태(인원·평균·등급 비율 등)가 직전과 달라질 때만 한 줄 쌓여요.

| 열 | 뜻 |
|---|---|
| `id` | 자동 번호 |
| `match_id` | `match.id` |
| `ts` | 관측 시각 (UTC) |
| `confirm`, `max_players`, `apply_status`, `lifecycle` | 그 시점 인원·상태 |
| `average_level`, `average_level_num` | 그 시점 평균 레벨 |
| `pct_rookie`, `pct_beginner`, `pct_amateur`, `pct_semipro`, `pct_pro` | 등급별 비율 (정수 %) → 등급별 인원 계산 |
| `raw` | 플랩 응답 원본 일부 (형식이 바뀔 때 대비) |

## level_obs — 개인 레벨 관측

| 열 | 뜻 |
|---|---|
| `match_id` | 어느 매치에서 |
| `kind` | `solo` (평가된 신청자 1명 → 평균 = 그 사람 레벨) · `person` (한 명 들고 날 때 좁힌 범위) |
| `key` | 중복 방지 (solo: 레벨 번호, person: 기록 시각) |
| `lo`, `hi` | 레벨 번호 범위 (1 비기너1 … 4 아마1 … 8 아마5 … 12 프로) |
| `ts` | 기록한 시각 |

## alert_sub — 알림 조건 (기기마다 하나)

| 열 | 뜻 |
|---|---|
| `topic` | 기기 번호 (무작위, 화면 localStorage에 저장). 이름은 ntfy 시절 그대로 |
| `date`, `time_from`, `time_to` | 알림 받을 날짜 (KST)와 시작 시간대 |
| `only6`, `only_ai`, `only_tf` | 6vs6만 · AI리포트만 · 더에프만 (1 = 켬) |
| `created_at`, `updated_at` | |

날짜가 지나면 자동 삭제돼요.

## push_sub — 웹푸시 구독 (기기마다 하나)

| 열 | 뜻 |
|---|---|
| `topic` | `alert_sub.topic`과 같은 기기 번호 |
| `endpoint` | 애플·구글 푸시 서버의 이 기기 배달 주소 |
| `p256dh`, `auth` | 내용 암호화용 기기 공개키 · 비밀값 |
| `created_at`, `updated_at` | |

## alert_log — 보낸 알림

| 열 | 뜻 |
|---|---|
| `topic`, `match_id`, `kind` | 기본키: 기기 · 매치 · 종류 |
| `kind` | `ten` (10명 모임) · `soon` (마감임박) · `ten_skipped` (마감임박 때문에 생략) · `test` (테스트, match_id는 음수) |
| `ts` | 보낸 시각 |

알림을 켤 때 이미 대상인 매치도 여기에 「보낸 것」으로 들어가요 (한꺼번에 안 오게).

## run_log — 수집기 실행 기록

| 열 | 뜻 |
|---|---|
| `ts` | 실행 시각 |
| `discovered`, `polled`, `snapshots`, `requests` | 새로 찾은 매치 · 확인한 매치 · 새 기록 · 플랩 요청 수 |
| `errors` | 오류 (JSON, 없으면 비어 있음) |

## watch_rule — 관심 규칙

| 열 | 뜻 |
|---|---|
| `name` | 규칙 이름 |
| `stadium_group_ids` | 구장 그룹 번호 JSON 배열 |
| `weekdays` | 요일 JSON 배열 (0 일 … 6 토) |
| `time_from`, `time_to` | 시작 시간대 (양 끝 포함) |
| `active` | 1 = 사용 |

## state — 키-값 설정

| 키 예시 | 뜻 |
|---|---|
| `hot_windows` | 집중 감시 시간대 JSON (예: 11/22 10~17시) |
| `discovered:{날짜}` | 그 날짜 목록을 마지막으로 탐색한 시각 |
| `alert_test:{기기}` | 그 기기의 마지막 테스트 알림 시각 (1분 제한) |
| `relay_last_seen` | (안 씀) 예전 PC 발송기 흔적 |

## 인덱스

- `idx_match_date` (`match`: kst_date, kst_time) — 날짜별 목록
- `idx_match_tracking` (`match`: tracking, last_polled_at) — 수집 대상 찾기
- `idx_snapshot_match_ts` (`snapshot`: match_id, ts) — 매치별 추이
- `idx_run_log_ts` (`run_log`: ts)
