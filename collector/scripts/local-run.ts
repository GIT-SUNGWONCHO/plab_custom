// 로컬 확인용: 실제 플랩 API로 수집기를 1회 실행 (Node + SQLite 파일).
// 요청은 curl로 보냄 (이 개발 환경에서는 Node fetch가 CloudFront에 막힘).
//
//   node scripts/local-run.ts rule <구장그룹ids> <요일들> <HH:MM-HH:MM>   예: rule 3,3639 6,0 10:00-14:00
//   node scripts/local-run.ts run
//   node scripts/local-run.ts show

import { execFileSync } from "node:child_process";
import { runCollector } from "../src/collector.ts";
import { PlabClient, type FetchFn } from "../src/plab.ts";
import { asD1, D1Shim } from "../test/d1-shim.ts";

const curlFetch: FetchFn = async (input, init) => {
  const headers = new Headers(init?.headers);
  const args = ["-sS", "-m", "20", "-w", "\n%{http_code}"];
  headers.forEach((v, k) => args.push("-H", `${k}: ${v}`));
  const out = execFileSync("curl", [...args, input], { encoding: "utf8" });
  const i = out.lastIndexOf("\n");
  return new Response(out.slice(0, i), { status: Number(out.slice(i + 1)) });
};

const db = new D1Shim(new URL("../.wrangler/local-run.sqlite", import.meta.url).pathname);
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "rule") {
  const [groups, days, window] = args;
  const [from, to] = window.split("-");
  db.db.prepare("INSERT INTO watch_rule (name, stadium_group_ids, weekdays, time_from, time_to, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("local", JSON.stringify(groups.split(",").map(Number)), JSON.stringify(days.split(",").map(Number)), from, to, new Date().toISOString());
  console.log(db.rows("SELECT * FROM watch_rule"));
} else if (cmd === "run") {
  console.log(await runCollector(asD1(db), new PlabClient(curlFetch)));
} else if (cmd === "show") {
  console.table(db.rows(`SELECT id, kst_date AS date, kst_time AS time, substr(title, 1, 22) AS title, confirm || '/' || max_players AS ppl,
                                apply_status AS status, lifecycle, average_level AS avg, tracking,
                                (SELECT COUNT(*) FROM snapshot s WHERE s.match_id = m.id) AS snaps
                         FROM match m ORDER BY kst_date, kst_time`));
} else {
  console.log("usage: rule <ids> <weekdays> <HH:MM-HH:MM> | run | show");
}
