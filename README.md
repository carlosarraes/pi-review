# pi-review

A [Pi coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension for interactive code review with ticket compliance and tmux integration.

Based on the original [review extension](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/review.ts) by [@mitsuhiko](https://github.com/mitsuhiko).

## What it does

- Interactive code review against a base branch — the current branch in place, any local/remote branch in an isolated worktree, or a GitHub PR
- Worktree & PR reviews are materialized on demand (fetched if remote) into a throwaway git worktree that never touches your working tree, and are removed at `/end-review`
- Ticket compliance checking for **Linear** and **Jira** (inferred from branch name or HEAD commit)
- Loop fixing mode — automatically cycles review → fix → re-review until no blocking findings remain
- Send review findings to Claude's tmux pane for cross-agent workflows
- Project-specific review guidelines via `REVIEW_GUIDELINES.md`
- Fresh session branching for isolated reviews with `/end-review` to return

## Install

```
pi install git:github.com/carlosarraes/pi-review
```

Requires `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` >= 0.49.0.

## Usage

- `/review` — open the interactive review selector
- `/review branch main` — review the current branch against a base branch
- `/review worktree feature-x main` — review branch `feature-x` against `main` in an isolated worktree (fetches it first if remote-only)
- `/review pr 123` — review a GitHub PR in an isolated worktree

### Toggles in the selector

- **Ticket compliance** — enable Linear (`linear issue view AAA-123`) or Jira (`jira issue view AAA-123 --plain`) compliance checking. Ticket ID is auto-inferred from branch name or HEAD commit.
- **Loop fixing** — automatically re-review after fixing findings until clean.
- **Send to Claude (tmux)** — paste review findings into Claude's tmux pane when the review finishes. Uses the [pi-mux](https://github.com/mitsuhiko/agent-stuff) pane detection pattern.

### Finishing a review

- `/end-review` — return to the original session position, optionally summarizing or auto-fixing findings.

## License

MIT
