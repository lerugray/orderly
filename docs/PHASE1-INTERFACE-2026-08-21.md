# Phase 1 interface contract — desk ↔ broker (2026-08-21)

Binding contract for the two Phase-1 build lanes. The broker lane owns `broker/`; the
desk lane owns `web/server.mjs` + `web/public/`. Neither touches the other's surface.
Parent spec: `docs/ORCHESTRATOR-SCOPE-2026-08-20.md` §Phase 1 + §Anti-goals (binding).

## Topology

- **Broker** = standalone host service (Node, no framework beyond stdlib/undici), run
  OUTSIDE all agent containers as its own least-privilege user (NOT in the docker
  group). Listens on a UNIX domain socket only (`~/.orderly/broker.sock`, mode 0660) —
  no TCP port, ever.
- **Desk** = new surface in the existing front door (`web/server.mjs` DESKS + lane-cards
  UI in `web/public/`). server.mjs is the broker's ONLY client in v1 and proxies typed
  verbs; it never shells out and never constructs lane commands itself.

## Verbs (HTTP over the socket, JSON bodies)

- `POST /v1/dispatch/propose` `{repo_id, preset_id, brief_text, timeout_s}` →
  `{proposal_id, digest: {repo_id, base_sha, brief_sha256, preset_id, timeout_s}}`.
  Broker resolves `base_sha` itself from the allowlisted repo's pinned branch; refuses
  unknown `repo_id`/`preset_id`; never accepts paths, argv, env, or model strings.
- `POST /v1/dispatch/confirm` `{proposal_id, digest_ack}` → `{lane_id}`. `digest_ack`
  must byte-match the proposed digest (operator saw and confirmed it). Idempotent by
  `proposal_id`: one execution, one event, ever. Proposals expire (15 min).
- `GET /v1/lanes` / `GET /v1/lanes/:id` → lane records (read-only).
- `GET /v1/allowlist` → ids and bounds only (`repos[]{repo_id, branch}`,
  `presets[]{preset_id, timeout_max_s}`) for populating desk dropdowns; paths and
  command templates never leave the host. (Added at integration, 2026-08-21.)
- `POST /v1/seat/consult` `{ask}` → `{proposal}` or `{seat_failure}`. This invokes the
  pinned episodic seat against the current broker snapshot and is consult-only: it cannot
  dispatch, cancel, or mutate registry state. Execution still flows exclusively through
  `dispatch/propose` → operator digest review → `dispatch/confirm`.
- `POST /v1/lanes/:id/cancel` → TERM→KILL the lane's process group, terminal class set.
  DELIBERATE asymmetry with dispatch: cancel has no propose/confirm digest pair. The
  seat's `cancel` decision is a chat-level recommendation only; execution is always the
  operator's authenticated cancel via the desk (it stops work, preserves the tree per
  harvest rules, and is token-gated — that suffices).
- `POST /v1/freeze` → reject all new proposals/confirms until unfrozen at the host.

## Auth (defense in depth — BOTH layers check)

Every mutating verb (propose/confirm/cancel/freeze), plus `seat/consult` because it spends
subscription quota, requires header
`X-Orderly-Operator: <token>` where the token is a broker-side secret from
`~/.orderly/broker.env`, compared constant-time. The desk collects the token from the
operator per session (never stored in the page, never in the repo, never logged) and
forwards it. Tailnet reachability + same-origin authorizes NOTHING mutating. Read-only
verbs (`GET`) ride the existing same-origin posture.

## Lane record (broker-owned truth)

```
{ id, repo_id, base_sha, brief_sha256, preset_id, timeout_s,
  state: proposed|dispatched|running|terminal,
  terminal_class: exit-zero|failed|timed-out|process-unclean|no-op,
  terminal_record: { exit_code, sweep_result, git_status_stable },
  harvest: { patch_sha256, patch_path, untracked_inventory, diffstat },
  log_excerpt,            // bounded, redacted; raw log path is operator-only
  created_ts, dispatched_ts, terminal_ts }
```

Terminal lanes surface as **"ready for operator inspection"** — never "success" or
"verified". Worker prose in logs is labeled unverified; the terminal record outranks it.

## Allowlists

`broker/allowlist.json5`: `repos[] {repo_id, url_or_path, branch}` and
`presets[] {preset_id, cmd_template, sandbox, timeout_max_s}`. The broker clones fresh
at the resolved SHA into its own scratch dir per lane — never a synced or dirty tree.
ONE active lane at a time in v1; a second confirm queues as `proposed` until the board
is empty. The SEAT is expected to `hold` rather than propose a second dispatch while a
lane is active (per its orders and trial case R4) — the broker queue is a defense-in-
depth backstop, not a workflow.
