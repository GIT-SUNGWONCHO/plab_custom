# 플랩레이더 수집기

관심 구장 × 요일 × 시간대의 플랩 매치를 찾아서, **인원·평균 레벨·레벨 분포**를 계속 기록하는 Cloudflare Worker.

- 매분 크론 → 할 일이 있을 때만 플랩에 요청 (적응형 주기)
- 변화가 있을 때만 `snapshot`에 저장 → 나중에 "높은 3 / 낮은 3" 추정과 추이 차트에 사용
- 신청은 하지 않음 (조회 전용)

## 동작

| 단계 | 내용 |
|---|---|
| 탐색 | 규칙마다 앞으로 14일 중 해당 요일의 목록 조회 (`stadium_group_id` 필터), 시간대 안의 매치를 `match`에 등록. 같은 날짜는 15분마다 다시 탐색 |
| 폴링 | 추적 중인 매치마다 상세 + level-graph 2회 요청. 마감까지 >72h: 60분 / >24h: 15분 / >3h: 5분 / 그 이하: 2분 |
| 종료 | 마감(시작 10분 전) 지남, `CLOSED`·`IN_PROGRESS`·`FINISHED`, 404, 연속 실패 5회 |
| 한도 | 1회 실행당 요청 40개 (무료 플랜 subrequest 50개 제한) — 남은 건 다음 분에 |

레벨 점수: 비기너1~3 = 1~3, 아마추어1~5 = 4~8, 세미프로1~3 = 9~11, 프로 = 12. 루키는 평균에서 제외 (평균이 "루키"면 평가된 참가자 없음 → 수치 null).

## 배포 (Cloudflare 무료 플랜)

```bash
cd collector
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler d1 create plab-radar
```
→ 출력된 `database_id`를 `wrangler.toml`에 넣기

```bash
npm run db:migrate:remote
```

```bash
npx wrangler secret put ADMIN_TOKEN
```
→ 아무 긴 랜덤 문자열 (API 호출할 때 씀)

```bash
npm run deploy
```

## 관심 규칙 등록

`BASE`는 배포 후 나오는 `https://plab-radar.<계정>.workers.dev`, `TOKEN`은 위에서 넣은 ADMIN_TOKEN.

구장 그룹 id 찾기:
```bash
curl -H "Authorization: Bearer $TOKEN" -G --data-urlencode "q=천마" "$BASE/api/stadiums/search"
```

규칙 추가 (요일: 0=일 ... 6=토, 시간은 KST 경기 시작 시각, 양 끝 포함):
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" "$BASE/api/rules" -d '{"name":"주말 낮","stadium_group_ids":[3,3639],"weekdays":[6,0],"time_from":"10:00","time_to":"14:00"}'
```

## API

| | |
|---|---|
| `GET /health` | 공개. 추적 중 매치 수, 마지막 실행 |
| `GET /api/stadiums/search?q=` | 구장 그룹 검색 |
| `GET /api/rules` · `POST /api/rules` · `DELETE /api/rules/:id` | 관심 규칙 |
| `GET /api/matches?from=YYYY-MM-DD&to=YYYY-MM-DD&tracking=1` | 매치 최신 상태 |
| `GET /api/matches/:id/snapshots` | 매치 시계열 |
| `GET /api/runs` | 최근 실행 기록 |
| `POST /api/run` | 수동 1회 실행 |

인증: `Authorization: Bearer <ADMIN_TOKEN>` 또는 `?token=`

## 개발

```bash
npm test
```
테스트는 Node 내장 `node:test` + `node:sqlite`로 D1을 흉내 냄 (`test/d1-shim.ts`), 플랩은 가짜 서버.

실제 플랩 API로 로컬 확인 (curl로 요청, `.wrangler/local-run.sqlite`에 저장):
```bash
node scripts/local-run.ts rule 3,3639 6,0 10:00-14:00
```
```bash
node scripts/local-run.ts run
```
```bash
node scripts/local-run.ts show
```

## 주의
- 비공식 API. 응답 형태가 바뀌면 파서가 `PlabSchemaError`를 내고 `run_log.errors`에 남음.
- 플랩 CDN(CloudFront)이 HTTP 클라이언트에 따라 403을 줌 (curl·Python은 통과, Node fetch는 차단). **Cloudflare Workers의 fetch는 통과 확인 (2026-11-13 배포).**

## 배포 현황
- Worker: `https://plab-radar.oroloov.workers.dev` (크론 매분)
- D1: `plab-radar` (APAC)
