// 「같은 매치 사람들은 비슷한 레벨끼리 모이나?」 검증 (docs/LEVEL_ESTIMATION.md 7-3)
// 사용: 스냅샷을 JSON으로 내려받은 뒤 (wrangler d1 execute --remote --json "SELECT match_id, ts, confirm, average_level, pct_* FROM snapshot ORDER BY match_id, ts, id")
//   node scripts/clustering-check.ts snapshots.json

import { readFileSync } from "node:fs";
import * as N from "../src/estimate.ts";
const rows = JSON.parse(readFileSync(process.argv[2], "utf8"))[0].results;
const by = new Map(); for (const r of rows) { if (!by.has(r.match_id)) by.set(r.match_id, []); by.get(r.match_id).push(r); }
const obs = []; for (const [id, ss] of by) obs.push(...N.levelObservations(id, ss));
const gm = new Map(); for (const o of obs) { const k = o.lo + "-" + o.hi; gm.set(k, (gm.get(k) || 0) + 1); }
const w = N.levelPrior([...gm].map(([k, n]) => { const [lo, hi] = k.split("-").map(Number); return { lo, hi, n }; }));
const GL = { beginner: [1,3], amateur: [4,8], semipro: [9,11], pro: [12,12] };
const gradeOfL = (L) => Object.keys(GL).find((g) => L >= GL[g][0] && L <= GL[g][1]);
const cen = (L) => (N.SCORE_BANDS[L][0] + N.SCORE_BANDS[L][1]) / 20;
const q = (g, mu, tau) => { const [a, b] = GL[g]; const v = []; let z = 0; for (let L = a; L <= b; L++) { const x = w[L] * (isFinite(tau) ? Math.exp(-((cen(L) - mu) ** 2) / (2 * tau * tau)) : 1); v.push([L, x]); z += x; } return v.map(([L, x]) => [L, x / z]); };
const TAUS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.6, 1, Infinity];
// 2) 예측 채점
const events = [];
for (const [, ss] of by) { const tr = N.traceLevels(ss); for (let i = 1; i < tr.length; i++) { const p = tr[i].person, e = tr[i - 1].estimate; if (p && e) events.push({ g: gradeOfL(p.lo), lo: p.lo, hi: p.hi, mu: (e.lo + e.hi) / 2 }); } }
console.log("예측 채점 사건", events.length);
for (const tau of TAUS) { let ll = 0, hit = 0; for (const ev of events) { const pr = q(ev.g, ev.mu, tau).filter(([L]) => L >= ev.lo && L <= ev.hi).reduce((t, [, x]) => t + x, 0); ll += Math.log(Math.max(pr, 1e-9)); hit += pr; }
  console.log("τ", String(tau).padEnd(8), "평균 로그점수", (ll / events.length).toFixed(4), "| 맞힐 확률 평균", (hit / events.length * 100).toFixed(1) + "%"); }
// 1) 퍼짐 맞추기
const comp = [], real = [];
for (const [, ss] of by) { const e = N.estimateLevel(ss); if (!e || e.rated < 10) continue; const c = N.allCounts(ss.at(-1)); if (!c) continue; comp.push(c); real.push((e.lo + e.hi) / 2); }
const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
const allL = []; for (let L = 1; L <= 12; L++) allL.push([L, w[L]]);
const pick = (v) => { let u = Math.random(); for (const [L, x] of v) { u -= x; if (u <= 0) return L; } return v[v.length - 1][0]; };
const score = (L) => { const [lo, hi] = N.SCORE_BANDS[L]; return (lo + Math.floor(Math.random() * (hi - lo + 1))) / 10; };
console.log("실제 퍼짐", sd(real).toFixed(3), "(매치", real.length + ")");
for (const tau of TAUS) { const sim = []; for (let rep = 0; rep < 100; rep++) for (const c of comp) { const mu = cen(pick(allL)); let s = 0, n = 0; for (const g of Object.keys(GL)) { if (!c[g]) continue; const v = q(g, mu, tau); for (let i = 0; i < c[g]; i++) { s += score(pick(v)); n++; } } sim.push(s / n); }
  console.log("τ", String(tau).padEnd(8), "가상 퍼짐", sd(sim).toFixed(3)); }
// 3) 치우침 없는 채점: 한 명(평가 등급)이 들어온 모든 순간, 새 평균 레벨 표시를 맞히기
const ev2 = [];
for (const [, ss] of by) { const tr = N.traceLevels(ss);
  for (let i = 1; i < ss.length; i++) { const ch = tr[i].changes.filter((c) => c.grade !== "rookie"); const e = tr[i - 1].estimate; const e2 = tr[i].estimate;
    if (!e || !e2 || ch.length !== 1 || ch[0].delta !== 1) continue;
    ev2.push({ g: ch[0].grade, sLo: e.lo * e.rated * 10, sHi: e.hi * e.rated * 10, n: e.rated, mu: (e.lo + e.hi) / 2, label: e2.labelNum }); } }
const labelOf = (m) => { let L = 1; while (L < 12 && m * 10 >= N.SCORE_BANDS[L][1] + 0.5) L++; return L; };
console.log("\n치우침 없는 채점 사건", ev2.length);
for (const tau of TAUS) { let ll = 0, hit = 0;
  for (const ev of ev2) { let pr = 0; const v = q(ev.g, ev.mu, tau); const nS = Math.round(ev.sHi) - Math.round(ev.sLo) + 1;
    for (let S0 = Math.round(ev.sLo); S0 <= Math.round(ev.sHi); S0++) for (const [L, x] of v) { const [lo, hi] = N.SCORE_BANDS[L]; for (let sc = lo; sc <= hi; sc++) if (labelOf((S0 + sc) / 10 / (ev.n + 1)) === ev.label) pr += x / (hi - lo + 1) / nS; }
    ll += Math.log(Math.max(pr, 1e-9)); hit += pr; }
  console.log("τ", String(tau).padEnd(8), "평균 로그점수", (ll / ev2.length).toFixed(4), "| 새 평균 레벨 맞힐 확률", (hit / ev2.length * 100).toFixed(1) + "%"); }
// 4) 섞기: q = (1-α)·원래 + α·기울인 분포
const qmix = (g, mu, tau, a) => { const k = q(g, mu, tau), u = q(g, mu, Infinity); return k.map(([L, x], i) => [L, (1 - a) * u[i][1] + a * x]); };
console.log("\n섞기 채점 (치우침 없는 사건)");
const res = [];
for (const tau of [0.1, 0.15, 0.2, 0.3]) for (const a of [0, 0.3, 0.5, 0.7, 0.85]) { let ll = 0, hit = 0;
  for (const ev of ev2) { let pr = 0; const v = qmix(ev.g, ev.mu, tau, a); const nS = Math.round(ev.sHi) - Math.round(ev.sLo) + 1;
    for (let S0 = Math.round(ev.sLo); S0 <= Math.round(ev.sHi); S0++) for (const [L, x] of v) { const [lo, hi] = N.SCORE_BANDS[L]; for (let sc = lo; sc <= hi; sc++) if (labelOf((S0 + sc) / 10 / (ev.n + 1)) === ev.label) pr += x / (hi - lo + 1) / nS; }
    ll += Math.log(Math.max(pr, 1e-9)); hit += pr; }
  // 퍼짐
  const sim = []; for (let rep = 0; rep < 60; rep++) for (const c of comp) { const mu = cen(pick(allL)); let s = 0, n = 0; for (const g of Object.keys(GL)) { if (!c[g]) continue; const v = qmix(g, mu, tau, a); for (let i = 0; i < c[g]; i++) { s += score(pick(v)); n++; } } sim.push(s / n); }
  res.push([tau, a, ll / ev2.length, hit / ev2.length, sd(sim)]); }
res.sort((x, y) => y[2] - x[2]);
for (const [tau, a, ll, hit, sp] of res) console.log("τ", tau, "α", a, "| 로그점수", ll.toFixed(4), "| 맞힐 확률", (hit * 100).toFixed(1) + "%", "| 가상 퍼짐", sp.toFixed(3));
