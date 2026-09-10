# MANGU delivery workflow

Canonical operating system for features, stories, agents, and COO work.
This document is **docs-only** and does not thaw the launch freeze in #209.

| Surface | Role |
| --- | --- |
| GitHub Issues (`Mangu-Publishing-House/my_publishing`) | **Source of truth** for Features and Stories |
| This repository + PR to `main` | **Source of truth** for code |
| Vercel → https://www.mangu-publishers.com | **Source of truth** for production (ADR-001) |
| Azure DevOps Boards | Optional mirror. Not connected in the current Grok workspace. |
| GitHub Copilot / Copilot Studio / house agents | Workers. They consume issues; they do not own the backlog. |

Program epic: [#415](https://github.com/Mangu-Publishing-House/my_publishing/issues/415)

## Hierarchy

```
Epic (#415)
  Feature
    Story / Task
      Pull request (one vehicle per signature)
```

Use GitHub issue types when the UI offers them:

- `Feature` — shipable capability
- `Task` — story or implementation slice
- `Bug` — defect

Parent every Story to a Feature. Do not file orphan product work.

## How to add work

1. Open **New issue** and pick Feature, Story, COO, or Agent.
2. If it is a Story, set the parent Feature (`#416` workflow, `#417` revamp, `#418` COO, `#419` agents, `#420` commerce).
3. Label `phase:workflow` (delivery system), `phase:revamp` (product), and `phase:post-go` if it must not merge during freeze.
4. Implement on a branch. One PR. Rebase on `main`. Fix CI. See `.github/AGENTS.md`.

Commerce work already exists. Do not open a second checkout tracker — attach to #205 / #420.

## Freeze rules (still in force)

From #209 / `docs/NEXT_GO.md`:

Permitted now: docs, CI-truth, branch hygiene, one recovery vehicle per failure, approved security.
Held: product revamp merges, Dependabot majors, release 1.0.0.

## Operator scripts (board + ADO)

These cannot be executed from this Grok connector: GitHub Projects is 403, and Azure DevOps is not a connected app.

On a machine where you are logged into `gh` as an org owner:

```bash
gh auth refresh -s project,read:project -h github.com
chmod +x scripts/gh-seed-delivery-board.sh
./scripts/gh-seed-delivery-board.sh
```

That creates org project **MANGU Delivery** and attaches #415–#429.

Azure Boards first load (no live sync until you install the GitHub App):

1. Set `ADO_ORG` + `ADO_PROJECT` if you want the helper script.
2. Boards → Queries → Import work items → `docs/ado/mangu-delivery-import.csv`
3. Details: `docs/ado/README.md`

Optional Actions job: **Seed MANGU Delivery board** (`workflow_dispatch`). Needs repo secret `PROJECT_ADMIN_TOKEN` with `project` scope. Default is dry-run.

## Azure DevOps mirror

Azure DevOps is **not** a connected tool in this Grok session. GitHub stays authoritative until an ADO org is wired.

### Mapping

| GitHub | Azure Boards |
| --- | --- |
| Epic issue (`type:epic`) | Epic |
| Feature issue (`type:feature`) | Feature |
| Story issue (`type:story`) | User Story |
| Bug | Bug |
| PR | do not duplicate as a work item; link the GitHub PR |

### Connect (manual, once)

1. In Azure DevOps: **Project settings → GitHub connections → Connect**.
2. Install the Azure Boards GitHub App on org `Mangu-Publishing-House`, repo `my_publishing`.
3. Enable **Azure Boards** on the repo (Issues + PRs).
4. Choose area path `MANGU\\Delivery` and an iteration path (create if missing).
5. Confirm a GitHub issue labeled `ado:sync` appears as a Boards work item with the GitHub URL in the discussion.
6. Keep state changes on **one** side per day. Prefer GitHub state as master; ADO columns follow.

Needed from the operator before sync can be verified: Azure DevOps **org name** and **project name**.

## Copilot Studio and house agents

Microsoft Copilot Studio is tenant-side. This repo publishes the contract:

1. Work item is a GitHub Story with acceptance criteria.
2. Agent is assigned only if the story is small enough for one PR.
3. Agent opens or updates a single PR (`.github/AGENTS.md` rule 1).
4. Human merges after CI.

Local / GitHub Copilot CLI: `docs/COPILOT_CLI.md`.

### Agent roster

| Agent | File | Use |
| --- | --- | --- |
| explore | `.github/agents/explore.agent.md` | Orient in the repo |
| plan | `.github/agents/plan.agent.md` | Design, no code |
| task | `.github/agents/task.agent.md` | Exact commands |
| research | `.github/agents/research.agent.md` | Trace a subsystem |
| code-review | `.github/agents/code-review.agent.md` | Review a diff |
| merge-steward | `.github/agents/merge-steward.agent.md` | PR hygiene |
| my-agent | `.github/agents/my-agent.agent.md` | Maintenance |
| coo-ops | `.github/agents/coo-ops.agent.md` | Pipeline, exceptions, cadence |
| backlog-steward | `.github/agents/backlog-steward.agent.md` | Dedupe, parents, freeze labels |

## GitHub Project board

Creating the board from this session failed (`projects` API 403 on the current GitHub connector). After `gh auth refresh -s project`:

```bash
./scripts/gh-seed-delivery-board.sh
```

Columns: Backlog → Ready → In progress → Review → Done. Status field is the only workflow state.

## Seeded backlog

| # | Kind | Title |
| --- | --- | --- |
| 415 | Epic | Delivery system + product revamp |
| 416 | Feature | GitHub ↔ ADO ↔ Copilot workflow |
| 417 | Feature | Site and catalog revamp |
| 418 | Feature | COO operating system |
| 419 | Feature | Agent factory |
| 420 | Feature | Commerce path (points at existing P0s) |
| 421 | Story | Issue templates (closed via #430) |
| 422 | Story | ADO mapping |
| 423 | Story | Projects permission + board |
| 424 | Story | Homepage IA |
| 425 | Story | Catalog empty-state truth |
| 426 | Story | Title pipeline map |
| 427 | Story | Weekly COO cadence |
| 428 | Story | COO + backlog-steward agents (closed via #430) |
| 429 | Story | Copilot entry path |
