// One concurrent session writing a fact to the shared ledger.
// Invoked as a REAL subprocess by run.ts so we get genuine OS-level concurrency,
// not cooperative async. Args: <mode> <id> <store>
import { Database } from "bun:sqlite";

const [, , mode, idStr, store] = Bun.argv;
const id = Number(idStr);

if (mode === "json") {
  // Naive read-modify-write on a shared JSON file, no locking.
  // The sleep between read and write widens the classic lost-update window.
  let arr: any[] = [];
  try { arr = JSON.parse(await Bun.file(store).text()); } catch {}
  await new Promise((r) => setTimeout(r, 5 + (id % 12)));
  arr.push({ id, fact: `fact_${id}` });
  await Bun.write(store, JSON.stringify(arr));
} else if (mode === "sqlite") {
  // Shared mutable table; WAL + busy_timeout lets concurrent writers serialize.
  const db = new Database(store);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000;");
  db.query("INSERT OR IGNORE INTO facts (id, fact) VALUES (?, ?)").run(id, `fact_${id}`);
  db.close();
} else if (mode === "sqlite_retry") {
  // The "done correctly" multi-process design: WAL is already set at init and is
  // PERSISTENT, so DO NOT switch journal_mode per connection (that needs an
  // exclusive lock and was the real source of contention). Only set busy_timeout,
  // and retry the write on a transient lock.
  const db = new Database(store);
  db.exec("PRAGMA busy_timeout=10000;");
  const stmt = db.query("INSERT OR IGNORE INTO facts (id, fact) VALUES (?, ?)");
  let done = false;
  for (let attempt = 0; attempt < 100 && !done; attempt++) {
    try { stmt.run(id, `fact_${id}`); done = true; }
    catch (e: any) {
      if (String(e).includes("locked") || String(e).includes("BUSY")) await new Promise((r) => setTimeout(r, 15 + attempt * 10));
      else throw e;
    }
  }
  db.close();
  if (!done) { process.stderr.write(`worker ${id}: gave up after retries\n`); process.exit(3); }
} else if (mode === "eventlog") {
  // Append-only event log. Writers only ever INSERT (never update), so there is
  // no read-modify-write to race. Invalidation is just another event.
  const db = new Database(store);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000;");
  db.query("INSERT INTO events (ts, type, fact_id, valid) VALUES (?, 'assert', ?, 1)").run(Date.now(), id);
  db.close();
}
