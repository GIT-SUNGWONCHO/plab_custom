// 「레벨 안 위치(낮음·가운데·높음)」 판단 방식 4가지 채점 (docs/LEVEL_ESTIMATION.md 6-4-1, docs/SCORES.md)
//
// 정답 만들기: 나중에 사람이 더 들어오며 생긴 정보로 과거 시점의 점수 합 범위를 거꾸로 좁힘(역방향).
//   그 범위가 한 칸 안에 들어가면 그 시점의 실제 위치가 확정된 것 → 채점 대상.
//   그 시점까지의 정보(정방향)만으로 이미 칸이 확정됐던 시점은 뺌 (확률 모델 실력이 아니라서).
// 각 시점에서 그때까지의 정보로 네 방식이 낸 칸을 정답과 비교.
//
// 사용:
//   npx wrangler d1 execute plab-radar --remote --json --command "SELECT match_id, ts, confirm, average_level, pct_rookie, pct_beginner, pct_amateur, pct_semipro, pct_pro FROM snapshot ORDER BY match_id, ts, id" > snapshots.json
//   node scripts/position-check.ts snapshots.json            → 결과 출력
//   node scripts/position-check.ts snapshots.json --append   → docs/SCORES.md 표에 한 줄 추가

import { appendFileSync, readFileSync } from "node:fs";
import * as N from "../src/estimate.ts";

type Snap = N.SnapLevel & { match_id: number; ts: string };
const rows: Snap[] = JSON.parse(readFileSync(process.argv[2], "utf8"))[0].results;
const by = new Map<number, Snap[]>();
for (const r of rows) { if (!by.has(r.match_id)) by.set(r.match_id, []); by.get(r.match_id)!.push(r); }

// 사전 분포: 서버(/api/board, /history)와 같은 방식
const obs = [...by].flatMap(([id, ss]) => N.levelObservations(id, ss));
const gm = new Map<string, number>();
for (const o of obs) gm.set(`${o.lo}-${o.hi}`, (gm.get(`${o.lo}-${o.hi}`) ?? 0) + 1);
const prior = N.levelPrior([...gm].map(([k, n]) => { const [lo, hi] = k.split("-").map(Number); return { lo, hi, n }; }));

const GL = { beginner: [1, 3], amateur: [4, 8], semipro: [9, 11], pro: [12, 12] } as const;
const GS = { beginner: [1, 20], amateur: [21, 30], semipro: [31, 40], pro: [41, 50] } as const;
type G = keyof typeof GL;
const GRADES = Object.keys(GL) as G[];
const person = {} as Record<G, [number, number][]>;
for (const g of GRADES) {
  const [a, b] = GL[g]; let z = 0; for (let L = a; L <= b; L++) z += prior[L];
  const arr: [number, number][] = [];
  for (let L = a; L <= b; L++) { const [lo, hi] = N.SCORE_BANDS[L]; for (let x = lo; x <= hi; x++) arr.push([x, prior[L] / z / (hi - lo + 1)]); }
  person[g] = arr;
}

/** 화면 levelDist와 같은 계산: 기록 범위 안 평균값별 확률 */
function meanDist(counts: Record<string, number>, rated: number, sLo: number, sHi: number) {
  let acc = new Float64Array(1); acc[0] = 1;
  for (const g of GRADES) for (let i = 0; i < (counts[g] ?? 0); i++) {
    const nx = new Float64Array(acc.length + 50);
    for (let s = 0; s < acc.length; s++) if (acc[s]) for (const [x, p] of person[g]) nx[s + x] += acc[s] * p;
    acc = nx;
  }
  const pts: [number, number][] = []; let Z = 0;
  for (let s = sLo; s <= sHi && s < acc.length; s++) if (acc[s]) { pts.push([s, acc[s]]); Z += acc[s]; }
  return Z ? pts.map(([s, p]) => [s / rated / 10, p / Z] as [number, number]) : null;
}
// 칸: 화면 표기(아마3.x의 x, 내림)에 맞춤 .0~.2 낮음 · .3~.6 가운데 · .7~.9 높음
const third = (x01: number) => { const d = Math.min(9, Math.max(0, Math.floor(x01 * 10 + 1e-9))); return d <= 2 ? 0 : d <= 6 ? 1 : 2; };

type Rule = (pts: [number, number][], lo: number, w: number) => number;
const RULES: Record<string, Rule> = {
  "섞은 평균": (pts, lo, w) => third((pts.reduce((t, [x, p]) => t + x * p, 0) - lo) / w),
  "중앙값": (pts, lo, w) => { let c = 0; for (const [x, p] of pts) { c += p; if (c >= 0.5) return third((x - lo) / w); } return 1; },
  "확률 큰 칸": (pts, lo, w) => { const t = [0, 0, 0]; for (const [x, p] of pts) t[third((x - lo) / w)] += p; return t.indexOf(Math.max(...t)); },
  // 화면과 같음: 확률 최대값, 동률이면 동률 값들의 가운데
  "유력 평균": (pts, lo, w) => {
    const mx = Math.max(...pts.map(([, p]) => p)); const tie = pts.filter(([, p]) => p >= mx * (1 - 1e-9));
    return third((tie.reduce((t, [x]) => t + x, 0) / tie.length - lo) / w);
  },
};

const score = Object.fromEntries(Object.keys(RULES).map((k) => [k, { hit: 0, upHit: 0, downHit: 0 }]));
let n = 0, nUp = 0, nDown = 0;
for (const [, ss] of by) {
  const tr = N.traceLevels(ss);
  const cnt = ss.map((s) => N.allCounts(s));
  const fw = tr.map((t) => t.estimate ? [Math.round(t.estimate.lo * t.estimate.rated * 10), Math.round(t.estimate.hi * t.estimate.rated * 10)] : null);
  const bw = fw.map((r) => r && [...r]);
  for (let i = ss.length - 2; i >= 0; i--) {
    const a = cnt[i], b = cnt[i + 1];
    if (!bw[i] || !bw[i + 1] || !a || !b) continue;
    let dLo = 0, dHi = 0;
    for (const g of GRADES) { const d = b[g] - a[g]; const [lo, hi] = GS[g]; if (d > 0) { dLo += d * lo; dHi += d * hi; } else if (d < 0) { dLo += d * hi; dHi += d * lo; } }
    const lo = Math.max(bw[i]![0], bw[i + 1]![0] - dHi), hi = Math.min(bw[i]![1], bw[i + 1]![1] - dLo);
    if (lo <= hi) bw[i] = [lo, hi];
  }
  for (let i = 0; i < ss.length; i++) {
    const e = tr[i].estimate, c = cnt[i];
    if (!e || !bw[i] || !c || e.rated < 2) continue;
    const w = e.bandHi - e.bandLo, pos = (s: number) => (s / e.rated / 10 - e.bandLo) / w;
    const t0 = third(pos(bw[i]![0])); if (t0 !== third(pos(bw[i]![1]))) continue;      // 나중 정보로도 칸 미확정 → 제외
    if (third(pos(fw[i]![0])) === third(pos(fw[i]![1]))) continue;                     // 그때 이미 확정 → 제외
    const pts = meanDist(c, e.rated, fw[i]![0], fw[i]![1]); if (!pts) continue;
    n++; if (t0 === 2) nUp++; if (t0 === 0) nDown++;
    for (const [k, f] of Object.entries(RULES)) { const p = f(pts, e.bandLo, w); if (p === t0) { score[k].hit++; if (t0 === 2) score[k].upHit++; if (t0 === 0) score[k].downHit++; } }
  }
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const kst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
console.log(`채점 시점 ${n}개 (실제 높음 ${nUp} · 낮음 ${nDown}) · 개인 레벨 관측 ${obs.length}건 · 매치 ${by.size}개`);
for (const [k, s] of Object.entries(score)) console.log(`${k.padEnd(8)} 정확도 ${pct(s.hit, n).padStart(4)} | 높음 맞힘 ${s.upHit}/${nUp} | 낮음 맞힘 ${s.downHit}/${nDown}`);
if (process.argv.includes("--append")) {
  const cells = Object.values(score).map((s) => `${pct(s.hit, n)} (▲${s.upHit}/${nUp} ▼${s.downHit}/${nDown})`);
  appendFileSync(new URL("../../docs/SCORES.md", import.meta.url), `| ${kst} | ${by.size} | ${obs.length} | ${n} | ${cells.join(" | ")} |\n`);
  console.log("docs/SCORES.md에 추가했어요.");
}
