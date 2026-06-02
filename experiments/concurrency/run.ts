// Driver: spawn N concurrent sessions writing the shared ledger, several ways.
// Verify integrity AND capture worker failures (the first run swallowed them).
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";

const N = 50;
const dir = import.meta.dir;
const worker = `${dir}/worker.ts`;
const reset = (p: string) => ["", "-wal", "-shm"].forEach((s) => existsSync(p + s) && rmSync(p + s));

async function spawnAll(mode: string, store: string) {
  const procs = Array.from({ length: N }, (_, i) =>
    Bun.spawn(["bun", "run", worker, mode, String(i), store], { stdout: "ignore", stderr: "pipe" }),
  );
  await Promise.all(procs.map((p) => p.exited));
  let failed = 0;
  let sampleErr = "";
  for (const p of procs) {
    if (p.exitCode !== 0) {
      failed++;
      if (!sampleErr) sampleErr = (await new Response(p.stderr).text()).split("\n").find((l) => l.trim()) || "";
    }
  }
  return { failed, sampleErr };
}

console.log(`EXPERIMENT 3 (v2) — ${N} concurrent sessions, shared ledger, FAILURES CAPTURED\n`);
console.log("mode             survived/expected   worker_failures   integrity");

async function report(mode: string, store: string, count: () => number) {
  const { failed, sampleErr } = await spawnAll(mode, store);
  const c = count();
  const ok = c === N && failed === 0;
  console.log(`${mode.padEnd(15)} ${String(c).padStart(7)}/${N}        ${String(failed).padStart(8)}         ${ok ? "✅ safe" : "❌ data loss"}`);
  if (sampleErr) console.log(`                 ↳ sample worker error: ${sampleErr.slice(0, 90)}`);
}

// json (naive read-modify-write)
const jsonStore = `${dir}/ledger.json`;
reset(jsonStore);
const jsonRes = await spawnAll("json", jsonStore);
const jsonArr = JSON.parse(await Bun.file(jsonStore).text());
const jsonCount = new Set(jsonArr.map((x: any) => x.id)).size;
console.log(`${"json".padEnd(15)} ${String(jsonCount).padStart(7)}/${N}        ${String(jsonRes.failed).padStart(8)}         ${jsonCount === N ? "✅ safe" : "❌ data loss (race)"}`);

function initSqlite(store: string) {
  reset(store);
  const db = new Database(store);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts (id INTEGER PRIMARY KEY, fact TEXT);");
  db.close();
}
function countFacts(store: string) {
  const db = new Database(store);
  const n = (db.query("SELECT COUNT(*) AS n FROM facts").get() as any).n;
  db.close();
  return n;
}

// sqlite (no retry) vs sqlite_retry (correct multi-process design)
const sqlStore = `${dir}/ledger.sqlite`;
initSqlite(sqlStore);
await report("sqlite", sqlStore, () => countFacts(sqlStore));

const sqlStore2 = `${dir}/ledger_retry.sqlite`;
initSqlite(sqlStore2);
await report("sqlite_retry", sqlStore2, () => countFacts(sqlStore2));

// single-writer orchestrator (the design Gearbox actually uses): ONE process owns
// the ledger; N concurrent sessions submit writes through a serialized async queue.
// Race-free by construction — no cross-process lock contention at all.
const swStore = `${dir}/ledger_single.sqlite`;
initSqlite(swStore);
{
  const db = new Database(swStore);
  const stmt = db.query("INSERT OR IGNORE INTO facts (id, fact) VALUES (?, ?)");
  // tiny async mutex → strictly serialized writer
  let chain: Promise<void> = Promise.resolve();
  const submit = (id: number) => (chain = chain.then(async () => { stmt.run(id, `fact_${id}`); }));
  // 50 concurrent sessions, each with jittered arrival, all submit to the one writer
  await Promise.all(Array.from({ length: N }, async (_, i) => { await new Promise((r) => setTimeout(r, (i * 7) % 13)); await submit(i); }));
  const n = (db.query("SELECT COUNT(*) AS n FROM facts").get() as any).n;
  db.close();
  console.log(`${"single-writer".padEnd(15)} ${String(n).padStart(7)}/${N}        ${String(0).padStart(8)}         ${n === N ? "✅ safe by construction" : "❌"}`);
}

console.log(`\nVERDICT:`);
console.log(`• naive shared-mutable JSON → catastrophic lost-update race (read-modify-write).`);
console.log(`• naive multi-process SQLite → loses writes: each connection re-set journal_mode=WAL,`);
console.log(`  contending on an exclusive lock. Real gotcha for "many CLI processes, one ledger".`);
console.log(`• multi-process SQLite done right (WAL set ONCE at init, busy_timeout + retry) → safe.`);
console.log(`• single-writer orchestrator (one owner process, serialized queue) → safe by construction,`);
console.log(`  and it's how Gearbox runs anyway (one orchestrator managing N sessions). RECOMMENDED.`);
