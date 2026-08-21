/**
 * Polls /livescores/latest every 10s and writes any fixture observations to
 * JSONL. The endpoint returns only fixtures whose livescore data changed
 * in the last 10s (state_id, venue_id, name, starting_at, *_timestamp,
 * result_info, leg, length).
 *
 * Primary purpose: measure how quickly `state_id` transitions (kickoff,
 * half-time, full-time) surface on /latest vs when our fixture-feed poll
 * observes them via the fuller include set.
 *
 * Usage:
 *   tsx src/scripts/probe-livescores-latest.mts [fixtureId] [--interval=10]
 *
 * If fixtureId is given, the probe filters to that fixture only.
 * Otherwise it logs every changed fixture that arrives.
 */
import { mkdirSync, createWriteStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureIdArg = process.argv[2] && !process.argv[2].startsWith("--")
  ? Number(process.argv[2])
  : null;
const intervalArg = process.argv.find((a) => a.startsWith("--interval="));
const intervalSec = intervalArg ? Number(intervalArg.split("=")[1]) : 10;

const token = process.env.SPORTMONKS_API_TOKEN;
if (!token) throw new Error("SPORTMONKS_API_TOKEN not set");

const here = dirname(fileURLToPath(import.meta.url));
const tmpDir = resolve(here, "../../../../../tmp");
mkdirSync(tmpDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const suffix = fixtureIdArg ? `-${fixtureIdArg}` : "";
const outPath = resolve(tmpDir, `probe-latest${suffix}-${ts}.jsonl`);
const out = createWriteStream(outPath);
console.log(`[latest] writing to ${outPath}`);
console.log(`[latest] target fixture: ${fixtureIdArg ?? "all changed"} interval=${intervalSec}s`);

let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
  console.log("[latest] stopping");
  out.end(() => process.exit(0));
});

interface Fixture {
  id: number;
  state_id: number;
  name: string;
  starting_at: string;
  starting_at_timestamp: number;
  result_info: string | null;
  leg: string;
  length: number;
}

while (!stopped) {
  const pollStart = Date.now();
  try {
    const url = `https://api.sportmonks.com/v3/football/livescores/latest?api_token=${token}`;
    const r = await fetch(url);
    const body = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
    const j = JSON.parse(body) as {
      data?: Fixture[];
      rate_limit?: { remaining: number };
    };
    const all = j.data ?? [];
    const matched = fixtureIdArg ? all.filter((f) => f.id === fixtureIdArg) : all;

    out.write(
      JSON.stringify({
        kind: "poll",
        ts: pollStart,
        total_changed: all.length,
        matched: matched.length,
        rate_limit_remaining: j.rate_limit?.remaining,
      }) + "\n",
    );

    for (const fx of matched) {
      out.write(
        JSON.stringify({ kind: "fixture", ts: pollStart, fixture: fx }) + "\n",
      );
      console.log(
        `[latest] fx=${fx.id} state=${fx.state_id} result='${fx.result_info ?? "—"}' length=${fx.length}`,
      );
    }
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[latest] poll error: ${message}`);
    out.write(JSON.stringify({ kind: "error", ts: pollStart, message }) + "\n");
  }
  await new Promise((r) => setTimeout(r, intervalSec * 1000));
}
