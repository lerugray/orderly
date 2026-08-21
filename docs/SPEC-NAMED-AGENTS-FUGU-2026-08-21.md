> **RATIFIED AS BUILD DIRECTION 2026-08-21 (orchestrator, by the operator's delegation).** Reviewed against the identity-split posture and accepted; operator rulings inside this doc bind. Build lanes ground here.

# ORDERLY Named Persistent Agents — design spec (2026-08-21)

Produced via a deep-reasoning model from a spec-only ask (numbered required sections,
explicit anti-goals, no code), grounded in this project's design history, its live systemd
unit files, and prior planning notes — plus a live recon of xAI's Grok Bot (Anysphere "Sand"
whitelabel) as the reference feature shape, whose shared-credential-pool model this spec
explicitly declines to copy. It is intended to give the operator something concrete to rule
on for the two parked Phase-2 items: **"identity manifest / named personas"** and **"2nd
chat identity / multi-bot."**

This is a design document, not an implementation plan — nothing below has been reviewed or
approved by the operator yet.

---

# ORDERLY Named Persistent Agents Specification

## 1. Agent definition record and on-disk layout

### 1.1 Ownership and authority

The canonical identity manifest SHALL be owned by `orderly-gateway.service`, running as the operator's own host account, at:

`~/.openclaw/orderly/identity-manifest.json`

Per-agent state SHALL live beneath:

`~/.openclaw/orderly/agents/<agent-id>/`

The gateway is the correct owner because it already creates and controls the Docker-sandboxed chat agents and their isolated workspaces; `orderly-web` SHALL receive only a sanitized presentation view and SHALL have no filesystem access to the manifest.

**Choice and tradeoff:** ORDERLY will keep the manifest in the existing trusted gateway control plane rather than introduce a new registry service, accepting that the gateway's own host account remains the host-level trust root in exchange for avoiding another service identity and another control channel.

The manifest and agent directories SHALL be inaccessible to `orderly-web` and `orderly-broker`. The existing mount-namespace protection of `orderly-calendar.service` SHALL continue to hide this part of the operator's home even though calendar and gateway use the same raw Linux user.

### 1.2 Canonical agent schema

Each agent record SHALL contain:

| Field | Meaning |
|---|---|
| `id` | Immutable, opaque identity used for storage, transcripts, routing, and audit. |
| `name` | Operator-facing display name; renaming this does not change identity. |
| `handle` | Unique, case-insensitive addressing name used for mentions and desk routes. |
| `path` | Stable desk route of the form `/agents/<handle>`; old handles remain reserved after a rename so they cannot be reassigned to another identity. |
| `description` | Operator-authored statement of purpose. |
| `avatarRef` | Reference to local, agent-scoped media; remote avatar URLs are not allowed. |
| `createdAt`, `updatedAt` | Host-generated timestamps. |
| `lifecycle` | One of pending verification, active, suspended, or retired. |
| `agentClass` | Reserved system agent or operator-created named agent. |
| `runtimeProfile` | Approved sandbox profile, not an arbitrary image or runtime configuration. |
| `memoryPolicy` | Persistent or memoryless. |
| `canonicalConversationId` | The agent's persistent desk thread identifier. |
| `policyRef` and `policyRevision` | Reference to host-managed standing orders supplied read-only to the sandbox. |
| `capabilityBindings` | Non-secret references to approved typed capabilities; never credential values or credential-store paths. |
| `delegationAllowlist` | Identities this agent may ask to perform bounded work. |
| `channelBindings` | Presentation routes such as the web desk and current Telegram bot; bot tokens are not part of the record. |
| `isGroup` | Always false in v1. |
| `memberIds` | Always empty in v1. |
| `systemLocked` | Prevents modification of security-defining fields for coordinator, mail, and researcher. |

A named identity owns its name, description, avatar, conversation namespace, memory namespace, standing orders, runtime profile, delegation policy, and lifecycle. It explicitly does **not** own provider credentials, Telegram tokens, systemd service identities, or another agent's memory.

Schedules are not part of the agent record. If scheduling is designed later, it SHALL be a separate host-owned declaration referring to immutable `agentId` values; this feature does not add a scheduler or move the coordinator's reminder file.

### 1.3 Per-agent layout

Each agent directory SHALL contain the following logical layout:

- `profile.json` — a read-only, non-authoritative projection of that agent's manifest record for its sandbox.
- `standing-orders.md` — host-managed instructions, mounted read-only.
- `memory/MEMORY.md` — curated long-term memory, present only for persistent agents.
- `memory/notes/` — dated notes following the coordinator's existing convention, present only for persistent agents.
- `conversations/transcripts.sqlite` — the gateway-owned transcript store for that agent.
- `media/` — local uploads and avatar media scoped by agent ID.
- `audit/` — identity-management, routing, delegation, and capability-use events.

No credential file, token, keyring, provider environment file, or credential-store symlink may appear anywhere under this tree.

The agent sandbox SHALL never receive the whole manifest or the parent agents directory. It receives only its read-only profile and standing orders, its own writable memory when permitted, and approved capability endpoints.

**Choice and tradeoff:** transcripts and media will be stored per agent rather than in one shared conversation database, accepting additional files and migration work in exchange for clearer identity boundaries and simpler negative-access probes.

---

## 2. Named-agent-to-identity-split mapping

### 2.1 Default class for newly created agents

Every operator-created named agent SHALL receive a distinct Docker sandbox instantiated from a new approved `named-isolated` profile. This profile copies the coordinator's **security shape**, not the coordinator's actual container or workspace:

- No direct network egress.
- No credential mounts.
- No access to the coordinator's memory or reminder file.
- No access to mail or calendar credential stores.
- No access to other named-agent directories.
- Its own writable memory mount only if its memory policy is persistent.
- Host-managed standing orders mounted read-only.
- Ephemeral scratch space that is discarded independently of long-term memory.

A new named agent therefore does not "reuse coordinator." It receives a separate identity with the same least-privilege baseline.

**Choice and tradeoff:** each named agent gets a separate sandbox rather than multiplexing several names inside one coordinator process, accepting higher local resource use in exchange for probeable memory, mount, and runtime separation.

The existing `mail` and `researcher` runtime profiles SHALL remain reserved and cannot be selected when creating a named agent:

- The Google credential-bearing mail profile remains a singleton capability identity.
- The guarded-proxy researcher profile remains a singleton memoryless capability identity.
- Naming a new agent "Mail," "Research," or similar does not grant either profile.

### 2.2 Access to existing capabilities

A named agent needing email or web research SHALL delegate a bounded request to the existing mail or researcher agent, subject to an explicit delegation allowlist. The delegated identity runs in its existing sandbox and returns only its result.

This does not create a shared credential pool: the Google credential remains mounted only in the mail sandbox, just as it is today. The named agent receives returned text, not a token, credential-store mount, generic Google API connection, or mail-agent filesystem access.

Delegation SHALL be disabled by default. Adding mail or researcher delegation is a privilege change shown in the operator confirmation digest.

The coordinator remains the only owner of the reminder file. Named agents may ask the coordinator to perform an allowed reminder operation, but they do not receive that file or a writable mount to it.

### 2.3 New credentials and connector identities

Base named-agent creation SHALL NOT provision or accept new credentials. A request such as "let this project agent use my project tracker" is a separate connector-boundary proposal requiring an explicit operator ruling.

If approved, the required model is one dedicated credential-bearing connector identity per connector credential:

- A new, connector-specific Linux service user and group.
- A dedicated service such as `orderly-connector-<connector-id>.service`.
- A credential store under `/var/lib/orderly-connectors/<connector-id>/credentials/`, readable only by that connector service.
- Provider egress restricted to the connector's required endpoint.
- A socket at `/var/lib/orderly-connectors/<connector-id>/connector.sock`.
- A narrow set of typed verbs; no generic HTTP request, shell, file-read, token-export, or arbitrary provider method.
- A unique socket access group granted only inside the designated named-agent sandbox.
- No membership of the operator's own account, `orderly-web`, `orderly-broker`, or the connector service in the Docker group because of this feature.
- No credential or credential directory mounted into the named-agent container.

The connector socket, not the credential, is mounted into the designated sandbox. Other named agents may not receive the same socket. If several agents need the same external account, they must delegate to one designated capability-owning identity or use separately issued credentials; ORDERLY will not mount one credential-backed connector into multiple agent identities.

**Choice and tradeoff:** new integrations will use one typed helper identity per credential rather than a generic multi-credential connector daemon, accepting more services and administrative overhead in exchange for avoiding a shared keyring and limiting compromise to one connector.

This connector model would move one current boundary: the mail agent would no longer be the only identity with provider egress, because the new helper would have endpoint-scoped egress and a new credential. That boundary move is **not approved by the base named-agent feature** and requires a standalone operator ruling identifying the service identity, credential, endpoints, verbs, target agent, and negative-access probes.

If the operator declines that boundary move, named agents remain zero-credential and use only the already-approved mail, researcher, coordinator, and calendar typed-capability paths.

### 2.4 Required verification

A named agent SHALL not become active until live probes establish, from inside its actual container:

- No direct network reachability.
- No visibility of any credential store.
- No visibility of another agent's memory or transcript store.
- Successful writes only to its own memory, when persistent.
- No persistent writes for a memoryless profile.
- Inability to modify standing orders or its profile.
- Visibility only of explicitly approved typed sockets.

A new connector requires additional probes showing that unrelated agents, `orderly-web`, `orderly-broker`, and the fixed agents cannot reach its socket or read its store. Configuration alone is not evidence.

---

## 3. Chat addressing

### 3.1 Web desk routing

The web desk SHALL display one persistent sidebar entry per active named agent. Each entry routes to the immutable agent ID and its canonical conversation ID; display names and handles are presentation data, not routing authority.

`orderly-web` SHALL obtain a sanitized list containing only names, handles, descriptions, avatars, lifecycle, and non-secret capability labels. It SHALL not read the manifest or per-agent directories directly.

Inbound desk messages SHALL continue through the existing web-to-gateway chat path. They SHALL not pass through `orderly-broker`, the coding lanes, or the calendar socket unless the operator invokes an existing calendar typed verb for its intended purpose.

### 3.2 Telegram routing

The current Telegram bot remains a single channel identity. The operator may select an active named agent through the bot's agent selector or address an agent by its unique handle. The gateway maintains the route for the operator's one allowed Telegram account, and responses are visibly labeled with the selected agent.

Because Telegram presents one chat rather than a true sidebar of independent threads, the web desk remains the clearest view of separate conversations. Telegram messages routed to an agent still enter that agent's canonical conversation and appear in its web transcript.

No second Telegram token is introduced by this design.

### 3.3 Mention semantics

Mentioning agent B from agent A's thread SHALL mean a bounded consultation, not memory injection:

1. B receives the text addressed to B plus only the context the operator explicitly included.
2. B executes in B's own sandbox using B's own memory and capabilities.
3. B returns a labeled response.
4. The returned response is recorded in A's transcript, while B's request and response are recorded in B's transcript.
5. B's memory files, standing orders, transcript history, and hidden context are never copied into A's context.

The interface SHALL show that information is crossing from B to A. A mention typed by the operator constitutes authorization for that specific transfer; an agent-initiated consultation requires either an existing delegation allowlist or a fresh operator confirmation.

**Choice and tradeoff:** mentions use explicit request-and-response delegation rather than Grok Bot–style context injection, accepting less seamless collaboration in exchange for preventing one agent's private memory from silently becoming another agent's context.

### 3.4 Group agents

Group agents and shared turn-taking sessions are deferred from v1. The schema reserves `isGroup` and `memberIds` only so the format need not be broken later; the gateway SHALL reject an active group definition.

A shared group session would collapse transcript, memory, and capability outputs into one context and make it unclear which identity authorized or retained each item.

**Choice and tradeoff:** v1 supports explicit consultations between separate agents instead of shared group sessions, declining convenient multi-agent conversation in order to preserve auditable identity and information-flow boundaries.

### 3.5 Second Telegram identity status

This design treats named agents as roles and Telegram bots as channel faces. A future bot may be bound to one named agent, but the bot token remains a channel credential rather than an agent credential.

The "second Telegram identity / multi-bot" backlog item is therefore only **partially resolved**:

- The role-versus-face distinction is resolved by this model.
- The operator must still rule whether a second bot is genuinely wanted.
- The installed OpenClaw version must still be validated for independent bot routing.
- Token custody remains a separate boundary decision.

Giving a second token to `orderly-gateway.service` would give an existing service identity a new credential and is not approved here. The alternative would be a dedicated Telegram ingress identity holding only that bot token and relaying typed chat events to the gateway, which likewise requires a standalone operator ruling.

---

## 4. Persistence and memory model

### 4.1 Persistent named agents

A standard named agent receives:

- One canonical conversation transcript owned and written by the gateway.
- Its own `MEMORY.md`.
- Its own dated-notes directory.
- Its own media namespace.
- Its own read-only standing orders.

The agent may read and write only its memory directory. It does not write its transcript database directly; the gateway records accepted inbound messages, agent responses, mention transfers, and capability results.

The coordinator's existing memory convention SHALL be reused because it is already understood and probeable. No shared memory index or cross-agent semantic store is introduced.

**Choice and tradeoff:** ORDERLY will use the existing Markdown memory convention instead of a host-wide vector or knowledge database, accepting weaker global search in exchange for human inspectability and straightforward per-agent mount isolation.

### 4.2 Memoryless identities

Mail and researcher remain memoryless even though they appear in the manifest and desk:

- No persistent writable filesystem is mounted into their sandboxes.
- Their previous transcript is not reinjected on a later invocation.
- Gateway-side transcripts may be retained for the operator's audit and display, but the agent cannot write to or use them as cross-invocation memory.
- Untrusted email and web content cannot directly create or modify a memory file.

An operator-created agent may also be created as memoryless, using the zero-credential named sandbox profile. A memoryless identity cannot later be converted in place to persistent, because that could cause previously untrusted or stateless content to acquire durable context; the operator must create a new persistent identity and explicitly transfer any desired material.

### 4.3 Information arriving from capability agents

Mail, research, or connector output entering a persistent named-agent thread is recorded as attributed external output. The capability agent cannot directly write the named agent's memory.

The persistent agent may summarize information into its own memory under its normal policy, but the provenance remains visible in the transcript. A mention or delegation never grants the called identity a mount to the caller's memory.

### 4.4 Retirement and retention

Retirement SHALL:

- Disable new routing and autonomous invocations.
- Stop the associated sandbox.
- Preserve the manifest record, transcript, memory, and audit history read-only.
- Keep the handle reserved.
- Leave credential revocation or connector retirement as a separate confirmed action.

Retirement is not deletion. This avoids silently erasing operational history or leaving a credential active merely because its presentation identity was removed.

---

## 5. Creation and management UX on the desk

### 5.1 Management surface

The web desk SHALL contain an operator-only "Agents" management view with:

- List and inspect.
- Create.
- Rename display name or handle.
- Edit description and local avatar.
- Suspend or resume.
- Retire.
- Review memory and transcript ownership.
- Review delegation and typed-capability bindings.

The view SHALL not include credential text fields, arbitrary environment variables, filesystem paths, Docker images, network settings, shell input, or generic plugin toggles.

`orderly-web` submits bounded management requests over the existing authenticated gateway path. It does not receive a writable mount, Docker access, credential access, or a generic gateway administration interface.

### 5.2 Creation confirmation

Creating an agent is a durable identity operation and requires a confirmation digest even when no credential is involved. The digest SHALL show:

- Name and handle.
- Persistent or memoryless policy.
- Runtime profile.
- Network: none.
- Credentials: none.
- Writable storage: only the proposed agent memory, or none.
- Delegation targets: none by default.
- Typed capabilities: none by default.
- Expected local storage location.
- The fact that a separate Docker sandbox will be created.
- The probes that must pass before activation.

The first confirmation creates a pending identity. Activation occurs only after the instance-specific probes pass and the operator receives their summarized result.

### 5.3 Privilege changes

Adding mail delegation, research delegation, or another typed capability requires a separate digest describing:

- Which identity will perform the action.
- What information can flow to it.
- What information can return.
- Whether returned content enters persistent transcript or memory-bearing context.
- The exact allowed operation class.
- Whether any network or credential boundary changes.

A proposed new credential-bearing connector receives its own boundary digest and cannot be approved as part of an ordinary agent-creation confirmation. Credential material SHALL be provisioned locally into the dedicated connector store, never entered into or relayed through `orderly-web`.

### 5.4 Rename and retirement behavior

Renaming the display name is cosmetic but audited. Changing the addressing handle requires confirmation because it changes how inbound messages route; the old handle remains a reserved alias or tombstone and cannot be assigned to a different agent.

Retirement requires a digest listing retained memory, active routes, delegation bindings, and any separately managed connector identity. The desk SHALL not imply that retiring an agent revokes an external credential unless the connector has also been independently disabled and probed.

Local avatar uploads are allowed. Remote avatar URLs are rejected to avoid introducing background fetches, tracking requests, or new egress.

---

## 6. Migration path from the fixed trio

### 6.1 Treatment of coordinator, mail, and researcher

Coordinator, mail, and researcher SHALL become the first three records in the identity manifest, but remain `systemLocked` identities rather than ordinary user-created templates.

Their existing boundaries remain exact:

- **Coordinator:** persistent memory, reminder-file ownership, zero direct egress, no provider credential.
- **Mail:** memoryless, sole owner of the existing Google-scoped credential store, Google-only egress.
- **Researcher:** memoryless, no credential, web access only through the existing guarded gateway proxy.

Their names and presentation may be shown in the same desk as named agents, but their security-defining fields cannot be edited through the desk.

**Choice and tradeoff:** the fixed trio will enter the common manifest rather than remain in a parallel legacy registry, accepting migration and compatibility work in exchange for making the manifest genuinely authoritative instead of another duplicated identity list.

### 6.2 `config/agents/`

`config/agents/` SHALL remain the version-controlled source for approved role policy and sandbox security profiles. It SHALL not become a store for per-host dynamic identities, memory, transcripts, or credentials.

The manifest references approved profile names from `config/agents/`:

- Existing profiles remain reserved for coordinator, mail, and researcher.
- A new generic zero-egress, zero-credential profile supports operator-created named agents.
- Dynamic names, avatars, routes, memory, and lifecycle remain under the gateway-owned host path and are not committed to the public repository.
- No profile may name arbitrary host mounts or credential paths supplied from the desk.

### 6.3 `DESKS`

`DESKS` SHALL cease to be an independent source of identity names or routing decisions. It becomes a presentation/routing projection keyed by immutable manifest agent IDs.

Any current coordinator, mail, or researcher desk entries map to their manifest records. Names, descriptions, avatars, and active status come from the manifest so that identity is not separately declared in OpenClaw configuration, desk presentation, and route wiring.

`DESKS` contains no credentials and conveys no additional capability.

### 6.4 systemd services

The base named-agent feature requires no new systemd service and no identity changes:

- `orderly-gateway.service` remains the operator's own host account and runs the additional approved sandboxes.
- `orderly-web.service` remains credential-free, Docker-free, and unable to read gateway files.
- `orderly-broker.service` remains Docker-free and uninvolved.
- `orderly-calendar.service` retains its mount namespace and exactly two typed verbs.
- The mail agent remains the only credential-bearing chat agent and the only direct-egress agent.

A connector helper or second Telegram ingress would add a service identity and credential and is therefore outside this unchanged base. Either requires its own explicit operator ruling and probe record.

### 6.5 Backlog disposition and operator rulings

**Identity manifest:** This specification **resolves the design question**, subject to the operator approving the recommended ownership model. Identity owns presentation, routing, memory, conversation, lifecycle, runtime profile, and capability references; credentials remain owned by separate capability identities.

**Second Telegram identity / multi-bot:** This specification **partially resolves** the item by defining bots as channel faces rather than named-agent roles. It remains deferred pending the operator's desire for a second face, installed-version validation, and a separate ruling on custody of the new bot token.

The concrete rulings presented to the operator are:

1. Approve the gateway-owned manifest and separate zero-credential sandbox per named agent.
2. Approve explicit request-and-response mention semantics instead of context injection.
3. Keep group agents deferred.
4. Keep base named-agent creation credential-free.
5. If a new external connector is later wanted, rule separately on the new credential identity and the loss of the "mail is the only egress identity" property.
6. If a second Telegram bot is wanted, rule separately on its channel identity and token custody.

---

## 7. Explicit anti-goals

The named persistent agents feature SHALL NOT:

- [ ] Create a shared credential pool, shared keyring, account-wide token, or Grok Bot–style runtime allow/block gate standing in for identity separation.
- [ ] Mount the coordinator, mail, researcher, calendar, gateway, or another named agent's credential store into a new agent.
- [ ] Clone the mail profile or reuse its Google credential for a newly named identity.
- [ ] Give a newly created named agent direct network egress by default.
- [ ] Give `orderly-web` a provider credential, calendar credential, Docker access, manifest mount, credential-store path, or permission to read the gateway token file.
- [ ] Give `orderly-broker` a credential, Docker or container-engine group membership, named-agent dispatch role, or access to agent memory.
- [ ] Give any new identity a credential or Docker-group membership as a side effect of base named-agent creation; a dedicated connector or Telegram ingress is a separately ruled boundary change, not part of automatic creation.
- [ ] Change the calendar helper's two typed verbs, expose its credential store, or add a delete verb.
- [ ] Route named-agent chat, research, mail, reminders, or connector actions through the broker's codex/kimi/cursor coding-lane machinery without an explicit separate scope decision.
- [ ] Treat disposable broker lanes as the compute substrate for named persistent agents.
- [ ] Provision a remote cloud VM per agent; named agents run in separate local Docker sandboxes on the operator's station.
- [ ] Allow direct injection of one agent's memory or full transcript into another agent's context.
- [ ] Put multiple agents into one shared turn-taking session in v1.
- [ ] Allow arbitrary Docker images, host mounts, environment variables, plugins, network destinations, or shell operations from the desk.
- [ ] Move or share the coordinator's reminder file.
- [ ] Turn mail or researcher into memory-bearing identities merely because they acquire desk names.
- [ ] Introduce multi-tenant, team, or multi-user semantics; all named agents serve the operator alone.
- [ ] Treat a Telegram bot token as an agent credential or silently add a second token to the gateway.
- [ ] Expand into mascot, theme-variant, or cosmetic persona work; that remains a separate parked backlog item layered on top of the identity manifest.
- [ ] Claim a boundary from configuration alone: network, credential visibility, mount isolation, memory behavior, and standing-order immutability must be probed from the live identities before activation.

---

## OPERATOR RULING — 2026-08-21 — chat surfaces

The operator's direction on §3 (addressing) and the open "second Telegram identity" item:

1. **Named-agent chats are hosted natively in the main web UI.** Each named agent gets a
   first-class chat thread on the desk. This is the default and always-present surface.
2. **Telegram is an OPTIONAL per-agent attachment.** An operator who wants to be contactable
   by a given agent through Telegram may attach a bot identity to that agent. Each attachment
   is its own bot token, custodied per the identity split (its own connector boundary, ruled
   at attach time per §7's per-connector path). Not attached by default; base agent creation
   remains credential-free by construction.

This closes the "is a second bot wanted" question as: optional, per-agent, operator's choice —
build the attachment seam, don't presuppose the bot. Token custody and version-compatibility
details remain design work for the build milestone.
