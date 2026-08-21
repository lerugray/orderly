# Release notes

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
