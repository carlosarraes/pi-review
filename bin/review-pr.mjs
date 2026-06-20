#!/usr/bin/env node
/**
 * Headless single-PR reviewer.
 *
 * Drives `pi --mode rpc` to run the pi-review `/review` command
 * non-interactively against one PR, lets Pi post the review to GitHub itself,
 * then exits 0 on success / non-zero on failure or timeout.
 *
 * Usage:
 *   node review-pr.mjs <pr-number|url> [destination] [options]
 *
 *   destination   github (default) | claude | pi | none
 *   --model <m>   pass a specific model to pi (default: pi's configured model)
 *   --ext <path>  load ONLY this extension file (for testing local edits
 *                 without touching the installed pi-review). Omit in prod.
 *   --cwd <dir>   run pi in this repo dir (default: current dir)
 *   --hard-min <n>  hard timeout in minutes (default 15)
 *   --idle-sec <n>  abort if no events for this many seconds (default 180)
 *   --verbose     echo a compact event trace to stderr
 *
 * Exit codes: 0 = review session completed; 1 = failure/timeout/spawn error.
 *
 * Design notes:
 *   - The review is agent run #1. The GitHub post is run #2, injected by the
 *     extension as a `followUp` during run #1 (only if a verdict is produced).
 *     So we wait for TRUE idle (get_state: pendingMessageCount===0 &&
 *     !isStreaming), re-checked after a short grace window, not the first
 *     agent_end.
 *   - JSONL framing per Pi's rpc.md: split on "\n" only, strip a trailing
 *     "\r". Node `readline` is explicitly NOT protocol-compliant here.
 *   - We auto-answer any extension_ui_request defensively; default Pi has no
 *     per-tool permission prompt, but this keeps us from hanging if one appears.
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// ----------------------------------------------------------------------------
// Argument parsing
// ----------------------------------------------------------------------------

const DESTINATIONS = new Set(["github", "claude", "pi", "none"]);

function parseCliArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verbose") opts.verbose = true;
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--ext") opts.ext = argv[++i];
    else if (a === "--cwd") opts.cwd = argv[++i];
    else if (a === "--hard-min") opts.hardMin = Number(argv[++i]);
    else if (a === "--idle-sec") opts.idleSec = Number(argv[++i]);
    else positional.push(a);
  }
  return { positional, opts };
}

const { positional, opts } = parseCliArgs(process.argv.slice(2));
const PR = positional[0];
const DEST = positional[1] ?? "github";

if (!PR || PR === "--help" || PR === "-h") {
  console.error(
    "Usage: node review-pr.mjs <pr-number|url> [github|claude|pi|none] " +
      "[--model <m>] [--ext <path>] [--cwd <dir>] [--hard-min <n>] [--idle-sec <n>] [--verbose]",
  );
  process.exit(PR ? 0 : 2);
}
if (!DESTINATIONS.has(DEST)) {
  console.error(`[review-pr] invalid destination "${DEST}" (expected: ${[...DESTINATIONS].join(", ")})`);
  process.exit(2);
}

const CWD = opts.cwd ?? process.cwd();
const HARD_TIMEOUT_MS = (Number.isFinite(opts.hardMin) ? opts.hardMin : 15) * 60_000;
const IDLE_TIMEOUT_MS = (Number.isFinite(opts.idleSec) ? opts.idleSec : 180) * 1_000;
const SETTLE_MS = 5_000; // grace after agent_end for an async followUp to enqueue
const STATE_REQ_ID = "review-pr-state";

const log = (...a) => console.error("[review-pr]", ...a);
const trace = (...a) => {
  if (opts.verbose) console.error("[review-pr:ev]", ...a);
};

// ----------------------------------------------------------------------------
// Spawn pi in RPC mode
// ----------------------------------------------------------------------------

const piArgs = ["--mode", "rpc"];
// --ext loads ONLY the given extension file (so we can test local edits without
// touching the installed copy). Omit in production to use installed extensions.
if (opts.ext) piArgs.push("--no-extensions", "--extension", opts.ext);
if (opts.model) piArgs.push("--model", opts.model);

const child = spawn("pi", piArgs, { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });

let stderrBuf = "";
child.stderr.on("data", (d) => {
  stderrBuf += d.toString();
});

function send(obj) {
  try {
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  } catch {
    /* stdin may be closed during shutdown */
  }
}

// ----------------------------------------------------------------------------
// Timers + shutdown
// ----------------------------------------------------------------------------

let exiting = false;
let sawAgentEnd = false;
let settleTimer = null;
let idleTimer = null;

const hardTimer = setTimeout(
  () => finish(1, `hard timeout after ${HARD_TIMEOUT_MS / 60_000} min`),
  HARD_TIMEOUT_MS,
);

function bumpIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(
    () => finish(1, `no events for ${IDLE_TIMEOUT_MS / 1000}s — assuming stuck`),
    IDLE_TIMEOUT_MS,
  );
}

function finish(code, reason) {
  if (exiting) return;
  exiting = true;
  clearTimeout(hardTimer);
  clearTimeout(idleTimer);
  clearTimeout(settleTimer);
  log(`PR #${PR}: ${reason}`);
  send({ type: "abort" });
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }, 500);
  process.exitCode = code;
}

// ----------------------------------------------------------------------------
// JSONL reader (protocol-correct: split on "\n" only, strip trailing "\r")
// ----------------------------------------------------------------------------

function attachJsonlReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    if (tail.trim().length > 0) onLine(tail);
  });
}

// ----------------------------------------------------------------------------
// Event handling
// ----------------------------------------------------------------------------

function scheduleSettleCheck() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => send({ id: STATE_REQ_ID, type: "get_state" }), SETTLE_MS);
}

function handleDialog(ev) {
  const { id, method, message, notifyType } = ev;
  switch (method) {
    case "select": {
      const opts2 = ev.options || [];
      const pick =
        opts2.find((o) => /\b(allow|approve|yes|trust|always|continue|proceed)\b/i.test(o)) ??
        opts2[0];
      if (pick !== undefined) send({ type: "extension_ui_response", id, value: pick });
      else send({ type: "extension_ui_response", id, cancelled: true });
      trace("dialog select ->", pick);
      break;
    }
    case "confirm":
      send({ type: "extension_ui_response", id, confirmed: true });
      trace("dialog confirm -> true");
      break;
    case "input":
    case "editor":
      // Not expected on the fully-specified path; cancel rather than hang.
      send({ type: "extension_ui_response", id, cancelled: true });
      trace(`dialog ${method} -> cancelled`);
      break;
    case "notify":
      trace(`notify[${notifyType ?? "info"}]`, message);
      // The command bailing surfaces as an error notify or "Review cancelled".
      if (notifyType === "error" || message === "Review cancelled") {
        finish(1, `command aborted: ${message}`);
      }
      break;
    default:
      // setStatus / setWidget / setTitle / set_editor_text — fire-and-forget.
      break;
  }
}

attachJsonlReader(child.stdout, (line) => {
  bumpIdle();
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }

  if (ev.type === "extension_ui_request") {
    handleDialog(ev);
    return;
  }

  if (ev.type === "response" && ev.success === false && ev.id !== STATE_REQ_ID) {
    log(`command "${ev.command}" failed: ${ev.error}`);
    return;
  }

  if (ev.type === "response" && ev.id === STATE_REQ_ID && ev.command === "get_state") {
    const st = ev.data || {};
    trace(`state: streaming=${st.isStreaming} pending=${st.pendingMessageCount}`);
    if (!st.isStreaming && (st.pendingMessageCount ?? 0) === 0) {
      finish(0, `complete (messages=${st.messageCount})`);
    }
    // Otherwise a followUp (the GitHub post) is queued or running — keep going.
    return;
  }

  if (ev.type === "agent_start") {
    trace("agent_start");
    clearTimeout(settleTimer); // new work started; cancel any pending settle
    return;
  }

  if (ev.type === "tool_execution_start") {
    trace("tool", ev.toolName);
    return;
  }

  if (ev.type === "agent_end") {
    sawAgentEnd = true;
    trace("agent_end -> settle check");
    // Don't exit yet: a followUp (GitHub post) may enqueue just after this.
    // Re-check true-idle after a grace window.
    scheduleSettleCheck();
    return;
  }
});

child.on("error", (err) => finish(1, `failed to spawn pi: ${err.message}`));

child.on("exit", (code) => {
  if (exiting) return;
  if (!sawAgentEnd) {
    if (stderrBuf.trim()) log("pi stderr:", stderrBuf.trim().slice(0, 800));
    finish(code ?? 1, `pi exited (code ${code}) before any agent run`);
  } else {
    finish(code ?? 0, `pi exited (code ${code})`);
  }
});

// ----------------------------------------------------------------------------
// Kick off the review
// ----------------------------------------------------------------------------

bumpIdle();
const command = `/review pr ${PR} ${DEST} --empty`;
log(`PR #${PR}: starting "${command}" (cwd=${CWD})`);
send({ type: "prompt", message: command });
