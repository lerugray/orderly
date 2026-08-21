# v0.4 direction — per-agent connectors (operator ruling, 2026-08-21)

The operator's direction, banked ahead of the v0.4 arc: named agents become genuinely
useful when they can reach outside services — Dropbox, Basecamp, Stripe, and kin. This is
the Grok Bot capability that makes agents personal. ORDERLY builds it the ORDERLY way:

1. **Each connector is its own credential boundary** — its own service account, unit,
   socket, and store, per SPEC-NAMED-AGENTS §7's per-connector path. Never a shared
   keyring, never Grok Bot's one-account-token-for-everything model.
2. **The worked precedent is the calendar-write path**: a host-side credentialed service
   that no agent container mounts, invoked through an approval flow. v0.4 generalizes
   that pattern into a connector framework.
3. **Attachment is per-agent and operator-ruled** at attach time: which agent gets which
   connector, with which scopes, is a deliberate ruling — composing with the named-agents
   attachment seam (Telegram is the first instance of the same idea).
4. Sequencing: after the named-agents/local-seats M2s. Spec (Fugu) fires when the v0.4
   arc opens; this note is direction, not design.
