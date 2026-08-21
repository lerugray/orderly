# ORDERLY — Mission

ORDERLY is a self-hosted personal operations assistant: the one that handles the generic
life admin outside dev work. Email triage and drafting, calendar, reminders, the recurring
chores people buy "AI assistant" products for — running on hardware the operator owns, on
the operator's own flat-rate model subscription, answering one person.

## Shape of the mature product

- **Channels:** a chat channel first (Telegram is the reference); a clean, professional web
  UI as the second surface. Enable and adapt what OpenClaw ships before building custom.
- **Connectors:** mail, git/GitHub, calendar, and kin — added one at a time, each starting
  at the lowest privilege that's useful (read-only before send/write).
- **Trust model:** allowlisted operator only; sandboxed tool execution; loopback gateway;
  one credential per connector, never the whole keyring. Every privilege expansion is a
  deliberate, recorded decision.
- **Provider-agnostic:** the model backend is the operator's choice — ORDERLY the recipe
  should work for anyone with any subscription.

## Non-goals

- Not a dev tool itself — the station never edits code, commits, or merges. An orchestrator
  seat that *dispatches* bounded dev work to external agent lanes is in scope: the station
  brokers, watches, and reports; the code work stays in the lanes and verification stays
  with the operator.
- Not multi-tenant SaaS — single-operator first. "Other users" means other people running
  the recipe on their own boxes, not accounts on someone else's.

## Success looks like

The operator reaching for the bot by default for life admin, weekly, without thinking about
the plumbing — and the plumbing never surprising them.
