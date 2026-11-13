import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { levelToNum, numToLevel } from "../src/levels.ts";
import { parseDetail, parseLevelGraph, parseList, PlabSchemaError } from "../src/plab.ts";
import { deadlineOf, inTimeWindow, pollDue, pollIntervalMs } from "../src/schedule.ts";
import { HOUR, kstDate, kstTime, MINUTE, upcomingKstDates, weekdayOf } from "../src/time.ts";

const sample = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../docs/samples/${name}`, import.meta.url), "utf8"));

test("레벨 라벨 ↔ 점수", () => {
  assert.equal(levelToNum("루키"), 0);
  assert.equal(levelToNum("비기너1"), 1);
  assert.equal(levelToNum("비기너3"), 3);
  assert.equal(levelToNum("아마추어1"), 4);
  assert.equal(levelToNum("아마추어3"), 6);
  assert.equal(levelToNum("아마추어5"), 8);
  assert.equal(levelToNum("세미프로3"), 11);
  assert.equal(levelToNum("프로"), 12);
  // 알 수 없는 / 범위 밖
  assert.equal(levelToNum("아마추어"), null);
  assert.equal(levelToNum("아마추어6"), null);
  assert.equal(levelToNum("비기너4"), null);
  assert.equal(levelToNum(null), null);
  assert.equal(levelToNum("일반"), null);
  for (let n = 0; n <= 12; n++) assert.equal(levelToNum(numToLevel(n)), n);
});

test("KST 날짜 계산", () => {
  // 목록 샘플: time "01:00", schedule 전날 16:00 UTC
  const d = new Date("2026-11-13T16:00:00+00:00");
  assert.equal(kstDate(d), "2026-11-14");
  assert.equal(kstTime(d), "01:00");
  assert.equal(weekdayOf("2026-11-14"), 6); // 토
  assert.equal(weekdayOf("2026-11-15"), 0); // 일
  // KST 자정 직전/직후
  assert.deepEqual(upcomingKstDates(new Date("2026-11-13T14:59:00Z"), 2), ["2026-11-13", "2026-11-14"]);
  assert.deepEqual(upcomingKstDates(new Date("2026-11-13T15:00:00Z"), 2), ["2026-11-14", "2026-11-15"]);
});

test("목록 파서: 실제 응답 샘플", () => {
  const { matches, next } = parseList(sample("social-matches-list.json"));
  assert.equal(matches.length, 3);
  assert.equal(matches[0].id, 1068921);
  assert.equal(matches[0].kstTime, "01:00");
  assert.equal(matches[0].stadiumGroup, "용인 기흥 낫소 풋살파크");
  assert.equal(matches[0].levelRule, "일반");
  assert.ok(next?.includes("page=2"));
});

test("상세 파서: 실제 응답 샘플", () => {
  const d = parseDetail(sample("social-match-detail.json"));
  assert.equal(d.id, 1134792);
  assert.equal(d.confirm, 11);
  assert.equal(d.max, 18);
  assert.equal(d.min, 10);
  assert.equal(d.applyStatus, "hurry");
  assert.equal(d.lifecycle, "CLOSING_SOON"); // 실제 값: 마감 임박 매치
  // 마감 = 시작 10분 전
  assert.equal(Date.parse(d.schedule) - Date.parse(d.deadlineAt!), 10 * MINUTE);
  assert.ok(d.stadiumGroupId && d.stadiumId);
});

test("레벨 그래프 파서", () => {
  const g = parseLevelGraph(sample("level-graph.json"));
  assert.equal(g.averageLevel, "아마추어3");
  assert.deepEqual(g.pct, { rookie: 9, beginner: 9, amateur: 73, semipro: 9, pro: 0 });
});

test("스키마가 바뀌면 조용히 넘어가지 않고 에러", () => {
  assert.throws(() => parseList({ data: { items: [] } }), PlabSchemaError);
  assert.throws(() => parseDetail({ data: { match: { id: 1 } } }), PlabSchemaError);
  assert.throws(() => parseLevelGraph({ data: {} }), PlabSchemaError);
});

test("마감까지 남은 시간별 폴링 간격", () => {
  assert.equal(pollIntervalMs(100 * HOUR), 60 * MINUTE);
  assert.equal(pollIntervalMs(48 * HOUR), 15 * MINUTE);
  assert.equal(pollIntervalMs(10 * HOUR), 5 * MINUTE);
  assert.equal(pollIntervalMs(1 * HOUR), 2 * MINUTE);
});

test("폴링 차례 판정", () => {
  const schedule = "2026-11-14T03:00:00Z";
  const deadlineAt = "2026-11-14T02:50:00Z";
  const now = Date.parse("2026-11-14T01:00:00Z"); // 마감 1h50m 전 → 2분 간격
  assert.equal(pollDue({ schedule, deadlineAt, lastPolledAt: null }, now).due, true);
  assert.equal(pollDue({ schedule, deadlineAt, lastPolledAt: new Date(now - 60_000).toISOString() }, now).due, false);
  // 크론 지터로 1분 59초만 지나도 2분 주기로 인정
  assert.equal(pollDue({ schedule, deadlineAt, lastPolledAt: new Date(now - 119_000).toISOString() }, now).due, true);
  // deadlineAt 없으면 시작 10분 전으로 가정
  assert.equal(deadlineOf({ schedule, deadlineAt: null }), Date.parse(deadlineAt));
});

test("시간대 필터 (양 끝 포함)", () => {
  assert.equal(inTimeWindow("10:00", "10:00", "14:00"), true);
  assert.equal(inTimeWindow("14:00", "10:00", "14:00"), true);
  assert.equal(inTimeWindow("09:59", "10:00", "14:00"), false);
  assert.equal(inTimeWindow("14:01", "10:00", "14:00"), false);
});
