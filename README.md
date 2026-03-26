# pi-review

A [Pi coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension for interactive code review with ticket compliance and tmux integration.

Based on the original [review extension](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/review.ts) by [@mitsuhiko](https://github.com/mitsuhiko).

## What it does

- Interactive code review with multiple modes (uncommitted, branch, PR, commit, folder, custom)
- Ticket compliance checking for **Linear** and **Jira** (inferred from branch name or HEAD commit)
- Loop fixing mode — automatically cycles review → fix → re-review until no blocking findings remain
- Send review findings to Claude's tmux pane for cross-agent workflows
- Project-specific review guidelines via `REVIEW_GUIDELINES.md`
- Fresh session branching for isolated reviews with `/end-review` to return

## Install

```
pi install git:github.com/carlosarraes/pi-review
```

Requires `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` >= 0.49.0.

## Usage

- `/review` — open the interactive review selector
- `/review uncommitted` — review uncommitted changes
- `/review branch main` — review against a base branch
- `/review pr 123` — checkout and review a GitHub PR
- `/review commit abc123` — review a specific commit
- `/review folder src docs` — snapshot review of paths
- `/review custom "check for security issues"` — custom instructions

### Toggles in the selector

- **Ticket compliance** — enable Linear (`linear issue view AAA-123`) or Jira (`jira issue view AAA-123 --plain`) compliance checking. Ticket ID is auto-inferred from branch name or HEAD commit.
- **Loop fixing** — automatically re-review after fixing findings until clean.
- **Send to Claude (tmux)** — paste review findings into Claude's tmux pane when the review finishes. Uses the [pi-mux](https://github.com/mitsuhiko/agent-stuff) pane detection pattern.

### Finishing a review

- `/end-review` — return to the original session position, optionally summarizing or auto-fixing findings.

## License

MIT
