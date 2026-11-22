// 평균 레벨 경계 규칙(반올림·올림·내림) 비교: 기록 모순 수 + 한 명 들어올 때 새 평균 레벨 맞히기 (docs/LEVEL_ESTIMATION.md 1-2)
// 사용: node scripts/boundary-check.ts snapshots.json prior.json

import { readFileSync } from "node:fs";
import * as N from "../src/estimate.ts";
const rows = JSON.parse(readFileSync(process.argv[2], "utf8"))[0].results;
const by = new Map(); for (const r of rows) { if (!by.has(r.match_id)) by.set(r.match_id, []); by.get(r.match_id).push(r); }
const B = N.SCORE_BANDS; const GS = { beginner: [1,20], amateur: [21,30], semipro: [31,40], pro: [41,50] };
// 평균 레벨 L일 때 점수 합(정수, 0.1점 단위) 범위
const RULES = {
  "반올림 [lo-0.05, hi+0.05)": (L, n) => [Math.ceil(n * (B[L][0] - 0.5) - 1e-9), Math.ceil(n * (B[L][1] + 0.5) - 1e-9) - 1],
  "올림 (이전 hi, hi]": (L, n) => [L === 1 ? n : Math.floor(n * B[L - 1][1] + 1e-9) + 1, Math.floor(n * B[L][1] + 1e-9)],
  "내림 [lo, 다음 lo)": (L, n) => [Math.ceil(n * B[L][0] - 1e-9), L === 12 ? 50 * n : Math.ceil(n * B[L + 1][0] - 1e-9) - 1],
};
const lvl = (s) => s.average_level === "루키" ? null : ["","비기너1","비기너2","비기너3","아마추어1","아마추어2","아마추어3","아마추어4","아마추어5","세미프로1","세미프로2","세미프로3","프로"].indexOf(s.average_level);
for (const [name, rng] of Object.entries(RULES)) {
  let trans = 0, bad = 0, single = 0;
  for (const [, ss] of by) {
    let sum = null, prev = null;
    for (const s of ss) {
      const c = N.allCounts(s); const L = lvl(s);
      if (!c || L == null || L < 1) { sum = null; prev = null; continue; }
      const n = c.beginner + c.amateur + c.semipro + c.pro; if (!n) { sum = null; prev = null; continue; }
      let gLo = 0, gHi = 0; for (const g of Object.keys(GS)) { gLo += c[g] * GS[g][0]; gHi += c[g] * GS[g][1]; }
      const [r0, r1] = rng(L, n); let cur = [Math.max(gLo, r0), Math.min(gHi, r1)];
      if (cur[0] > cur[1]) { single++; sum = null; prev = null; continue; } // 이 시점 혼자서도 모순
      if (sum && prev) { let dLo = 0, dHi = 0; for (const g of Object.keys(GS)) { const d = c[g] - prev[g]; if (d > 0) { dLo += d * GS[g][0]; dHi += d * GS[g][1]; } else if (d < 0) { dLo += d * GS[g][1]; dHi += d * GS[g][0]; } }
        trans++; const lo = Math.max(cur[0], sum[0] + dLo), hi = Math.min(cur[1], sum[1] + dHi); if (lo > hi) bad++; else cur = [lo, hi]; }
      sum = cur; prev = c;
    }
  }
  console.log(name.padEnd(24), "변화", trans, "| 모순", bad, "| 한 시점 혼자 모순", single);
}
// 규칙별 예측 채점: 한 명 들어올 때 새 평균 레벨 맞히기 (사전 분포는 공통)
const prior = JSON.parse(readFileSync(process.argv[3], "utf8")); // levelPrior 결과 (길이 13 배열)
const GL = { beginner: [1,3], amateur: [4,8], semipro: [9,11], pro: [12,12] };
const person = {}; for (const [g, [a, b]] of Object.entries(GL)) { let z = 0; for (let L = a; L <= b; L++) z += prior[L]; const arr = []; for (let L = a; L <= b; L++) { const [lo, hi] = B[L]; for (let x = lo; x <= hi; x++) arr.push([x, prior[L] / z / (hi - lo + 1)]); } person[g] = arr; }
const LABEL = {
  "반올림 [lo-0.05, hi+0.05)": (sum, n) => { const m = sum / n; let L = 1; while (L < 12 && m >= B[L][1] + 0.5 - 1e-9) L++; return L; },
  "올림 (이전 hi, hi]": (sum, n) => { const m = sum / n; let L = 1; while (L < 12 && m > B[L][1] + 1e-9) L++; return L; },
  "내림 [lo, 다음 lo)": (sum, n) => { const m = sum / n; let L = 12; while (L > 1 && m < B[L][0] - 1e-9) L--; return L; },
};
console.log("");
for (const [name, rng] of Object.entries(RULES)) {
  const lab = LABEL[name]; let n = 0, ll = 0, acc = 0;
  for (const [, ss] of by) {
    let sum = null, prev = null;
    for (const s of ss) {
      const c = N.allCounts(s); const L = lvl(s);
      if (!c || L == null || L < 1) { sum = null; prev = null; continue; }
      const k = c.beginner + c.amateur + c.semipro + c.pro; if (!k) { sum = null; prev = null; continue; }
      // 예측: 직전 상태에서 평가 등급 정확히 1명 들어온 경우
      if (sum && prev) { const ch = Object.keys(GS).filter((g) => c[g] !== prev[g]); const kp = prev.beginner + prev.amateur + prev.semipro + prev.pro;
        if (ch.length === 1 && c[ch[0]] - prev[ch[0]] === 1) {
          let A = new Float64Array(1); A[0] = 1;
          for (const g of Object.keys(GL)) for (let i = 0; i < prev[g]; i++) { const nx = new Float64Array(A.length + 50); for (let t = 0; t < A.length; t++) if (A[t]) for (const [x, p] of person[g]) nx[t + x] += A[t] * p; A = nx; }
          let Z = 0; for (let t = sum[0]; t <= sum[1]; t++) Z += A[t] || 0;
          if (Z) { const P = new Map(); for (let t = sum[0]; t <= sum[1]; t++) { const pt = (A[t] || 0) / Z; if (!pt) continue; for (const [x, q] of person[ch[0]]) { const LL = lab(t + x, kp + 1); P.set(LL, (P.get(LL) || 0) + pt * q); } }
            n++; ll += Math.log(P.get(L) || 1e-9); if ([...P].sort((a, b) => b[1] - a[1])[0][0] === L) acc++; } } }
      let gLo = 0, gHi = 0; for (const g of Object.keys(GS)) { gLo += c[g] * GS[g][0]; gHi += c[g] * GS[g][1]; }
      const [r0, r1] = rng(L, k); let cur = [Math.max(gLo, r0), Math.min(gHi, r1)];
      if (sum && prev) { let dLo = 0, dHi = 0; for (const g of Object.keys(GS)) { const d = c[g] - prev[g]; if (d > 0) { dLo += d * GS[g][0]; dHi += d * GS[g][1]; } else if (d < 0) { dLo += d * GS[g][1]; dHi += d * GS[g][0]; } }
        const lo = Math.max(cur[0], sum[0] + dLo), hi = Math.min(cur[1], sum[1] + dHi); if (lo <= hi) cur = [lo, hi]; }
      sum = cur; prev = c;
    }
  }
  console.log(name.padEnd(24), "사건", n, "| 로그점수", (ll / n).toFixed(4), "| 정확도", (acc / n * 100).toFixed(1) + "%");
}
