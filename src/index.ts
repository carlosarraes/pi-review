/**
 * Code Review Extension (inspired by Codex's review feature)
 *
 * Provides a `/review` command that prompts the agent to review code changes.
 * Supports three review modes, all diffing against a base branch:
 * - Review against a base branch (current branch, in place)
 * - Review a worktree against a branch (any local or remote branch, in an
 *   isolated worktree materialized on demand and removed at /end-review)
 * - Review a GitHub pull request (fetched into an isolated worktree)
 *
 * Usage:
 * - `/review` - show interactive selector
 * - `/review branch main` - review the current branch against main
 * - `/review worktree feature-x main` - review branch feature-x against main in
 *   an isolated worktree (fetches feature-x first when it is remote-only)
 * - `/review pr 123` - review PR #123 in an isolated worktree
 * - `/review pr https://github.com/owner/repo/pull/123` - review PR from URL
 *
 * Project-specific review guidelines:
 * - If a REVIEW_GUIDELINES.md file exists in the same directory as .pi,
 *   its contents are appended to the review prompt.
 *
 * Optional ticket compliance:
 * - The review menu can toggle ticket compliance with Linear (default) or Jira.
 * - The ticket is inferred automatically from repo context:
 *   - Linear: case-insensitive pattern like AAA-123 / aaa-123 (2-5 letter prefix)
 *   - Jira: 2-10 uppercase letters dash digits, e.g. ABC-123
 * - When enabled and a ticket is inferred, the review prompt instructs the LLM to run
 *   the appropriate CLI (`linear issue view` or `jira issue view --plain`) to inspect
 *   the ticket and verify the code matches it.
 *
 * FastAPI guidance:
 * - When reviewing FastAPI/Pydantic code, the reviewer is instructed to consult the
 *   fastapi skill if needed.
 *
 * CLAUDE.md / AGENTS.md enforcement:
 * - If a CLAUDE.md or AGENTS.md file exists, the reviewer is instructed to read it
 *   and verify the changes follow those project rules as well.
 *
 * Note: worktree and PR reviews run in an isolated git worktree, so they never
 * touch your working tree (you can review with uncommitted local changes).
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { promises as fs, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as net from "node:net";
import os from "node:os";
import path from "node:path";

// State to track fresh session review (where we branched from).
// Module-level state means only one review can be active at a time.
// This is intentional - the UI and /end-review command assume a single active review.
let reviewOriginId: string | undefined = undefined;
let endReviewInProgress = false;
let reviewLoopFixingEnabled = false;
let reviewLoopInProgress = false;
let reviewTicketComplianceEnabled = false;
let reviewTicketProvider: "linear" | "jira" = "linear";
let reviewInferredTicketId: string | undefined = undefined;
let reviewSendToClaudeEnabled = false;
let reviewSendToPiEnabled = false;

const REVIEW_STATE_TYPE = "review-session";
const REVIEW_ANCHOR_TYPE = "review-anchor";
const REVIEW_SETTINGS_TYPE = "review-settings";
const REVIEW_LOOP_MAX_ITERATIONS = 10;
const REVIEW_LOOP_START_TIMEOUT_MS = 15000;
const REVIEW_LOOP_START_POLL_MS = 50;
const PI_SESSION_CONTROL_DIR = path.join(
  os.homedir(),
  ".pi",
  "session-control",
);

type ReviewSessionState = {
  active: boolean;
  originId?: string;
};

type ReviewSettingsState = {
  loopFixingEnabled?: boolean;
  ticketComplianceEnabled?: boolean;
  ticketProvider?: "linear" | "jira";
  sendToClaudeEnabled?: boolean;
  sendToPiEnabled?: boolean;
  /** @deprecated Read-only compat for old persisted state */
  linearTicketComplianceEnabled?: boolean;
};

// Global persistence — survives all session boundaries (fork, navigateTree,
// resume, restart). Per-session entry persistence is unreliable because /review
// may navigate to a sibling branch where the entry isn't visible (post-Apr 3
// pi-mono refactor). Session entry remains as override (session > global).
const PI_REVIEW_STATE_DIR = path.join(os.homedir(), ".pi-review");
const PI_REVIEW_STATE_FILE = path.join(PI_REVIEW_STATE_DIR, "state.json");
const PI_REVIEW_WORKTREES_FILE = path.join(
  PI_REVIEW_STATE_DIR,
  "worktrees.json",
);
const PI_REVIEW_WORKTREES_DIR = path.join(PI_REVIEW_STATE_DIR, "worktrees");
const PI_REVIEW_DEBUG_LOG = path.join(PI_REVIEW_STATE_DIR, "debug.log");

// Pi's TUI suppresses raw stderr; write to a file so logs survive regardless of UI state.
// The dir is created lazily by saveGlobalSettings on first toggle; until then, appendFileSync
// will throw ENOENT and we silently drop the message.
const debugLog = (msg: string) => {
  if (process.env.PI_REVIEW_DEBUG !== "1") return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(PI_REVIEW_DEBUG_LOG, line, "utf8");
  } catch {
    // best-effort: dir may not exist yet, or disk is full — don't crash the extension
  }
};

async function loadGlobalSettings(): Promise<ReviewSettingsState> {
  try {
    const raw = await fs.readFile(PI_REVIEW_STATE_FILE, "utf8");
    return JSON.parse(raw) as ReviewSettingsState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      debugLog(`loadGlobalSettings failed: ${err}`);
    }
    return {};
  }
}

// Atomic write (tmp + rename) so concurrent Pi instances can't tear the file.
async function saveGlobalSettings(state: ReviewSettingsState): Promise<void> {
  await fs.mkdir(PI_REVIEW_STATE_DIR, { recursive: true });
  const tmp = PI_REVIEW_STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, PI_REVIEW_STATE_FILE);
}

// --- Worktree registry ----------------------------------------------------
// Worktree reviews create on-disk git worktrees that must outlive the current
// process: a restart/resume mid-review must still be able to remove them at
// /end-review. We persist them per-repo (keyed by repo root) in their own file
// so settings writes and worktree writes never race.
type WorktreeRecord = {
  path: string;
  ref: string;
  sha: string;
  /** PR head fetch ref (refs/pi-review/pr-<n>) to delete on cleanup, if any. */
  tempRef?: string;
  createdAt: string;
};

type WorktreeRegistry = Record<string, WorktreeRecord[]>;

async function loadWorktreeRegistry(): Promise<WorktreeRegistry> {
  try {
    const raw = await fs.readFile(PI_REVIEW_WORKTREES_FILE, "utf8");
    return JSON.parse(raw) as WorktreeRegistry;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      debugLog(`loadWorktreeRegistry failed: ${err}`);
    }
    return {};
  }
}

async function saveWorktreeRegistry(reg: WorktreeRegistry): Promise<void> {
  await fs.mkdir(PI_REVIEW_STATE_DIR, { recursive: true });
  const tmp = PI_REVIEW_WORKTREES_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(reg, null, 2), "utf8");
  await fs.rename(tmp, PI_REVIEW_WORKTREES_FILE);
}

async function recordWorktree(
  repoRoot: string,
  record: WorktreeRecord,
): Promise<void> {
  const reg = await loadWorktreeRegistry();
  reg[repoRoot] = [...(reg[repoRoot] ?? []), record];
  await saveWorktreeRegistry(reg);
}

async function getWorktreeRecords(repoRoot: string): Promise<WorktreeRecord[]> {
  const reg = await loadWorktreeRegistry();
  return reg[repoRoot] ?? [];
}

async function clearWorktreeRecords(repoRoot: string): Promise<void> {
  const reg = await loadWorktreeRegistry();
  if (reg[repoRoot]) {
    delete reg[repoRoot];
    await saveWorktreeRegistry(reg);
  }
}

function setReviewWidget(ctx: ExtensionContext, active: boolean) {
  if (!ctx.hasUI) return;
  if (!active) {
    ctx.ui.setWidget("review", undefined);
    return;
  }

  ctx.ui.setWidget("review", (_tui, theme) => {
    const providerName = reviewTicketProvider === "jira" ? "Jira" : "Linear";
    const ticketLabel =
      reviewTicketComplianceEnabled && reviewInferredTicketId
        ? `${providerName} ${reviewInferredTicketId} compliance enabled`
        : reviewTicketComplianceEnabled
          ? `${providerName} ticket compliance enabled`
          : undefined;
    const details = reviewLoopInProgress
      ? ["loop fixing running", ticketLabel].filter(Boolean)
      : reviewLoopFixingEnabled
        ? [
            "loop fixing enabled",
            ticketLabel,
            "return with /end-review",
          ].filter(Boolean)
        : [ticketLabel, "return with /end-review"].filter(Boolean);
    const message = details.length
      ? `Review session active (${details.join(", ")})`
      : "Review session active";
    const text = new Text(theme.fg("warning", message), 0, 0);
    return {
      render(width: number) {
        return text.render(width);
      },
      invalidate() {
        text.invalidate();
      },
    };
  });
}

function getReviewState(ctx: ExtensionContext): ReviewSessionState | undefined {
  let state: ReviewSessionState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
      state = entry.data as ReviewSessionState | undefined;
    }
  }

  return state;
}

function applyReviewState(ctx: ExtensionContext) {
  const state = getReviewState(ctx);

  if (state?.active && state.originId) {
    reviewOriginId = state.originId;
    setReviewWidget(ctx, true);
    return;
  }

  reviewOriginId = undefined;
  setReviewWidget(ctx, false);
}

async function getReviewSettings(
  ctx: ExtensionContext,
): Promise<ReviewSettingsState> {
  const global = await loadGlobalSettings();

  let session: ReviewSettingsState | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === REVIEW_SETTINGS_TYPE) {
      session = entry.data as ReviewSettingsState | undefined;
    }
  }

  debugLog(
    `getReviewSettings: sessionEntry=${session ? "present" : "absent"} ` +
      `globalSendClaude=${global.sendToClaudeEnabled} sessionSendClaude=${session?.sendToClaudeEnabled}`,
  );

  // Session entry overrides global file (session > global > defaults).
  return {
    loopFixingEnabled: session?.loopFixingEnabled ?? global.loopFixingEnabled,
    ticketComplianceEnabled:
      session?.ticketComplianceEnabled ??
      session?.linearTicketComplianceEnabled ??
      global.ticketComplianceEnabled ??
      global.linearTicketComplianceEnabled,
    ticketProvider: session?.ticketProvider ?? global.ticketProvider ?? "linear",
    sendToClaudeEnabled: session?.sendToClaudeEnabled ?? global.sendToClaudeEnabled,
    sendToPiEnabled: session?.sendToPiEnabled ?? global.sendToPiEnabled,
  };
}

async function applyReviewSettings(ctx: ExtensionContext) {
  const state = await getReviewSettings(ctx);
  reviewLoopFixingEnabled = state.loopFixingEnabled === true;
  reviewTicketComplianceEnabled = state.ticketComplianceEnabled === true;
  reviewTicketProvider = state.ticketProvider ?? "linear";
  reviewSendToClaudeEnabled = state.sendToClaudeEnabled === true;
  reviewSendToPiEnabled = state.sendToPiEnabled === true;
  debugLog(
    `applyReviewSettings result: sendClaude=${reviewSendToClaudeEnabled} ` +
      `sendPi=${reviewSendToPiEnabled} originId=${reviewOriginId ?? "none"}`,
  );
}

function parseMarkdownHeading(
  line: string,
): { level: number; title: string } | null {
  const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
  if (!headingMatch) {
    return null;
  }

  const rawTitle = headingMatch[2].replace(/\s+#+\s*$/, "").trim();
  return {
    level: headingMatch[1].length,
    title: rawTitle,
  };
}

function getFindingsSectionBounds(
  lines: string[],
): { start: number; end: number } | null {
  let start = -1;
  let findingsHeadingLevel: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = parseMarkdownHeading(line);
    if (heading && /^findings\b/i.test(heading.title)) {
      start = i + 1;
      findingsHeadingLevel = heading.level;
      break;
    }
    if (/^\s*findings\s*:?\s*$/i.test(line)) {
      start = i + 1;
      break;
    }
  }

  if (start < 0) {
    return null;
  }

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const heading = parseMarkdownHeading(line);
    if (heading) {
      const normalizedTitle = heading.title.replace(/[*_`]/g, "").trim();
      if (
        /^(review scope|verdict|overall verdict|fix queue|constraints(?:\s*&\s*preferences)?)\b:?/i.test(
          normalizedTitle,
        )
      ) {
        end = i;
        break;
      }

      if (/\[P[0-4]\]/i.test(heading.title)) {
        continue;
      }

      if (
        findingsHeadingLevel !== null &&
        heading.level <= findingsHeadingLevel
      ) {
        end = i;
        break;
      }
    }

    if (
      /^\s*(review scope|verdict|overall verdict|fix queue|constraints(?:\s*&\s*preferences)?)\b:?/i.test(
        line,
      )
    ) {
      end = i;
      break;
    }
  }

  return { start, end };
}

function isLikelyFindingLine(line: string): boolean {
  if (!/\[P[0-4]\]/i.test(line)) {
    return false;
  }

  if (/^\s*(?:[-*+]|(?:\d+)[.)]|#{1,6})\s+priority\s+tag\b/i.test(line)) {
    return false;
  }

  if (
    /^\s*(?:[-*+]|(?:\d+)[.)]|#{1,6})\s+\[P[0-4]\]\s*-\s*(?:drop everything|urgent|normal|low|nice to have|pattern\/best-practice)\b/i.test(
      line,
    )
  ) {
    return false;
  }

  const allPriorityTags = line.match(/\[P[0-4]\]/gi) ?? [];
  if (allPriorityTags.length > 1) {
    return false;
  }

  if (/^\s*(?:[-*+]|(?:\d+)[.)])\s+/.test(line)) {
    return true;
  }

  if (/^\s*#{1,6}\s+/.test(line)) {
    return true;
  }

  if (/^\s*(?:\*\*|__)?\[P[0-4]\](?:\*\*|__)?(?=\s|:|-)/i.test(line)) {
    return true;
  }

  return false;
}

function normalizeVerdictValue(value: string): string {
  return value
    .trim()
    .replace(/^[-*+]\s*/, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .toLowerCase();
}

function isNeedsAttentionVerdictValue(value: string): boolean {
  const normalized = normalizeVerdictValue(value);
  if (!normalized.includes("needs attention")) {
    return false;
  }

  if (/\bnot\s+needs\s+attention\b/.test(normalized)) {
    return false;
  }

  // Reject rubric/choice phrasing like "correct or needs attention", but
  // keep legitimate verdict text that may contain unrelated "or".
  if (/\bcorrect\b/.test(normalized) && /\bor\b/.test(normalized)) {
    return false;
  }

  return true;
}

function hasNeedsAttentionVerdict(messageText: string): boolean {
  const lines = messageText.split(/\r?\n/);

  for (const line of lines) {
    const inlineMatch = line.match(
      /^\s*(?:[*-+]\s*)?(?:overall\s+)?verdict\s*:\s*(.+)$/i,
    );
    if (inlineMatch && isNeedsAttentionVerdictValue(inlineMatch[1])) {
      return true;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = parseMarkdownHeading(line);

    let verdictLevel: number | null = null;
    if (heading) {
      const normalizedHeading = heading.title.replace(/[*_`]/g, "").trim();
      if (!/^(?:overall\s+)?verdict\b/i.test(normalizedHeading)) {
        continue;
      }
      verdictLevel = heading.level;
    } else if (!/^\s*(?:overall\s+)?verdict\s*:?\s*$/i.test(line)) {
      continue;
    }

    for (let j = i + 1; j < lines.length; j++) {
      const verdictLine = lines[j];
      const nextHeading = parseMarkdownHeading(verdictLine);
      if (nextHeading) {
        const normalizedNextHeading = nextHeading.title
          .replace(/[*_`]/g, "")
          .trim();
        if (verdictLevel === null || nextHeading.level <= verdictLevel) {
          break;
        }
        if (
          /^(review scope|findings|fix queue|constraints(?:\s*&\s*preferences)?)\b:?/i.test(
            normalizedNextHeading,
          )
        ) {
          break;
        }
      }

      const trimmed = verdictLine.trim();
      if (!trimmed) {
        continue;
      }

      if (isNeedsAttentionVerdictValue(trimmed)) {
        return true;
      }

      if (/\bcorrect\b/i.test(normalizeVerdictValue(trimmed))) {
        break;
      }
    }
  }

  return false;
}

// Generic "this turn looks like the end-of-review verdict line" detector. Used as a
// gate before sending findings out to tmux/socket, so it must accept the markdown
// variants the LLM stochastically produces (`**Verdict**:`, `## Verdict`, etc.) —
// the simpler `/verdict\s*:/i` missed those and silently dropped real reviews.
function hasReviewVerdict(text: string): boolean {
  const cleaned = text.replace(/[*_`]/g, "");
  if (/(?:^|\n)\s*(?:[-+]\s+)?(?:overall\s+)?verdict\s*:/i.test(cleaned)) return true;
  if (/(?:^|\n)\s*#{1,6}\s+(?:overall\s+)?verdict\b/i.test(cleaned)) return true;
  return false;
}

function hasBlockingReviewFindings(messageText: string): boolean {
  const lines = messageText.split(/\r?\n/);
  const bounds = getFindingsSectionBounds(lines);
  const candidateLines = bounds ? lines.slice(bounds.start, bounds.end) : lines;

  let inCodeFence = false;
  let foundTaggedFinding = false;
  for (const line of candidateLines) {
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }

    if (!isLikelyFindingLine(line)) {
      continue;
    }

    foundTaggedFinding = true;
    if (/\[(P0|P1|P2)\]/i.test(line)) {
      return true;
    }
  }

  if (foundTaggedFinding) {
    return false;
  }

  return hasNeedsAttentionVerdict(messageText);
}

// Review target types (matching Codex's approach)
type ReviewTarget =
  | { type: "baseBranch"; branch: string }
  | {
      // An isolated worktree materialized on demand for the review. Covers both
      // "review a (local or remote) branch" and "review a PR" — a PR is just
      // remote work reviewed against a base. Removed at /end-review.
      type: "worktree";
      worktreePath: string;
      reviewSha: string;
      baseBranch: string;
      mergeBaseSha: string | null;
      label: string;
      pr?: { number: number };
      // Set only for PRs: the fetched ref (refs/pi-review/pr-<n>) to delete on cleanup.
      tempRef?: string;
    };

// The worktree variant alone — what the materialize* helpers produce.
type WorktreeTarget = Extract<ReviewTarget, { type: "worktree" }>;

// Prompts (adapted from Codex)
const LOCAL_CHANGES_REVIEW_INSTRUCTIONS =
  "Also include local working-tree changes (staged, unstaged, and untracked files) from this branch. Use `git status --porcelain`, `git diff`, `git diff --staged`, and `git ls-files --others --exclude-standard` so local fixes are part of this review cycle.";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
  "Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Provide prioritized, actionable findings.";

const BASE_BRANCH_PROMPT_FALLBACK =
  'Review the code changes against the base branch \'{branch}\'. Start by finding the merge diff between the current branch and {branch}\'s upstream e.g. (`git merge-base HEAD "$(git rev-parse --abbrev-ref "{branch}@{upstream}")"`), then run `git diff` against that SHA to see what changes we would merge into the {branch} branch. Provide prioritized, actionable findings.';

// Worktree reviews (and PRs) run against code checked out in a SEPARATE worktree.
// The prompt must steer the model to that path, never the current working dir.
const WORKTREE_REVIEW_PROMPT_WITH_MERGE_BASE =
  "Review the code changes for {label} against the base branch '{baseBranch}'. The code is checked out in a separate git worktree at {worktreePath} — review THAT worktree, not the current working directory. The merge base commit for this comparison is {mergeBaseSha}. Run `git -C {worktreePath} diff {mergeBaseSha}` to inspect the changes, and read files under {worktreePath} for full context. Provide prioritized, actionable findings.";

const WORKTREE_REVIEW_PROMPT_FALLBACK =
  "Review the code changes for {label} against the base branch '{baseBranch}'. The code is checked out in a separate git worktree at {worktreePath} — review THAT worktree, not the current working directory. Find the merge base with `git -C {worktreePath} merge-base {baseBranch} HEAD`, then run `git -C {worktreePath} diff <merge-base>` to inspect the changes. Provide prioritized, actionable findings.";

const LINEAR_TICKET_REVIEW_PROMPT =
  "Also review compliance with Linear ticket {ticketId}. Before finalizing the review, run `linear issue view {ticketId}` to inspect the ticket details, acceptance criteria, and any discussion/comments returned by the ticket view. Treat clarifications, follow-up questions, and additional implementation details from comments as part of the ticket context when they are relevant. Keep doing the normal code review, and additionally flag concrete mismatches, missing behavior, or contradictory behavior relative to the ticket body or comments when they are actionable. If the Linear command fails, explicitly say ticket compliance could not be verified and continue the normal review.";

const JIRA_TICKET_REVIEW_PROMPT =
  "Also review compliance with Jira ticket {ticketId}. Before finalizing the review, run `jira issue view {ticketId} --plain` to inspect the ticket details, acceptance criteria, and any discussion/comments. Treat clarifications, follow-up questions, and additional implementation details from comments as part of the ticket context when they are relevant. Keep doing the normal code review, and additionally flag concrete mismatches, missing behavior, or contradictory behavior relative to the ticket body or comments when they are actionable. If the Jira command fails, explicitly say ticket compliance could not be verified and continue the normal review.";

// The detailed review rubric (adapted from Codex's review_prompt.md)
const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Call out newly added dependencies explicitly and explain why they're needed.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Favor fail-fast behavior; avoid logging-and-continue patterns that hide errors.
4. Prefer predictable production behavior; crashing is better than silent degradation.
5. Treat back pressure handling as critical to system stability.
6. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
7. Ensure that errors are always checked against codes or stable identifiers, never error messages.
8. Check whether the change follows established patterns already used in this codebase. Flag meaningful inconsistencies when reusing the local pattern would make the code easier to understand, maintain, or extend.
9. If a \`CLAUDE.md\` or \`AGENTS.md\` file exists in the project, read it and enforce its instructions as part of the review. Flag meaningful deviations from those project rules when they are actionable.
10. For FastAPI or Pydantic code, consult the \`fastapi\` skill if needed and check against current FastAPI best practices: prefer idiomatic parameter/dependency typing, sensible router organization, correct sync vs async usage, and response typing/serialization patterns. Only flag these when the mismatch is actionable and meaningfully worse than the surrounding codebase.

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.
- [P4] - Pattern/best-practice issue. Non-blocking inconsistency with existing codebase patterns or FastAPI conventions.

## Output format

Provide your findings in a clear, structured format:
1. List each finding with its priority tag, file location, and explanation.
2. Findings must reference locations that overlap with the actual diff — don't flag pre-existing code.
3. Keep line references as short as possible (avoid ranges over 5-10 lines; pick the most suitable subrange).
4. At the end, provide an overall verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
5. Ignore trivial style issues unless they obscure meaning or violate documented standards.
6. Do not generate a full PR fix — only flag issues and optionally provide short suggestion blocks.

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue.`;

async function loadProjectReviewGuidelines(
  cwd: string,
): Promise<string | null> {
  let currentDir = path.resolve(cwd);

  while (true) {
    const piDir = path.join(currentDir, ".pi");
    const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

    const piStats = await fs.stat(piDir).catch(() => null);
    if (piStats?.isDirectory()) {
      const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
      if (guidelineStats?.isFile()) {
        try {
          const content = await fs.readFile(guidelinesPath, "utf8");
          const trimmed = content.trim();
          return trimmed ? trimmed : null;
        } catch {
          return null;
        }
      }
      return null;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

async function findProjectInstructionFile(cwd: string): Promise<string | null> {
  let currentDir = path.resolve(cwd);

  while (true) {
    for (const fileName of ["CLAUDE.md", "AGENTS.md"]) {
      const candidatePath = path.join(currentDir, fileName);
      const candidateStats = await fs.stat(candidatePath).catch(() => null);
      if (candidateStats?.isFile()) {
        return candidatePath;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * Get the merge base between HEAD and a branch
 */
async function getMergeBase(
  pi: ExtensionAPI,
  branch: string,
): Promise<string | null> {
  try {
    // First try to get the upstream tracking branch
    const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
      "rev-parse",
      "--abbrev-ref",
      `${branch}@{upstream}`,
    ]);

    if (upstreamCode === 0 && upstream.trim()) {
      const { stdout: mergeBase, code } = await pi.exec("git", [
        "merge-base",
        "HEAD",
        upstream.trim(),
      ]);
      if (code === 0 && mergeBase.trim()) {
        return mergeBase.trim();
      }
    }

    // Fall back to using the branch directly
    const { stdout: mergeBase, code } = await pi.exec("git", [
      "merge-base",
      "HEAD",
      branch,
    ]);
    if (code === 0 && mergeBase.trim()) {
      return mergeBase.trim();
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get list of local branches
 */
async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
  const { stdout, code } = await pi.exec("git", [
    "branch",
    "--format=%(refname:short)",
  ]);
  if (code !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .filter((b) => b.trim());
}

/**
 * Parse a PR reference (URL or number) and return the PR number
 */
function parsePrReference(ref: string): number | null {
  const trimmed = ref.trim();

  // Try as a number first
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num > 0) {
    return num;
  }

  // Try to extract from GitHub URL
  // Formats: https://github.com/owner/repo/pull/123
  //          github.com/owner/repo/pull/123
  const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  if (urlMatch) {
    return parseInt(urlMatch[1], 10);
  }

  return null;
}

function extractLinearTicketId(value: string): string | undefined {
  const match = value.match(/\b([a-zA-Z]{2,5})-(\d+)\b/);
  if (!match) {
    return undefined;
  }

  return `${match[1].toUpperCase()}-${match[2]}`;
}

function extractJiraTicketId(value: string): string | undefined {
  const match = value.match(/\b([A-Z]{2,10})-(\d+)\b/);
  if (!match) {
    const ciMatch = value.match(/\b([a-zA-Z]{2,10})-(\d+)\b/);
    if (!ciMatch) return undefined;
    return `${ciMatch[1].toUpperCase()}-${ciMatch[2]}`;
  }
  return `${match[1]}-${match[2]}`;
}

function extractTicketId(
  value: string,
  provider: "linear" | "jira",
): string | undefined {
  return provider === "jira"
    ? extractJiraTicketId(value)
    : extractLinearTicketId(value);
}

async function getHeadCommitTitle(pi: ExtensionAPI): Promise<string | null> {
  const { stdout, code } = await pi.exec("git", ["log", "-1", "--pretty=%s"]);
  if (code === 0 && stdout.trim()) {
    return stdout.trim();
  }
  return null;
}

async function inferTicketId(
  pi: ExtensionAPI,
  provider: "linear" | "jira",
): Promise<string | undefined> {
  const currentBranch = await getCurrentBranch(pi);
  const branchTicket = currentBranch
    ? extractTicketId(currentBranch, provider)
    : undefined;
  if (branchTicket) {
    return branchTicket;
  }

  const headCommitTitle = await getHeadCommitTitle(pi);
  const commitTicket = headCommitTitle
    ? extractTicketId(headCommitTitle, provider)
    : undefined;
  if (commitTicket) {
    return commitTicket;
  }

  return undefined;
}

/**
 * Get PR information from GitHub CLI
 */
async function getPrInfo(
  pi: ExtensionAPI,
  prNumber: number,
): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
  const { stdout, code } = await pi.exec("gh", [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "baseRefName,title,headRefName",
  ]);

  if (code !== 0) return null;

  try {
    const data = JSON.parse(stdout);
    return {
      baseBranch: data.baseRefName,
      title: data.title,
      headBranch: data.headRefName,
    };
  } catch {
    return null;
  }
}

/**
 * Get the current branch name
 */
async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
  const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
  if (code === 0 && stdout.trim()) {
    return stdout.trim();
  }
  return null;
}

/**
 * Get the default branch (main or master)
 */
async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
  // Try to get from remote HEAD
  const { stdout, code } = await pi.exec("git", [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "--short",
  ]);
  if (code === 0 && stdout.trim()) {
    return stdout.trim().replace("origin/", "");
  }

  // Fall back to checking if main or master exists
  const branches = await getLocalBranches(pi);
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";

  return "main"; // Default fallback
}

/**
 * Absolute repo root (toplevel of the current working tree).
 */
async function getRepoRoot(pi: ExtensionAPI): Promise<string | null> {
  const { stdout, code } = await pi.exec("git", [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (code === 0 && stdout.trim()) return stdout.trim();
  return null;
}

/**
 * Merge base between two arbitrary refs (generalizes getMergeBase, which is
 * fixed to HEAD). Used to diff a worktree's tip against its base branch.
 */
async function getMergeBaseBetween(
  pi: ExtensionAPI,
  a: string,
  b: string,
): Promise<string | null> {
  const { stdout, code } = await pi.exec("git", ["merge-base", a, b]);
  if (code === 0 && stdout.trim()) return stdout.trim();
  return null;
}

/**
 * All branch refs for the unified picker: local heads + remote-tracking
 * branches (origin/HEAD and friends excluded — they are pointer aliases).
 */
async function getAllBranchRefs(pi: ExtensionAPI): Promise<string[]> {
  const { stdout, code } = await pi.exec("git", [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  if (code !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b && !b.endsWith("/HEAD"));
}

function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

/**
 * Deterministic on-disk location for a review worktree:
 * ~/.pi-review/worktrees/<repoName>-<hash>/<sanitized-ref>-<shortSha>
 */
function worktreePathFor(repoRoot: string, ref: string, sha: string): string {
  const repoKey = `${path.basename(repoRoot)}-${shortHash(repoRoot)}`;
  const safeRef = ref.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return path.join(
    PI_REVIEW_WORKTREES_DIR,
    repoKey,
    `${safeRef || "ref"}-${sha.slice(0, 8)}`,
  );
}

type MaterializeResult =
  | { ok: true; target: WorktreeTarget }
  | { ok: false; error: string };

/**
 * Create a DETACHED worktree at `sha` and return a worktree ReviewTarget.
 * Detached (not on the branch) so it works even when `ref` is already checked
 * out in another worktree — git forbids the same branch in two worktrees.
 * Records it so /end-review (or the orphan sweep) can remove it later.
 */
async function createWorktreeTarget(
  pi: ExtensionAPI,
  opts: {
    repoRoot: string;
    ref: string;
    sha: string;
    baseBranch: string;
    label: string;
    pr?: { number: number };
    tempRef?: string;
  },
): Promise<MaterializeResult> {
  const worktreePath = worktreePathFor(opts.repoRoot, opts.ref, opts.sha);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  const { stderr, code } = await pi.exec("git", [
    "-C",
    opts.repoRoot,
    "worktree",
    "add",
    "--detach",
    worktreePath,
    opts.sha,
  ]);
  if (code !== 0) {
    return { ok: false, error: stderr.trim() || "git worktree add failed" };
  }

  await recordWorktree(opts.repoRoot, {
    path: worktreePath,
    ref: opts.ref,
    sha: opts.sha,
    tempRef: opts.tempRef,
    createdAt: new Date().toISOString(),
  });

  const mergeBaseSha = await getMergeBaseBetween(pi, opts.sha, opts.baseBranch);

  return {
    ok: true,
    target: {
      type: "worktree",
      worktreePath,
      reviewSha: opts.sha,
      baseBranch: opts.baseBranch,
      mergeBaseSha,
      label: opts.label,
      pr: opts.pr,
      tempRef: opts.tempRef,
    },
  };
}

/**
 * Resolve a picked branch ref to a commit SHA, fetching when it is remote.
 *
 * DESIGN NOTE (workflow-specific — tune to taste): a ref that names a known
 * remote (e.g. `origin/feature-x`) is treated as remote and always fetched, so
 * the worktree reflects the latest pushed state rather than a stale tracking
 * ref. Local refs are used as-is. Adjust here if you'd rather trust the local
 * tracking ref, or fetch from a specific remote by name.
 */
async function resolveReviewRef(
  pi: ExtensionAPI,
  ref: string,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const remote = ref.slice(0, slash);
    const branch = ref.slice(slash + 1);
    const { stdout: remotes } = await pi.exec("git", ["remote"]);
    const knownRemote = remotes
      .trim()
      .split("\n")
      .map((r) => r.trim())
      .includes(remote);
    if (knownRemote) {
      const { code: fetchCode, stderr } = await pi.exec("git", [
        "fetch",
        remote,
        branch,
      ]);
      if (fetchCode !== 0) {
        return { ok: false, error: stderr.trim() || `failed to fetch ${ref}` };
      }
    }
  }

  const { stdout, code } = await pi.exec("git", ["rev-parse", "--verify", ref]);
  if (code !== 0 || !stdout.trim()) {
    return { ok: false, error: `could not resolve ref '${ref}'` };
  }
  return { ok: true, sha: stdout.trim() };
}

/**
 * Materialize a worktree for a (local or remote) branch reviewed against base.
 */
async function materializeWorktree(
  pi: ExtensionAPI,
  reviewRef: string,
  baseBranch: string,
): Promise<MaterializeResult> {
  const repoRoot = await getRepoRoot(pi);
  if (!repoRoot) return { ok: false, error: "not a git repository" };

  const resolved = await resolveReviewRef(pi, reviewRef);
  if (!resolved.ok) return resolved;

  return createWorktreeTarget(pi, {
    repoRoot,
    ref: reviewRef,
    sha: resolved.sha,
    baseBranch,
    label: `branch '${reviewRef}'`,
  });
}

/**
 * Materialize a worktree for a GitHub PR reviewed against its base branch.
 * Fetches pull/<n>/head into a namespaced ref (works for fork PRs too) so we
 * never mutate the working tree the way `gh pr checkout` does.
 */
async function materializePrWorktree(
  pi: ExtensionAPI,
  prNumber: number,
): Promise<MaterializeResult> {
  const repoRoot = await getRepoRoot(pi);
  if (!repoRoot) return { ok: false, error: "not a git repository" };

  const info = await getPrInfo(pi, prNumber);
  if (!info) {
    return { ok: false, error: `could not read PR #${prNumber} via gh` };
  }

  const tempRef = `refs/pi-review/pr-${prNumber}`;
  const { code: fetchCode, stderr } = await pi.exec("git", [
    "fetch",
    "origin",
    `pull/${prNumber}/head:${tempRef}`,
  ]);
  if (fetchCode !== 0) {
    return {
      ok: false,
      error: stderr.trim() || `failed to fetch PR #${prNumber}`,
    };
  }

  const { stdout: sha, code: revCode } = await pi.exec("git", [
    "rev-parse",
    "--verify",
    tempRef,
  ]);
  if (revCode !== 0 || !sha.trim()) {
    return { ok: false, error: `could not resolve PR #${prNumber} head` };
  }

  return createWorktreeTarget(pi, {
    repoRoot,
    ref: `pr-${prNumber}`,
    sha: sha.trim(),
    baseBranch: info.baseBranch,
    label: `PR #${prNumber} ("${info.title}")`,
    pr: { number: prNumber },
    tempRef,
  });
}

/**
 * Remove all review worktrees for a repo: git worktree remove + prune, delete
 * any PR fetch refs, then clear the registry. Best-effort and idempotent.
 */
async function cleanupReviewWorktrees(
  pi: ExtensionAPI,
  repoRoot: string,
): Promise<void> {
  const records = await getWorktreeRecords(repoRoot);
  for (const rec of records) {
    await pi.exec("git", [
      "-C",
      repoRoot,
      "worktree",
      "remove",
      "--force",
      rec.path,
    ]);
    await fs.rm(rec.path, { recursive: true, force: true }).catch(() => {});
    if (rec.tempRef) {
      await pi.exec("git", ["-C", repoRoot, "update-ref", "-d", rec.tempRef]);
    }
  }
  await pi.exec("git", ["-C", repoRoot, "worktree", "prune"]);
  await clearWorktreeRecords(repoRoot);
}

/**
 * Build the review prompt based on target
 */
async function buildReviewPrompt(
  pi: ExtensionAPI,
  target: ReviewTarget,
  options?: {
    includeLocalChanges?: boolean;
    ticketId?: string;
    ticketProvider?: "linear" | "jira";
  },
): Promise<string> {
  const includeLocalChanges = options?.includeLocalChanges === true;
  const ticketId = options?.ticketId?.trim();
  const ticketProvider = options?.ticketProvider ?? "linear";

  let basePrompt: string;

  switch (target.type) {
    case "baseBranch": {
      const mergeBase = await getMergeBase(pi, target.branch);
      const branchPrompt = mergeBase
        ? BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(
            /{baseBranch}/g,
            target.branch,
          ).replace(/{mergeBaseSha}/g, mergeBase)
        : BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
      basePrompt = includeLocalChanges
        ? `${branchPrompt} ${LOCAL_CHANGES_REVIEW_INSTRUCTIONS}`
        : branchPrompt;
      break;
    }

    case "worktree": {
      // Review-only by design (no includeLocalChanges): the worktree is a
      // read-only materialization of someone else's / remote work.
      const fill = (template: string) =>
        template
          .replace(/{label}/g, target.label)
          .replace(/{baseBranch}/g, target.baseBranch)
          .replace(/{worktreePath}/g, target.worktreePath)
          .replace(/{mergeBaseSha}/g, target.mergeBaseSha ?? "");
      basePrompt = target.mergeBaseSha
        ? fill(WORKTREE_REVIEW_PROMPT_WITH_MERGE_BASE)
        : fill(WORKTREE_REVIEW_PROMPT_FALLBACK);
      break;
    }
  }

  if (!ticketId) {
    return basePrompt;
  }

  const ticketPrompt =
    ticketProvider === "jira"
      ? JIRA_TICKET_REVIEW_PROMPT
      : LINEAR_TICKET_REVIEW_PROMPT;
  return `${basePrompt} ${ticketPrompt.replace(/{ticketId}/g, ticketId)}`;
}

/**
 * Get user-facing hint for the review target
 */
function getUserFacingHint(target: ReviewTarget): string {
  switch (target.type) {
    case "baseBranch":
      return `changes against '${target.branch}'`;
    case "worktree":
      return `${target.label} vs '${target.baseBranch}'`;
  }
}

type AssistantSnapshot = {
  id: string;
  text: string;
  stopReason?: string;
};

function extractAssistantTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const textParts = content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(
        part &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "text" &&
          "text" in part,
      ),
    )
    .map((part) => part.text);
  return textParts.join("\n").trim();
}

function getLastAssistantSnapshot(
  ctx: ExtensionContext,
): AssistantSnapshot | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }

    const assistantMessage = entry.message as {
      content?: unknown;
      stopReason?: string;
    };
    return {
      id: entry.id,
      text: extractAssistantTextContent(assistantMessage.content),
      stopReason: assistantMessage.stopReason,
    };
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLoopTurnToStart(
  ctx: ExtensionContext,
  previousAssistantId?: string,
): Promise<boolean> {
  const deadline = Date.now() + REVIEW_LOOP_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const lastAssistantId = getLastAssistantSnapshot(ctx)?.id;
    if (
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      (lastAssistantId && lastAssistantId !== previousAssistantId)
    ) {
      return true;
    }
    await sleep(REVIEW_LOOP_START_POLL_MS);
  }

  return false;
}

// Review preset options for the selector (keep this order stable)
const REVIEW_PRESETS = [
  {
    value: "baseBranch",
    label: "Review against a base branch",
    description: "(local, current branch)",
  },
  {
    value: "worktree",
    label: "Review a worktree against a branch",
    description: "(local or remote, isolated)",
  },
  {
    value: "pullRequest",
    label: "Review a pull request",
    description: "(GitHub PR, isolated)",
  },
] as const;

const TOGGLE_LOOP_FIXING_VALUE = "toggleLoopFixing" as const;
const CONFIGURE_TICKET_COMPLIANCE_VALUE = "configureTicketCompliance" as const;
const TOGGLE_SEND_TO_CLAUDE_VALUE = "toggleSendToClaude" as const;
const TOGGLE_SEND_TO_PI_VALUE = "toggleSendToPi" as const;
type ReviewPresetValue =
  | (typeof REVIEW_PRESETS)[number]["value"]
  | typeof TOGGLE_LOOP_FIXING_VALUE
  | typeof CONFIGURE_TICKET_COMPLIANCE_VALUE
  | typeof TOGGLE_SEND_TO_CLAUDE_VALUE
  | typeof TOGGLE_SEND_TO_PI_VALUE;

export default function reviewExtension(pi: ExtensionAPI) {
  function persistReviewSettings() {
    const snapshot: ReviewSettingsState = {
      loopFixingEnabled: reviewLoopFixingEnabled,
      ticketComplianceEnabled: reviewTicketComplianceEnabled,
      ticketProvider: reviewTicketProvider,
      sendToClaudeEnabled: reviewSendToClaudeEnabled,
      sendToPiEnabled: reviewSendToPiEnabled,
    };
    pi.appendEntry(REVIEW_SETTINGS_TYPE, snapshot);
    // Fire-and-forget global save. Survives any session boundary that the
    // per-session entry doesn't (fork, navigateTree, resume, restart).
    saveGlobalSettings(snapshot).catch((err) => {
      debugLog(
        `saveGlobalSettings failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  function setReviewLoopFixingEnabled(enabled: boolean) {
    reviewLoopFixingEnabled = enabled;
    persistReviewSettings();
  }

  function setTicketComplianceEnabled(enabled: boolean) {
    reviewTicketComplianceEnabled = enabled;
    persistReviewSettings();
  }

  function setTicketProvider(provider: "linear" | "jira") {
    reviewTicketProvider = provider;
    persistReviewSettings();
  }

  function setSendToClaudeEnabled(enabled: boolean) {
    reviewSendToClaudeEnabled = enabled;
    if (enabled) reviewSendToPiEnabled = false;
    debugLog(`setSendToClaudeEnabled(${enabled})`);
    persistReviewSettings();
  }

  function setSendToPiEnabled(enabled: boolean) {
    reviewSendToPiEnabled = enabled;
    if (enabled) reviewSendToClaudeEnabled = false;
    debugLog(`setSendToPiEnabled(${enabled})`);
    persistReviewSettings();
  }

  async function refreshInferredTicket(
    ctx?: ExtensionContext,
  ): Promise<string | undefined> {
    reviewInferredTicketId = await inferTicketId(pi, reviewTicketProvider);
    if (ctx && reviewOriginId) {
      setReviewWidget(ctx, true);
    }
    return reviewInferredTicketId;
  }

  async function applyAllReviewState(ctx: ExtensionContext) {
    const settings = await getReviewSettings(ctx);
    await applyReviewSettings(ctx);
    applyReviewState(ctx);
    const inferredId = await refreshInferredTicket(ctx);

    if (settings.ticketComplianceEnabled === undefined && inferredId) {
      setTicketComplianceEnabled(true);
      if (reviewOriginId) {
        setReviewWidget(ctx, true);
      }
    }
  }

  async function toggleTicketCompliance(
    ctx: ExtensionContext,
  ): Promise<void> {
    if (reviewTicketComplianceEnabled) {
      setTicketComplianceEnabled(false);
      ctx.ui.notify("Ticket compliance disabled", "info");
      return;
    }

    // Ask which provider
    const providerChoice = await ctx.ui.select("Ticket provider:", [
      "Linear (default)",
      "Jira",
    ]);

    if (providerChoice === undefined) return;

    const provider: "linear" | "jira" =
      providerChoice === "Jira" ? "jira" : "linear";
    setTicketProvider(provider);

    const inferredId = await refreshInferredTicket(ctx);

    if (!inferredId) {
      ctx.ui.notify(
        `Could not infer a ${provider === "jira" ? "Jira" : "Linear"} ticket from the current branch or HEAD commit title.`,
        "warning",
      );
      return;
    }

    setTicketComplianceEnabled(true);
    const providerName = provider === "jira" ? "Jira" : "Linear";
    ctx.ui.notify(
      `${providerName} ticket compliance enabled for ${inferredId}`,
      "info",
    );
  }

  // session_start now covers the old session_switch / session_fork events too,
  // distinguished by event.reason ("startup" | "reload" | "new" | "resume" | "fork").
  // pi-mono refactor 9f9277cc (Apr 3 2026) consolidated those events.
  pi.on("session_start", async (event, ctx) => {
    debugLog(`event session_start reason=${event.reason}`);
    await applyAllReviewState(ctx);
    // Orphan sweep: when we're NOT resuming an active review, remove any
    // worktrees a previous (crashed/interrupted) review left behind for this
    // repo. applyAllReviewState set reviewOriginId above if a review is active.
    if (!reviewOriginId) {
      const repoRoot = await getRepoRoot(pi);
      if (repoRoot) await cleanupReviewWorktrees(pi, repoRoot);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    debugLog(`event session_tree`);
    await applyAllReviewState(ctx);
  });

  async function getMuxDir(): Promise<string> {
    const env = process.env;
    if (env.PI_MUX_DIR) return env.PI_MUX_DIR;
    const runtimeDir = env.XDG_RUNTIME_DIR || env.TMPDIR || "/tmp";
    const { stdout } = await pi.exec("id", ["-u"]);
    const uid = stdout.trim() || "1000";
    return `${runtimeDir}/pi-mux-${uid}`;
  }

  async function getClaudePane(): Promise<string | null> {
    const muxDir = await getMuxDir();

    // Get live pane list (needed for both cache validation and auto-detect)
    const { stdout: paneList, code: paneCode } = await pi.exec("tmux", [
      "list-panes",
      "-F",
      "#{pane_id} #{pane_top}",
    ]);
    if (paneCode !== 0 || !paneList.trim()) return null;

    const panes = paneList
      .trim()
      .split("\n")
      .map((line) => {
        const [id, top] = line.trim().split(" ");
        return { id, top: parseInt(top, 10) };
      })
      .filter((p) => !isNaN(p.top))
      .sort((a, b) => a.top - b.top);

    if (panes.length < 2) return null;

    const livePaneIds = new Set(panes.map((p) => p.id));

    // Try config.json, but only if the cached pane still exists
    const { stdout: configRaw, code: configCode } = await pi.exec("cat", [
      `${muxDir}/config.json`,
    ]);
    if (configCode === 0 && configRaw.trim()) {
      try {
        const config = JSON.parse(configRaw.trim());
        if (config.claudePane && livePaneIds.has(config.claudePane))
          return config.claudePane;
      } catch {}
    }

    // Auto-detect: smallest pane_top = Claude (top pane)
    const claudePane = panes[0].id;

    // Save config for next time
    await pi.exec("mkdir", ["-p", muxDir]);
    const piPane = panes[panes.length - 1].id;
    await pi.exec("bash", [
      "-c",
      `echo '${JSON.stringify({ claudePane, piPane })}' > "${muxDir}/config.json"`,
    ]);

    return claudePane;
  }

  async function sendFindingsToClaude(
    text: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    const claudePane = await getClaudePane();
    if (!claudePane) {
      ctx.ui.notify("Could not find Claude's tmux pane", "warning");
      return;
    }

    const muxDir = await getMuxDir();
    const bufferPath = `${muxDir}/paste-buffer.tmp`;

    // Write findings to temp file, load into tmux buffer, paste to Claude's pane
    await fs.mkdir(muxDir, { recursive: true });
    await fs.writeFile(bufferPath, `[pi-review findings]\n${text}`, "utf8");

    const { code: loadCode, stderr: loadErr } = await pi.exec("tmux", [
      "load-buffer",
      bufferPath,
    ]);
    if (loadCode !== 0) {
      ctx.ui.notify(
        `Failed to load review into tmux buffer: ${loadErr}`,
        "warning",
      );
      return;
    }

    const { code: pasteCode, stderr: pasteErr } = await pi.exec("tmux", [
      "paste-buffer",
      "-t",
      claudePane,
    ]);
    if (pasteCode !== 0) {
      ctx.ui.notify(
        `Failed to paste review to Claude's pane (${claudePane}): ${pasteErr}`,
        "warning",
      );
      return;
    }

    await new Promise((r) => setTimeout(r, 150));
    await pi.exec("tmux", ["send-keys", "-t", claudePane, "Enter"]);
    ctx.ui.notify("Review findings sent to Claude's pane", "info");
  }

  async function findTargetPiSocket(): Promise<string | null> {
    const ownSessionId = process.env.PI_SESSION_ID;
    try {
      const entries = await fs.readdir(PI_SESSION_CONTROL_DIR);
      for (const entry of entries) {
        if (!entry.endsWith(".sock")) continue;
        const sessionId = entry.replace(/\.sock$/, "");
        if (sessionId === ownSessionId) continue;
        return path.join(PI_SESSION_CONTROL_DIR, entry);
      }
    } catch {
      // Directory doesn't exist or not readable
    }
    return null;
  }

  async function sendFindingsToPi(
    text: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    const socketPath = await findTargetPiSocket();
    if (!socketPath) {
      ctx.ui.notify(
        "No target Pi session found in ~/.pi/session-control/",
        "warning",
      );
      return;
    }

    const rpcPayload =
      JSON.stringify({
        type: "send",
        message: `[pi-review findings]\n${text}`,
        mode: "follow_up",
      }) + "\n";

    return new Promise<void>((resolve) => {
      const socket = net.createConnection(socketPath, () => {
        socket.write(rpcPayload);
      });

      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx === -1) return;
        try {
          const resp = JSON.parse(buffer.slice(0, newlineIdx));
          if (resp.success) {
            ctx.ui.notify("Review findings sent to Pi session", "info");
          } else {
            ctx.ui.notify(
              `Failed to send findings to Pi: ${resp.error ?? "unknown"}`,
              "warning",
            );
          }
        } catch {
          ctx.ui.notify("Invalid response from Pi session socket", "warning");
        }
        socket.destroy();
        resolve();
      });

      socket.on("error", (err) => {
        ctx.ui.notify(`Pi session socket error: ${err.message}`, "warning");
        resolve();
      });

      socket.setTimeout(5000, () => {
        ctx.ui.notify("Pi session socket timed out", "warning");
        socket.destroy();
        resolve();
      });
    });
  }

  pi.on("turn_end", async (event, ctx) => {
    const assistantMsg = event.message;
    const isAssistant = assistantMsg.role === "assistant";
    const text = isAssistant
      ? extractAssistantTextContent(
          (assistantMsg as { content?: unknown }).content,
        )
      : "";
    const hasVerdict = !!text && hasReviewVerdict(text);

    debugLog(
      `turn_end: sendClaude=${reviewSendToClaudeEnabled} sendPi=${reviewSendToPiEnabled} ` +
        `originId=${reviewOriginId ?? "none"} role=${assistantMsg.role} ` +
        `textLen=${text?.length ?? 0} hasVerdict=${hasVerdict}` +
        // When text is present but verdict missed, log the tail so we can see
        // what format the LLM actually produced and refine the regex if needed.
        (text && !hasVerdict
          ? ` tail=${JSON.stringify(text.slice(-300))}`
          : ""),
    );

    if ((!reviewSendToClaudeEnabled && !reviewSendToPiEnabled) || !reviewOriginId)
      return;
    if (!isAssistant) return;
    if (!text) return;
    if (!hasVerdict) return;

    if (reviewSendToClaudeEnabled) {
      await sendFindingsToClaude(text, ctx);
    } else if (reviewSendToPiEnabled) {
      await sendFindingsToPi(text, ctx);
    }
  });

  /**
   * Determine the smart default review type based on git state
   */
  async function getSmartDefault(): Promise<"baseBranch" | "worktree"> {
    // On a feature branch → review the current branch in place. On the default
    // branch there's nothing local to diff, so default to the worktree picker.
    const currentBranch = await getCurrentBranch(pi);
    const defaultBranch = await getDefaultBranch(pi);
    if (currentBranch && currentBranch !== defaultBranch) {
      return "baseBranch";
    }
    return "worktree";
  }

  /**
   * Show the review preset selector
   */
  async function showReviewSelector(
    ctx: ExtensionContext,
  ): Promise<ReviewTarget | null> {
    // Determine smart default (but keep the list order stable)
    const smartDefault = await getSmartDefault();
    const presetItems: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
      value: preset.value,
      label: preset.label,
      description: preset.description,
    }));
    const smartDefaultIndex = presetItems.findIndex(
      (item) => item.value === smartDefault,
    );

    while (true) {
      const inferredId = await refreshInferredTicket();
      const providerName = reviewTicketProvider === "jira" ? "Jira" : "Linear";
      const loopToggleLabel = reviewLoopFixingEnabled
        ? "Disable Loop Fixing"
        : "Enable Loop Fixing";
      const loopToggleDescription = reviewLoopFixingEnabled
        ? "(currently on)"
        : "(currently off)";
      const ticketToggleLabel = reviewTicketComplianceEnabled
        ? `Disable ${providerName} ticket compliance`
        : inferredId
          ? "Enable ticket compliance"
          : "Ticket compliance unavailable";
      const ticketToggleDescription = reviewTicketComplianceEnabled
        ? inferredId
          ? `(${providerName}: ${inferredId})`
          : `(${providerName}, no ticket inferred)`
        : inferredId
          ? `(auto ${inferredId})`
          : "(infer from branch/HEAD)";
      const sendToClaudeLabel = reviewSendToClaudeEnabled
        ? "Disable send to Claude (tmux)"
        : "Enable send to Claude (tmux)";
      const sendToClaudeDescription = reviewSendToClaudeEnabled
        ? "(currently on)"
        : "(currently off)";
      const sendToPiLabel = reviewSendToPiEnabled
        ? "Disable send to Pi (session-control)"
        : "Enable send to Pi (session-control)";
      const sendToPiDescription = reviewSendToPiEnabled
        ? "(currently on)"
        : "(currently off)";
      const items: SelectItem[] = [
        ...presetItems,
        {
          value: CONFIGURE_TICKET_COMPLIANCE_VALUE,
          label: ticketToggleLabel,
          description: ticketToggleDescription,
        },
        {
          value: TOGGLE_LOOP_FIXING_VALUE,
          label: loopToggleLabel,
          description: loopToggleDescription,
        },
        {
          value: TOGGLE_SEND_TO_CLAUDE_VALUE,
          label: sendToClaudeLabel,
          description: sendToClaudeDescription,
        },
        {
          value: TOGGLE_SEND_TO_PI_VALUE,
          label: sendToPiLabel,
          description: sendToPiDescription,
        },
      ];

      const result = await ctx.ui.custom<ReviewPresetValue | null>(
        (tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(
            new DynamicBorder((str) => theme.fg("accent", str)),
          );
          container.addChild(
            new Text(theme.fg("accent", theme.bold("Select a review preset"))),
          );

          const selectList = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });

          // Preselect the smart default without reordering the list
          if (smartDefaultIndex >= 0) {
            selectList.setSelectedIndex(smartDefaultIndex);
          }

          selectList.onSelect = (item) => done(item.value as ReviewPresetValue);
          selectList.onCancel = () => done(null);

          container.addChild(selectList);
          container.addChild(
            new Text(
              theme.fg("dim", "Press enter to confirm or esc to go back"),
            ),
          );
          container.addChild(
            new DynamicBorder((str) => theme.fg("accent", str)),
          );

          return {
            render(width: number) {
              return container.render(width);
            },
            invalidate() {
              container.invalidate();
            },
            handleInput(data: string) {
              selectList.handleInput(data);
              tui.requestRender();
            },
          };
        },
      );

      if (!result) return null;

      if (result === TOGGLE_LOOP_FIXING_VALUE) {
        const nextEnabled = !reviewLoopFixingEnabled;
        setReviewLoopFixingEnabled(nextEnabled);
        ctx.ui.notify(
          nextEnabled ? "Loop fixing enabled" : "Loop fixing disabled",
          "info",
        );
        continue;
      }

      if (result === CONFIGURE_TICKET_COMPLIANCE_VALUE) {
        await toggleTicketCompliance(ctx);
        continue;
      }

      if (result === TOGGLE_SEND_TO_CLAUDE_VALUE) {
        const nextEnabled = !reviewSendToClaudeEnabled;
        setSendToClaudeEnabled(nextEnabled);
        ctx.ui.notify(
          nextEnabled
            ? "Send to Claude enabled (findings will be pasted to Claude's tmux pane)"
            : "Send to Claude disabled",
          "info",
        );
        continue;
      }

      if (result === TOGGLE_SEND_TO_PI_VALUE) {
        const nextEnabled = !reviewSendToPiEnabled;
        setSendToPiEnabled(nextEnabled);
        ctx.ui.notify(
          nextEnabled
            ? "Send to Pi enabled (findings will be sent via session-control socket)"
            : "Send to Pi disabled",
          "info",
        );
        continue;
      }

      // Handle each preset type
      switch (result) {
        case "baseBranch": {
          const target = await showBranchSelector(ctx);
          if (target) return target;
          break;
        }

        case "worktree": {
          const target = await showWorktreeReviewFlow(ctx);
          if (target) return target;
          break;
        }

        case "pullRequest": {
          const target = await showPrInput(ctx);
          if (target) return target;
          break;
        }

        default:
          return null;
      }
    }
  }

  /**
   * Show branch selector for base branch review
   */
  async function showBranchSelector(
    ctx: ExtensionContext,
  ): Promise<ReviewTarget | null> {
    const branches = await getLocalBranches(pi);
    const currentBranch = await getCurrentBranch(pi);
    const defaultBranch = await getDefaultBranch(pi);

    // Never offer the current branch as a base branch (reviewing against itself is meaningless).
    const candidateBranches = currentBranch
      ? branches.filter((b) => b !== currentBranch)
      : branches;

    if (candidateBranches.length === 0) {
      ctx.ui.notify(
        currentBranch
          ? `No other branches found (current branch: ${currentBranch})`
          : "No branches found",
        "error",
      );
      return null;
    }

    // Sort branches with default branch first
    const sortedBranches = candidateBranches.sort((a, b) => {
      if (a === defaultBranch) return -1;
      if (b === defaultBranch) return 1;
      return a.localeCompare(b);
    });

    const items: SelectItem[] = sortedBranches.map((branch) => ({
      value: branch,
      label: branch,
      description: branch === defaultBranch ? "(default)" : "",
    }));

    const result = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
        container.addChild(
          new Text(theme.fg("accent", theme.bold("Select base branch"))),
        );

        const searchInput = new Input();
        container.addChild(searchInput);
        container.addChild(new Spacer(1));

        const listContainer = new Container();
        container.addChild(listContainer);
        container.addChild(
          new Text(
            theme.fg("dim", "Type to filter • enter to select • esc to cancel"),
          ),
        );
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

        let filteredItems = items;
        let selectList: SelectList | null = null;

        const updateList = () => {
          listContainer.clear();
          if (filteredItems.length === 0) {
            listContainer.addChild(
              new Text(theme.fg("warning", "  No matching branches")),
            );
            selectList = null;
            return;
          }

          selectList = new SelectList(
            filteredItems,
            Math.min(filteredItems.length, 10),
            {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            },
          );

          selectList.onSelect = (item) => done(item.value);
          selectList.onCancel = () => done(null);
          listContainer.addChild(selectList);
        };

        const applyFilter = () => {
          const query = searchInput.getValue();
          filteredItems = query
            ? fuzzyFilter(
                items,
                query,
                (item) =>
                  `${item.label} ${item.value} ${item.description ?? ""}`,
              )
            : items;
          updateList();
        };

        applyFilter();

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            if (
              keybindings.matches(data, "tui.select.up") ||
              keybindings.matches(data, "tui.select.down") ||
              keybindings.matches(data, "tui.select.confirm") ||
              keybindings.matches(data, "tui.select.cancel")
            ) {
              if (selectList) {
                selectList.handleInput(data);
              } else if (keybindings.matches(data, "tui.select.cancel")) {
                done(null);
              }
              tui.requestRender();
              return;
            }

            searchInput.handleInput(data);
            applyFilter();
            tui.requestRender();
          },
        };
      },
    );

    if (!result) return null;
    return { type: "baseBranch", branch: result };
  }

  /**
   * Generic fuzzy single-select over a list of items. Returns the chosen
   * item.value, or null on cancel. Shared UI for the branch/ref pickers.
   */
  async function fuzzySelect(
    ctx: ExtensionContext,
    title: string,
    items: SelectItem[],
    noMatchLabel: string,
  ): Promise<string | null> {
    if (items.length === 0) return null;
    return ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title))));

      const searchInput = new Input();
      container.addChild(searchInput);
      container.addChild(new Spacer(1));

      const listContainer = new Container();
      container.addChild(listContainer);
      container.addChild(
        new Text(
          theme.fg("dim", "Type to filter • enter to select • esc to cancel"),
        ),
      );
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

      let filteredItems = items;
      let selectList: SelectList | null = null;

      const updateList = () => {
        listContainer.clear();
        if (filteredItems.length === 0) {
          listContainer.addChild(
            new Text(theme.fg("warning", `  ${noMatchLabel}`)),
          );
          selectList = null;
          return;
        }

        selectList = new SelectList(
          filteredItems,
          Math.min(filteredItems.length, 10),
          {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
        );

        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);
        listContainer.addChild(selectList);
      };

      const applyFilter = () => {
        const query = searchInput.getValue();
        filteredItems = query
          ? fuzzyFilter(
              items,
              query,
              (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
            )
          : items;
        updateList();
      };

      applyFilter();

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          if (
            keybindings.matches(data, "tui.select.up") ||
            keybindings.matches(data, "tui.select.down") ||
            keybindings.matches(data, "tui.select.confirm") ||
            keybindings.matches(data, "tui.select.cancel")
          ) {
            if (selectList) {
              selectList.handleInput(data);
            } else if (keybindings.matches(data, "tui.select.cancel")) {
              done(null);
            }
            tui.requestRender();
            return;
          }

          searchInput.handleInput(data);
          applyFilter();
          tui.requestRender();
        },
      };
    });
  }

  /**
   * Unified picker for the branch/ref to review: local heads + remote-tracking
   * branches. Returns the chosen ref (e.g. "feature-x" or "origin/feature-x").
   */
  async function showRefSelector(
    ctx: ExtensionContext,
  ): Promise<string | null> {
    const refs = await getAllBranchRefs(pi);
    if (refs.length === 0) {
      ctx.ui.notify("No branches found", "error");
      return null;
    }
    const items: SelectItem[] = refs.map((ref) => ({
      value: ref,
      label: ref,
      description: ref.includes("/") ? "(remote)" : "",
    }));
    return fuzzySelect(
      ctx,
      "Select branch to review (local or remote)",
      items,
      "No matching branches",
    );
  }

  /**
   * Pick the base branch to diff against (local branches, default first).
   */
  async function pickBaseBranch(
    ctx: ExtensionContext,
    excludeRef?: string,
  ): Promise<string | null> {
    const branches = await getLocalBranches(pi);
    const defaultBranch = await getDefaultBranch(pi);
    const candidates = branches
      .filter((b) => b !== excludeRef)
      .sort((a, b) => {
        if (a === defaultBranch) return -1;
        if (b === defaultBranch) return 1;
        return a.localeCompare(b);
      });
    if (candidates.length === 0) {
      ctx.ui.notify("No base branches found", "error");
      return null;
    }
    const items: SelectItem[] = candidates.map((b) => ({
      value: b,
      label: b,
      description: b === defaultBranch ? "(default)" : "",
    }));
    return fuzzySelect(
      ctx,
      "Select base branch",
      items,
      "No matching branches",
    );
  }

  /**
   * Worktree review flow: pick a (local/remote) branch + base branch, then
   * materialize an isolated worktree to review against the base.
   */
  async function showWorktreeReviewFlow(
    ctx: ExtensionContext,
  ): Promise<ReviewTarget | null> {
    const reviewRef = await showRefSelector(ctx);
    if (!reviewRef) return null;

    const baseBranch = await pickBaseBranch(ctx, reviewRef);
    if (!baseBranch) return null;

    ctx.ui.notify(`Materializing worktree for '${reviewRef}'...`, "info");
    const result = await materializeWorktree(pi, reviewRef, baseBranch);
    if (!result.ok) {
      ctx.ui.notify(`Could not set up worktree: ${result.error}`, "error");
      return null;
    }
    ctx.ui.notify(`Reviewing ${result.target.label}`, "info");
    return result.target;
  }

  /**
   * Show PR input and materialize an isolated worktree for the PR.
   */
  async function showPrInput(
    ctx: ExtensionContext,
  ): Promise<ReviewTarget | null> {
    const prRef = await ctx.ui.editor(
      "Enter PR number or URL (e.g. 123 or https://github.com/owner/repo/pull/123):",
      "",
    );

    if (!prRef?.trim()) return null;

    const prNumber = parsePrReference(prRef);
    if (!prNumber) {
      ctx.ui.notify(
        "Invalid PR reference. Enter a number or GitHub PR URL.",
        "error",
      );
      return null;
    }

    ctx.ui.notify(
      `Fetching PR #${prNumber} into an isolated worktree...`,
      "info",
    );
    const result = await materializePrWorktree(pi, prNumber);
    if (!result.ok) {
      ctx.ui.notify(
        `Could not review PR #${prNumber}: ${result.error}`,
        "error",
      );
      return null;
    }

    ctx.ui.notify(`Reviewing ${result.target.label}`, "info");
    return result.target;
  }

  /**
   * Execute the review
   */
  async function executeReview(
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
    useFreshSession: boolean,
    options?: { includeLocalChanges?: boolean },
  ): Promise<boolean> {
    // Check if we're already in a review
    if (reviewOriginId) {
      ctx.ui.notify(
        "Already in a review. Use /end-review to finish first.",
        "warning",
      );
      return false;
    }

    // Handle fresh session mode
    if (useFreshSession) {
      // Store current position (where we'll return to).
      // In an empty session there is no leaf yet, so create a lightweight anchor first.
      let originId = ctx.sessionManager.getLeafId() ?? undefined;
      if (!originId) {
        pi.appendEntry(REVIEW_ANCHOR_TYPE, {
          createdAt: new Date().toISOString(),
        });
        originId = ctx.sessionManager.getLeafId() ?? undefined;
      }
      if (!originId) {
        ctx.ui.notify("Failed to determine review origin.", "error");
        return false;
      }
      reviewOriginId = originId;

      // Keep a local copy so session_tree events during navigation don't wipe it
      const lockedOriginId = originId;

      // Find the first user message in the session.
      // If none exists (e.g. brand-new session), we'll stay on the current leaf.
      const entries = ctx.sessionManager.getEntries();
      const firstUserMessage = entries.find(
        (e) => e.type === "message" && e.message.role === "user",
      );

      if (firstUserMessage) {
        // Navigate to first user message to create a new branch from that point
        // Label it as "code-review" so it's visible in the tree
        try {
          const result = await ctx.navigateTree(firstUserMessage.id, {
            summarize: false,
            label: "code-review",
          });
          if (result.cancelled) {
            reviewOriginId = undefined;
            return false;
          }
        } catch (error) {
          // Clean up state if navigation fails
          reviewOriginId = undefined;
          ctx.ui.notify(
            `Failed to start review: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return false;
        }

        // Clear the editor (navigating to user message fills it with the message text)
        ctx.ui.setEditorText("");
      }

      // Restore origin after navigation events (session_tree can reset it)
      reviewOriginId = lockedOriginId;

      // Show widget indicating review is active
      setReviewWidget(ctx, true);

      // Persist review state so tree navigation can restore/reset it
      pi.appendEntry(REVIEW_STATE_TYPE, {
        active: true,
        originId: lockedOriginId,
      });
    }

    const ticketId = reviewTicketComplianceEnabled
      ? await refreshInferredTicket(ctx)
      : undefined;
    const providerName = reviewTicketProvider === "jira" ? "Jira" : "Linear";
    const prompt = await buildReviewPrompt(pi, target, {
      includeLocalChanges: options?.includeLocalChanges === true,
      ticketId,
      ticketProvider: reviewTicketProvider,
    });
    const hint = getUserFacingHint(target);
    const ticketHint = ticketId
      ? ` + ${providerName} ${ticketId} compliance`
      : "";
    if (reviewTicketComplianceEnabled && !ticketId) {
      ctx.ui.notify(
        `${providerName} ticket compliance is enabled, but no ticket could be inferred from the current branch or HEAD commit title. Running a normal review.`,
        "warning",
      );
    }
    const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);
    const instructionFilePath = await findProjectInstructionFile(ctx.cwd);

    // Combine the review rubric with the specific prompt
    let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;

    if (projectGuidelines) {
      fullPrompt += `\n\nThis project has additional instructions for code reviews:\n\n${projectGuidelines}`;
    }

    if (instructionFilePath) {
      fullPrompt += `\n\nBefore finalizing the review, read \`${instructionFilePath}\` and verify the changes follow its project rules. Treat meaningful deviations from that file as review findings when actionable.`;
    }

    const modeHint = useFreshSession ? " (fresh session)" : "";
    ctx.ui.notify(`Starting review: ${hint}${ticketHint}${modeHint}`, "info");

    // Send as a user message that triggers a turn
    pi.sendUserMessage(fullPrompt);
    return true;
  }

  /**
   * Parse command arguments for direct invocation
   * Returns the target or a special marker for PR that needs async handling
   */
  function parseArgs(
    args: string | undefined,
  ):
    | ReviewTarget
    | { type: "pr"; ref: string }
    | { type: "worktreeCli"; ref: string; base?: string }
    | null {
    if (!args?.trim()) return null;

    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    switch (subcommand) {
      case "branch": {
        const branch = parts[1];
        if (!branch) return null;
        return { type: "baseBranch", branch };
      }

      case "worktree": {
        const ref = parts[1];
        if (!ref) return null;
        return { type: "worktreeCli", ref, base: parts[2] };
      }

      case "pr": {
        const ref = parts[1];
        if (!ref) return null;
        return { type: "pr", ref };
      }

      default:
        return null;
    }
  }

  /**
   * Materialize an isolated worktree for a PR ref and return a ReviewTarget.
   */
  async function handlePrCheckout(
    ctx: ExtensionContext,
    ref: string,
  ): Promise<ReviewTarget | null> {
    const prNumber = parsePrReference(ref);
    if (!prNumber) {
      ctx.ui.notify(
        "Invalid PR reference. Enter a number or GitHub PR URL.",
        "error",
      );
      return null;
    }

    ctx.ui.notify(
      `Fetching PR #${prNumber} into an isolated worktree...`,
      "info",
    );
    const result = await materializePrWorktree(pi, prNumber);
    if (!result.ok) {
      ctx.ui.notify(
        `Could not review PR #${prNumber}: ${result.error}`,
        "error",
      );
      return null;
    }
    ctx.ui.notify(`Reviewing ${result.target.label}`, "info");
    return result.target;
  }

  /**
   * Materialize an isolated worktree for a branch ref (CLI path).
   */
  async function handleWorktreeCli(
    ctx: ExtensionContext,
    ref: string,
    base?: string,
  ): Promise<ReviewTarget | null> {
    const baseBranch = base ?? (await getDefaultBranch(pi));
    ctx.ui.notify(`Materializing worktree for '${ref}'...`, "info");
    const result = await materializeWorktree(pi, ref, baseBranch);
    if (!result.ok) {
      ctx.ui.notify(`Could not set up worktree: ${result.error}`, "error");
      return null;
    }
    ctx.ui.notify(`Reviewing ${result.target.label}`, "info");
    return result.target;
  }

  function isLoopCompatibleTarget(target: ReviewTarget): boolean {
    // Only in-place base-branch review supports the fix → re-review loop;
    // worktree reviews (including PRs) are review-only.
    return target.type === "baseBranch";
  }

  async function runLoopFixingReview(
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
  ): Promise<void> {
    if (reviewLoopInProgress) {
      ctx.ui.notify("Loop fixing review is already running.", "warning");
      return;
    }

    reviewLoopInProgress = true;
    setReviewWidget(ctx, Boolean(reviewOriginId));
    try {
      ctx.ui.notify(
        "Loop fixing enabled: using Empty branch mode and cycling until no blocking findings remain.",
        "info",
      );

      for (let pass = 1; pass <= REVIEW_LOOP_MAX_ITERATIONS; pass++) {
        const reviewBaselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
        const started = await executeReview(ctx, target, true, {
          includeLocalChanges: true,
        });
        if (!started) {
          ctx.ui.notify(
            "Loop fixing stopped before starting the review pass.",
            "warning",
          );
          return;
        }

        const reviewTurnStarted = await waitForLoopTurnToStart(
          ctx,
          reviewBaselineAssistantId,
        );
        if (!reviewTurnStarted) {
          ctx.ui.notify(
            "Loop fixing stopped: review pass did not start in time.",
            "error",
          );
          return;
        }

        await ctx.waitForIdle();

        const reviewSnapshot = getLastAssistantSnapshot(ctx);
        if (
          !reviewSnapshot ||
          reviewSnapshot.id === reviewBaselineAssistantId
        ) {
          ctx.ui.notify(
            "Loop fixing stopped: could not read the review result.",
            "warning",
          );
          return;
        }

        if (reviewSnapshot.stopReason === "aborted") {
          ctx.ui.notify("Loop fixing stopped: review was aborted.", "warning");
          return;
        }

        if (reviewSnapshot.stopReason === "error") {
          ctx.ui.notify(
            "Loop fixing stopped: review failed with an error.",
            "error",
          );
          return;
        }

        if (reviewSnapshot.stopReason === "length") {
          ctx.ui.notify(
            "Loop fixing stopped: review output was truncated (stopReason=length).",
            "warning",
          );
          return;
        }

        if (!hasBlockingReviewFindings(reviewSnapshot.text)) {
          const finalized = await executeEndReviewAction(
            ctx,
            "returnAndSummarize",
            {
              showSummaryLoader: true,
              notifySuccess: false,
            },
          );
          if (finalized !== "ok") {
            return;
          }

          ctx.ui.notify(
            "Loop fixing complete: no blocking findings remain.",
            "info",
          );
          return;
        }

        ctx.ui.notify(
          `Loop fixing pass ${pass}: found blocking findings, returning to fix them...`,
          "info",
        );

        const fixBaselineAssistantId = getLastAssistantSnapshot(ctx)?.id;
        const sentFixPrompt = await executeEndReviewAction(
          ctx,
          "returnAndFix",
          {
            showSummaryLoader: true,
            notifySuccess: false,
          },
        );
        if (sentFixPrompt !== "ok") {
          return;
        }

        const fixTurnStarted = await waitForLoopTurnToStart(
          ctx,
          fixBaselineAssistantId,
        );
        if (!fixTurnStarted) {
          ctx.ui.notify(
            "Loop fixing stopped: fix pass did not start in time.",
            "error",
          );
          return;
        }

        await ctx.waitForIdle();

        const fixSnapshot = getLastAssistantSnapshot(ctx);
        if (!fixSnapshot || fixSnapshot.id === fixBaselineAssistantId) {
          ctx.ui.notify(
            "Loop fixing stopped: could not read the fix pass result.",
            "warning",
          );
          return;
        }
        if (fixSnapshot.stopReason === "aborted") {
          ctx.ui.notify(
            "Loop fixing stopped: fix pass was aborted.",
            "warning",
          );
          return;
        }
        if (fixSnapshot.stopReason === "error") {
          ctx.ui.notify(
            "Loop fixing stopped: fix pass failed with an error.",
            "error",
          );
          return;
        }
        if (fixSnapshot.stopReason === "length") {
          ctx.ui.notify(
            "Loop fixing stopped: fix pass output was truncated (stopReason=length).",
            "warning",
          );
          return;
        }
      }

      ctx.ui.notify(
        `Loop fixing stopped after ${REVIEW_LOOP_MAX_ITERATIONS} passes (safety limit reached).`,
        "warning",
      );
    } finally {
      reviewLoopInProgress = false;
      setReviewWidget(ctx, Boolean(reviewOriginId));
    }
  }

  // Register the /review command
  pi.registerCommand("review", {
    description:
      "Review code changes (base branch, a worktree, or a PR) with optional ticket compliance (Linear/Jira)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Review requires interactive mode", "error");
        return;
      }

      if (reviewLoopInProgress) {
        ctx.ui.notify("Loop fixing review is already running.", "warning");
        return;
      }

      // Check if we're already in a review
      if (reviewOriginId) {
        ctx.ui.notify(
          "Already in a review. Use /end-review to finish first.",
          "warning",
        );
        return;
      }

      // Check if we're in a git repository
      const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
      if (code !== 0) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }

      // Try to parse direct arguments
      let target: ReviewTarget | null = null;
      let fromSelector = false;
      const parsed = parseArgs(args);

      if (parsed) {
        if (parsed.type === "pr") {
          target = await handlePrCheckout(ctx, parsed.ref);
          if (!target) {
            ctx.ui.notify(
              "PR review failed. Returning to review menu.",
              "warning",
            );
          }
        } else if (parsed.type === "worktreeCli") {
          target = await handleWorktreeCli(ctx, parsed.ref, parsed.base);
          if (!target) {
            ctx.ui.notify(
              "Worktree review failed. Returning to review menu.",
              "warning",
            );
          }
        } else {
          target = parsed;
        }
      }

      // If no args or invalid args, show selector
      if (!target) {
        fromSelector = true;
      }

      while (true) {
        if (!target && fromSelector) {
          target = await showReviewSelector(ctx);
        }

        if (!target) {
          ctx.ui.notify("Review cancelled", "info");
          return;
        }

        if (reviewLoopFixingEnabled && !isLoopCompatibleTarget(target)) {
          ctx.ui.notify(
            "Loop mode only works with base-branch review.",
            "error",
          );
          if (fromSelector) {
            target = null;
            continue;
          }
          return;
        }

        if (reviewLoopFixingEnabled) {
          await runLoopFixingReview(ctx, target);
          return;
        }

        // Determine if we should use fresh session mode
        // Check if this is a new session (no messages yet)
        const entries = ctx.sessionManager.getEntries();
        const messageCount = entries.filter((e) => e.type === "message").length;

        // In an empty session, default to fresh review mode so /end-review works consistently.
        let useFreshSession = messageCount === 0;

        if (messageCount > 0) {
          // Existing session - ask user which mode they want
          const choice = await ctx.ui.select("Start review in:", [
            "Empty branch",
            "Current session",
          ]);

          if (choice === undefined) {
            if (fromSelector) {
              target = null;
              continue;
            }
            ctx.ui.notify("Review cancelled", "info");
            return;
          }

          useFreshSession = choice === "Empty branch";
        }

        await executeReview(ctx, target, useFreshSession);
        return;
      }
    },
  });

  // Custom prompt for review summaries - focuses on preserving actionable findings
  const REVIEW_SUMMARY_PROMPT = `We are leaving a code-review branch and returning to the main coding branch.
Create a structured handoff that can be used immediately to implement fixes.

You MUST summarize the review that happened in this branch so findings can be acted on.
Do not omit findings: include every actionable issue that was identified.

Required sections (in order):

## Review Scope
- What was reviewed (files/paths, changes, and scope)

## Verdict
- "correct" or "needs attention"

## Findings
For EACH finding, include:
- Priority tag ([P0]..[P4]) and short title
- File location (\`path/to/file.ext:line\`)
- Why it matters (brief)
- What should change (brief, actionable)

## Fix Queue
1. Ordered implementation checklist (highest priority first)

## Constraints & Preferences
- Any constraints or preferences mentioned during review
- Or "(none)"

Preserve exact file paths, function names, and error messages where available.`;

  const REVIEW_FIX_FINDINGS_PROMPT = `Use the latest review summary in this session and implement the review findings now.

Instructions:
1. Treat the summary's Findings/Fix Queue as a checklist.
2. Fix in priority order: P0, P1, then P2 (include P3 and P4 if quick and safe).
3. If a finding is invalid/already fixed/not possible right now, briefly explain why and continue.
4. Run relevant tests/checks for touched code where practical.
5. End with: fixed items, deferred/skipped items (with reasons), and verification results.`;

  type EndReviewAction = "returnOnly" | "returnAndFix" | "returnAndSummarize";
  type EndReviewActionResult = "ok" | "cancelled" | "error";
  type EndReviewActionOptions = {
    showSummaryLoader?: boolean;
    notifySuccess?: boolean;
  };

  function getActiveReviewOrigin(ctx: ExtensionContext): string | undefined {
    if (reviewOriginId) {
      return reviewOriginId;
    }

    const state = getReviewState(ctx);
    if (state?.active && state.originId) {
      reviewOriginId = state.originId;
      return reviewOriginId;
    }

    if (state?.active) {
      setReviewWidget(ctx, false);
      pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
      ctx.ui.notify(
        "Review state was missing origin info; cleared review status.",
        "warning",
      );
    }

    return undefined;
  }

  function clearReviewState(ctx: ExtensionContext) {
    setReviewWidget(ctx, false);
    reviewOriginId = undefined;
    pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
  }

  // Remove any worktrees this review materialized for the current repo.
  async function cleanupReviewWorktreesForRepo(): Promise<void> {
    const repoRoot = await getRepoRoot(pi);
    if (repoRoot) await cleanupReviewWorktrees(pi, repoRoot);
  }

  async function navigateWithSummary(
    ctx: ExtensionCommandContext,
    originId: string,
    showLoader: boolean,
  ): Promise<{ cancelled: boolean; error?: string } | null> {
    if (showLoader && ctx.hasUI) {
      return ctx.ui.custom<{ cancelled: boolean; error?: string } | null>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            "Returning and summarizing review branch...",
          );
          loader.onAbort = () => done(null);

          ctx
            .navigateTree(originId, {
              summarize: true,
              customInstructions: REVIEW_SUMMARY_PROMPT,
              replaceInstructions: true,
            })
            .then(done)
            .catch((err) =>
              done({
                cancelled: false,
                error: err instanceof Error ? err.message : String(err),
              }),
            );

          return loader;
        },
      );
    }

    try {
      return await ctx.navigateTree(originId, {
        summarize: true,
        customInstructions: REVIEW_SUMMARY_PROMPT,
        replaceInstructions: true,
      });
    } catch (error) {
      return {
        cancelled: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function executeEndReviewAction(
    ctx: ExtensionCommandContext,
    action: EndReviewAction,
    options: EndReviewActionOptions = {},
  ): Promise<EndReviewActionResult> {
    const originId = getActiveReviewOrigin(ctx);
    if (!originId) {
      if (!getReviewState(ctx)?.active) {
        ctx.ui.notify(
          "Not in a review branch (use /review first, or review was started in current session mode)",
          "info",
        );
      }
      return "error";
    }

    const notifySuccess = options.notifySuccess ?? true;

    if (action === "returnOnly") {
      try {
        const result = await ctx.navigateTree(originId, { summarize: false });
        if (result.cancelled) {
          ctx.ui.notify(
            "Navigation cancelled. Use /end-review to try again.",
            "info",
          );
          return "cancelled";
        }
      } catch (error) {
        ctx.ui.notify(
          `Failed to return: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return "error";
      }

      clearReviewState(ctx);
      await cleanupReviewWorktreesForRepo();
      if (notifySuccess) {
        ctx.ui.notify(
          "Review complete! Returned to original position.",
          "info",
        );
      }
      return "ok";
    }

    const summaryResult = await navigateWithSummary(
      ctx,
      originId,
      options.showSummaryLoader ?? false,
    );
    if (summaryResult === null) {
      ctx.ui.notify(
        "Summarization cancelled. Use /end-review to try again.",
        "info",
      );
      return "cancelled";
    }

    if (summaryResult.error) {
      ctx.ui.notify(`Summarization failed: ${summaryResult.error}`, "error");
      return "error";
    }

    if (summaryResult.cancelled) {
      ctx.ui.notify(
        "Navigation cancelled. Use /end-review to try again.",
        "info",
      );
      return "cancelled";
    }

    clearReviewState(ctx);
    await cleanupReviewWorktreesForRepo();

    if (action === "returnAndSummarize") {
      if (!ctx.ui.getEditorText().trim()) {
        ctx.ui.setEditorText("Act on the review findings");
      }
      if (notifySuccess) {
        ctx.ui.notify("Review complete! Returned and summarized.", "info");
      }
      return "ok";
    }

    pi.sendUserMessage(REVIEW_FIX_FINDINGS_PROMPT, { deliverAs: "followUp" });
    if (notifySuccess) {
      ctx.ui.notify(
        "Review complete! Returned and queued a follow-up to fix findings.",
        "info",
      );
    }
    return "ok";
  }

  async function runEndReview(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("End-review requires interactive mode", "error");
      return;
    }

    if (reviewLoopInProgress) {
      ctx.ui.notify(
        "Loop fixing review is running. Wait for it to finish.",
        "info",
      );
      return;
    }

    if (endReviewInProgress) {
      ctx.ui.notify("/end-review is already running", "info");
      return;
    }

    endReviewInProgress = true;
    try {
      const choice = await ctx.ui.select("Finish review:", [
        "Return only",
        "Return and fix findings",
        "Return and summarize",
      ]);

      if (choice === undefined) {
        ctx.ui.notify("Cancelled. Use /end-review to try again.", "info");
        return;
      }

      const action: EndReviewAction =
        choice === "Return and fix findings"
          ? "returnAndFix"
          : choice === "Return and summarize"
            ? "returnAndSummarize"
            : "returnOnly";

      await executeEndReviewAction(ctx, action, {
        showSummaryLoader: true,
        notifySuccess: true,
      });
    } finally {
      endReviewInProgress = false;
    }
  }

  // Register the /end-review command
  pi.registerCommand("end-review", {
    description: "Complete review and return to original position",
    handler: async (_args, ctx) => {
      await runEndReview(ctx);
    },
  });
}
