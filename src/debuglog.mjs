// Lightweight debug logger for the pipeline's I/O.
//
// When enabled via initDebug(), every API request/response, cache hit, and composite is
// appended as ONE JSON line (JSONL) to the log file and echoed to the console. It is a no-op
// until initDebug() runs, so the src API modules can call logEvent() unconditionally with zero
// overhead on normal runs. Image payloads are NEVER written to the log — only byte lengths and
// params; the actual bytes are saved as files by the pipeline (see --debug).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let LOG_PATH = null;
let ECHO = true;
let seq = 0;

export function initDebug({ path, echo = true } = {}) {
  LOG_PATH = path;
  ECHO = echo;
  mkdirSync(dirname(path), { recursive: true });
  logEvent({ event: "init", pid: process.pid, argv: process.argv.slice(2) });
  if (ECHO) console.error(`[debug] logging to ${LOG_PATH}`);
}

export function debugEnabled() { return LOG_PATH != null; }

// Append one structured event. Common fields: event, service, op, sku, stage, status, ms.
export function logEvent(event) {
  if (LOG_PATH == null) return;
  const rec = { ts: new Date().toISOString(), seq: seq++, ...event };
  try { appendFileSync(LOG_PATH, JSON.stringify(rec) + "\n"); } catch { /* logging must never break a run */ }
  if (ECHO) {
    const { event: e, service, op, sku, stage, status, ms } = rec;
    let line = `[debug] ${e ?? ""}`;
    if (service) line += ` ${service}${op ? "/" + op : ""}`;
    if (sku) line += ` ${sku}`;
    if (stage) line += ` ${stage}`;
    if (status != null) line += ` status=${status}`;
    if (ms != null) line += ` ${ms}ms`;
    console.error(line);
  }
}

// Wrap an async API call: logs a request event, times it, logs a response (or error) event,
// and returns the result. `meta` is merged into both records for correlation.
export async function logCall(meta, requestFields, fn) {
  logEvent({ event: "request", ...meta, ...requestFields });
  const t0 = Date.now();
  try {
    const out = await fn();
    logEvent({ event: "response", ...meta, ms: Date.now() - t0, ok: true, outputBytes: out?.length });
    return out;
  } catch (err) {
    logEvent({ event: "response", ...meta, ms: Date.now() - t0, ok: false, error: String(err?.message ?? err) });
    throw err;
  }
}
