# Release notes

## v0.3.0

### Named persistent agents

A new **Agents** page lets you stand up named agents alongside the built-in desks. Give one
a name, a short description and a handle, and it gets its own thread on the station sidebar:
a standing identity with its own memory, rather than a one-off conversation.

Creation is credential-free by construction. The form takes only a name, a description, a
handle and a memory policy — nothing else is accepted, and a name or description that reads
like a filesystem path, a URL, an environment assignment or a credential is refused outright
rather than silently stored. Every change that matters to trust — renaming, re-describing,
suspending, resuming, retiring, removing — shows a plain confirmation of exactly what it
grants first: network, credentials, delegation, capabilities. An agent that grants none of
those says so, in those words, before you confirm anything. Retiring an agent keeps its
transcript, memory and audit trail; a removed handle stays reserved, so a name can never
later land on a different identity.

This is the first milestone. Per-agent sandboxes, delegation to the mail and research
agents, @-mentions, group agents, and attaching a named agent to its own Telegram bot are
next, not yet — today, a named agent talks to you only on the station's own desk.

### Local-model seats

A seat can now be pointed at a model you run yourself — Ollama, llama.cpp, LM Studio, vLLM,
or anything else that speaks the OpenAI-compatible chat API — on this machine, your LAN, or
your tailnet. ORDERLY still runs no inference of its own: an engine is just an endpoint you
already have, configured the same way a cloud provider always has been, and an endpoint that
wants no credential is never asked to supply one. Before an engine is offered to a seat it's
probed end to end: reachability, the exact model tag, a real completion with no fabricated
credential in the request.

What a seat is trusted to do is stated honestly rather than assumed. The **chat-research**
tier is fully live, including a single tool call where a probe has actually watched that
engine make one. Ask more of it than that and the seat says so — what was asked, what tier
it's running, what's missing — rather than doing one step and calling the job done. The
**chained-task** tier is present in the configuration format and refused everywhere it
matters: the harness it depends on isn't built yet, and naming it in configuration produces a
plain error saying exactly that. The **coding lane** is not a model choice at all — that's
the orchestrator desk's own dispatch path, and no locally configured engine is ever a route
onto it.

### Also in this release

- The installer (`web/deploy/install.sh`) now installs the two new modules — `agents.mjs`
  and `engines.mjs` — as part of a normal install or upgrade, no separate step required.

## v0.2.1

### Mascot picker fixed

Picking a desk theme other than Night Desk now shows that theme's own mascot artwork
throughout the header, live and animated the same way the default always was. Previously
the swap only ever revealed the default mascot underneath, no matter which theme was
selected.

### Dashboard meters, upgraded

- **Scoped subscription windows now render.** A provider whose quota is reported as more
  than one window — for example a headline session cap alongside a separate, longer-scoped
  cap — now shows every window instead of only the first.
- **Window labels are duration-truthful.** A provider row previously mislabeled a monthly
  quota as a session or weekly one; window labels are now derived from the window's actual
  duration rather than assumed from its position in the response.
- **Providers with no published quota render as status rows**, never a fabricated percent.
- **Percent display cleanup.** Meter percentages are rounded to one decimal place, fixing
  rare floating-point noise (a reading like `79.460000000000001%`) in the raw display.

### Cursor subscription meter

Cursor is now a supported provider in the dashboard's subscription meters, alongside the
existing set — add it to your `web/dashboard-subscriptions.json` the same way as any other
provider.

### Installer polish

`web/deploy/install.sh` no longer prints a spurious shell-warning during `--dry-run` on
some `awk` implementations. No behavior change; the dry-run output is identical.

## v0.2.0

### Dashboard

A new **Dashboard** tab sits alongside Station, Orchestration, and Settings. It is a
glanceable summary of what the station already knows, linking back to the detailed
surfaces rather than acting as a second control plane: what needs attention, gateway and
service health, lane health, recent dispatch activity, and the order queues.

**Subscription meters are opt-in.** Point ORDERLY at a local quota reader and the
dashboard will show the remaining window for each AI subscription you configure — any
supported provider, not just one. The meters are advisory and snapshot-only: they report
what a provider already exposes, and they never gate, spend, or throttle anything.

The recommended transport is a loopback read, which means the web service holds no
provider credential at all — the quota reader runs as the credential-owning user and
answers on localhost. Copy `web/dashboard-subscriptions.example.json` to
`web/dashboard-subscriptions.json` and list the subscriptions you want shown; the real
file is git-ignored. Third-party attribution and the pinned contract are in
`web/CODEXBAR-NOTICE.md`.

### Context packs

A repository in the broker allowlist can now name a context pack: a host-maintained code
map and set of conventions that is attached to every brief for that repository. Delegated
work starts already grounded instead of spending its brief re-describing the codebase.

Packs are host-owned — they arrive from the allowlist file, never from chat. A configured
pack that is missing, empty, oversized, or named by a relative path refuses to start the
broker rather than failing later at dispatch time. The pack's hash is part of the digest
you review before confirming, so your confirmation covers the grounding the worker
actually receives, and a pack edited between review and confirmation is refused rather
than silently substituted.

### Desk themes

Six visual identities, each a palette with a matching mascot: Night Desk (the default,
unchanged), Tidepool, Blue Hour, Dispatch, Evergreen, and Afterglow. Pick one in Settings
under Appearance. The choice is a browser preference, so it changes nothing on the host,
and with no choice saved the desk keeps its original look exactly.

### Upgrade-safe installer

`web/deploy/install.sh` can now be re-run against a station that is already installed
without clobbering it. An existing service unit is treated as the source of truth, so the
ports, paths, and environment settled at first install survive an upgrade; explicit
environment overrides still win. Also added: a `--dry-run` mode that prints every root
command it would run and changes nothing, a readability check on the provider-docs path,
and file ownership matched to the identity the unit actually runs as.

### README

The front page is rewritten and much shorter: what ORDERLY does today, its security
posture, what you need in order to install it, and where the boundaries are.

### Also in this release

- The broker runs standalone. Its seat ships generic default standing orders and a packet
  schema in `broker/defaults/`, so a clean checkout boots and passes its own tests without
  any host-specific files. Both can be overridden by path.
- Theme mascots ship inside `web/public/`, so the front door resolves them the same way
  whether it runs from a checkout or from an installed directory. Static file resolution
  is contained to that directory, with a test that fails if anything reaches outside it.

## v0.1.0

First public release: the broker, the web front door, the interface and feature
specifications, and the test suites.
