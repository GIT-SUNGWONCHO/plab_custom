// 플랩풋볼 v3 API 클라이언트 (비공식, 로그인 불필요).
// 응답 형태가 바뀌면 PlabSchemaError를 던져 조용히 틀린 값이 쌓이지 않게 함.

import type { Grade } from "./levels.ts";

export const PLAB_BASE = "https://www.plabfootball.com";
const USER_AGENT = "plab-radar/0.1 (personal use)";

export class PlabSchemaError extends Error {}
export class PlabNotFoundError extends Error {}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ListedMatch {
  id: number;
  kstTime: string; // "HH:MM"
  title: string;
  stadiumGroup: string | null;
  area: string | null;
  schedule: string; // UTC ISO
  format: string | null;
  levelRule: string | null;
}

export interface MatchDetail {
  id: number;
  schedule: string;
  deadlineAt: string | null;
  lifecycle: string | null;
  applyStatus: string | null;
  title: string;
  stadiumId: number | null;
  stadiumGroupId: number | null;
  stadiumGroup: string | null;
  area: string | null;
  format: string | null;
  levelRule: string | null;
  sex: number | null;
  fee: number | null;
  confirm: number;
  max: number;
  min: number | null;
  raw: Record<string, unknown>; // 시계열에 남길 원본 일부
}

export interface LevelGraph {
  averageLevel: string | null;
  pct: Record<Grade, number | null>;
}

export interface StadiumGroup {
  id: number;
  name: string;
  address: string | null;
}

// ---------- 작은 검증 헬퍼 ----------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
function obj(v: unknown, path: string): Obj {
  if (!isObj(v)) throw new PlabSchemaError(`${path}: object 아님`);
  return v;
}
function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new PlabSchemaError(`${path}: number 아님`);
  return v;
}
function str(v: unknown, path: string): string {
  if (typeof v !== "string") throw new PlabSchemaError(`${path}: string 아님`);
  return v;
}
const optStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const optNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---------- 파서 (테스트에서 샘플 JSON으로 직접 검증) ----------
export function parseList(body: unknown): { matches: ListedMatch[]; next: string | null } {
  const data = obj(obj(body, "body").data, "data");
  if (!Array.isArray(data.results)) throw new PlabSchemaError("data.results: array 아님");
  const matches = data.results.map((r, i) => {
    const m = obj(r, `results[${i}]`);
    const a = obj(m.attributes, `results[${i}].attributes`);
    return {
      id: num(m.id, `results[${i}].id`),
      kstTime: str(m.time, `results[${i}].time`),
      title: str(m.title, `results[${i}].title`),
      stadiumGroup: optStr(a.stadium_group),
      area: optStr(a.area_label),
      schedule: str(a.schedule, `results[${i}].attributes.schedule`),
      format: optStr(a.format),
      levelRule: optStr(a.level),
    };
  });
  return { matches, next: optStr(data.next) };
}

export function parseDetail(body: unknown): MatchDetail {
  const data = obj(obj(body, "body").data, "data");
  const m = obj(data.match, "data.match");
  const p = obj(m.participants, "match.participants");
  const stadium = isObj(m.stadium) ? m.stadium : {};
  const pricing = isObj(m.pricing) ? m.pricing : {};
  return {
    id: num(m.id, "match.id"),
    schedule: str(m.schedule, "match.schedule"),
    deadlineAt: optStr(m.state_expires_at),
    lifecycle: optStr(m.lifecycle),
    applyStatus: optStr(m.apply_status),
    title: str(m.title, "match.title"),
    stadiumId: optNum(stadium.id),
    stadiumGroupId: optNum(stadium.group_id),
    stadiumGroup: optStr(stadium.name),
    area: [optStr(stadium.area_group), optStr(stadium.area)].filter(Boolean).join(" ") || null,
    format: optStr(m.format),
    levelRule: optStr(m.level_label),
    sex: optNum(m.sex),
    fee: optNum(pricing.final_fee),
    confirm: num(p.confirm, "participants.confirm"),
    max: num(p.max, "participants.max"),
    min: optNum(p.min),
    raw: {
      participants: p,
      apply_status: m.apply_status ?? null,
      applicant_progress: m.applicant_progress ?? null,
      lifecycle: m.lifecycle ?? null,
      state_expires_at: m.state_expires_at ?? null,
    },
  };
}

export function parseLevelGraph(body: unknown): LevelGraph {
  const data = obj(obj(body, "body").data, "data");
  const grades = obj(data.grades, "data.grades");
  const pctOf = (k: Grade) => (isObj(grades[k]) ? optNum((grades[k] as Obj).percentage) : null);
  return {
    averageLevel: optStr(data.average_level),
    pct: {
      rookie: pctOf("rookie"),
      beginner: pctOf("beginner"),
      amateur: pctOf("amateur"),
      semipro: pctOf("semipro"),
      pro: pctOf("pro"),
    },
  };
}

export function parseStadiumSearch(body: unknown): StadiumGroup[] {
  const data = obj(body, "body").data;
  if (!Array.isArray(data)) throw new PlabSchemaError("data: array 아님");
  return data.map((r, i) => {
    const s = obj(r, `data[${i}]`);
    return { id: num(s.id, `data[${i}].id`), name: str(s.name, `data[${i}].name`), address: optStr(s.address) };
  });
}

// ---------- HTTP ----------
export class PlabClient {
  requests = 0;
  private fetchFn: FetchFn;
  // Workers에서는 fetch를 this 없이 호출하면 Illegal invocation → 래핑
  constructor(fetchFn: FetchFn = (input, init) => fetch(input, init)) {
    this.fetchFn = fetchFn;
  }

  private async getJson(path: string): Promise<unknown> {
    this.requests++;
    const res = await this.fetchFn(PLAB_BASE + path, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    if (res.status === 404) throw new PlabNotFoundError(path);
    if (!res.ok) throw new Error(`plab ${res.status} ${path}`);
    return res.json();
  }

  /** 날짜(KST) + 구장 그룹들로 목록 조회, 모든 페이지를 따라감 */
  async listMatches(date: string, stadiumGroupIds: number[], maxPages = 5): Promise<ListedMatch[]> {
    const out: ListedMatch[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const q = new URLSearchParams({ date, page: String(page), page_size: "50" });
      for (const id of stadiumGroupIds) q.append("stadium_group_id", String(id));
      const { matches, next } = parseList(await this.getJson(`/api/v3/social-matches/?${q}`));
      out.push(...matches);
      if (!next || matches.length === 0) break;
    }
    return out;
  }

  async matchDetail(id: number): Promise<MatchDetail> {
    return parseDetail(await this.getJson(`/api/v3/social-matches/${id}/`));
  }

  async levelGraph(id: number): Promise<LevelGraph> {
    return parseLevelGraph(await this.getJson(`/api/v3/social-matches/${id}/level-graph/`));
  }

  async searchStadiums(q: string, limit = 10): Promise<StadiumGroup[]> {
    const qs = new URLSearchParams({ q, limit: String(limit) });
    return parseStadiumSearch(await this.getJson(`/api/v3/stadium-groups/search/?${qs}`));
  }
}

export const matchUrl = (id: number) => `${PLAB_BASE}/match/${id}/`;
