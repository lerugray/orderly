# ORDERLY v0.4 — per-agent connectors specification

> **RATIFIED AS BUILD DIRECTION 2026-08-21.** Authored from
> `DIRECTION-V04-CONNECTORS-2026-08-21.md` after the operator explicitly authorized the
> connectors spec to be written before implementation. This document is the
> acceptance-criteria-bearing design for the v0.4 connector framework.

**Status:** ratified \
**Scope:** external-service capability boundaries and their attachment to agents \
**Normative terms:** SHALL, SHALL NOT, SHOULD, and MAY are binding in their usual sense.

The connector framework makes an external account available to one designated agent
without putting that account's credential, a general network path, or a shared keyring in
the agent sandbox. A connector is a separately installed capability identity. It is not a
plugin toggle and it is not part of the agent's identity record.

## 1. Connector identity and boundary

### 1.1 Unit of isolation

1. One connector instance SHALL represent exactly one provider, one external account or
   service account, one reviewed scope set, and one credential store.
2. Every instance SHALL have its own connector identifier, Linux service identity, systemd
   unit, credential store, Unix socket, audit stream, and endpoint allowlist.
3. A connector service SHALL read only its own credential store. There SHALL be no daemon
   that can select among several credentials and no station-wide connector keyring.
4. A credential value, refresh token, private key, cookie, or credential-store path SHALL
   never appear in `openclaw.json`, the identity manifest, an agent profile, a browser
   response, a model prompt, a transcript, or an audit detail.
5. The service process SHALL be the only component with provider egress. The attached
   agent receives a typed socket, not provider network access.
6. `orderly-web`, `orderly-broker`, the gateway, and the agent SHALL NOT gain Docker-group
   membership, generic shell authority, or direct read access to the connector store.
7. A connector identifier is permanent. Retiring an instance reserves the identifier and
   cannot cause a later credential to inherit an old attachment.

### 1.2 One attachment owner

1. A credential-backed connector socket SHALL be attached to at most one capability-owning
   agent at a time.
2. If several agents need the same account, the operator SHALL either designate one owner
   and use typed delegation, or provision separately issued credentials in separate
   connector instances.
3. Ordinary named-agent creation SHALL remain credential-free and connector-free.
4. Attaching a connector SHALL be a separate confirmed ruling and SHALL NOT be implied by
   an agent name, purpose, model, channel, or prior delegation relationship.
5. Suspending or retiring an agent SHALL make its attachments unavailable, but SHALL NOT
   claim to revoke the external credential. Detach, disable, and credential revocation are
   distinct operator actions.

### 1.3 Definition versus installation

1. The compiled connector catalog SHALL describe known connector *kinds*: labels,
   capability classes, operation identifiers, approval posture, and expected provider
   endpoints. It SHALL contain no credentials and confer no authority.
2. An installed instance SHALL be a host-owned record referring to a compiled kind and
   non-secret operational identity. Browser requests SHALL NOT create installed instances,
   choose service users, set paths, name endpoints, or provide environment variables.
3. An installed instance SHALL begin `pending`. It becomes `active` only after its
   instance-specific service, socket, credential-scope, egress, and negative-access probes
   have passed.
4. Catalog presence, a pending record, or an attachment request SHALL never be displayed as
   a working integration.

## 2. Typed operation contract

### 2.1 Transport

1. Connector calls SHALL use HTTP over a Unix socket with a versioned JSON envelope.
2. The request envelope SHALL contain only `v`, `operation`, `requestId`, and an
   operation-specific `input` object.
3. The caller SHALL NOT supply a command, argv, executable, filesystem path, URL, host,
   HTTP method, header, credential reference, model string, or environment variable.
4. Unknown envelope or input fields SHALL be refused and named rather than ignored.
5. Inputs SHALL be size-bounded. Responses and audit details SHALL be size-bounded and
   redact provider secrets and raw authentication material.
6. A connector service MAY invoke a provider CLI only through `execFile` with fixed
   executable and fixed argument construction. It SHALL NOT invoke a shell.

### 2.2 Operation classes

1. Every compiled operation SHALL be classified as one of:
   - `read`: retrieve external data without changing it;
   - `propose`: validate and normalize a requested external change into an approval item;
   - `apply`: perform an already approved, digest-bound change; or
   - `local`: inspect connector health or non-secret metadata without provider action.
2. An agent-visible socket SHALL expose only the exact `read`, `propose`, and `local`
   operations approved at attachment time.
3. An `apply` operation SHALL be reachable only from a separately authenticated host-side
   approval path. It SHALL never be mounted into an agent sandbox.
4. A connector kind need not have write operations. Read-only credentials and read-only
   kinds are first-class.
5. Delete, send, transfer, publish, refund, charge, invite, permission-change, and other
   high-impact verbs SHALL be absent unless a later connector-specific specification adds
   them behind an explicit default-off capability gate.
6. Provider text returned by a connector is untrusted data. It SHALL be attributed to the
   connector and SHALL NOT be promoted to standing instructions or durable preferences.

### 2.3 Approval and replay

1. A proposed write SHALL produce a normalized payload and digest naming connector
   instance, target account label, operation, material fields, and expiry.
2. Approval SHALL bind to that digest. Editing a proposal SHALL create a new digest and
   require a new approval.
3. Apply requests SHALL be idempotent by `requestId` and persisted before the external
   call where the provider operation cannot safely be repeated.
4. A provider failure SHALL remain a failure or pending proposal; it SHALL NOT be recorded
   as approved-and-applied.
5. Provider output and model prose SHALL never outrank the connector's own terminal record.

## 3. Attachment model and desk surface

### 3.1 Authoritative attachment record

1. Attachments SHALL live in a host-owned connector control record, separate from both
   credentials and agent-writable state.
2. An attachment SHALL name only connector id, agent id, approved operation identifiers,
   lifecycle, confirmation digest, probe revision, and timestamps.
3. The named-agent manifest MAY project non-secret capability references, but credentials,
   store paths, socket host paths, and provider tokens SHALL remain outside it.
4. The control record SHALL be written through a typed envelope, exact changed-path
   allowlist, invariants, confirmation digest, serialized atomic write, backup, fsync, and
   rename.
5. Unknown agents, connector kinds, connector instances, operation identifiers, or fields
   SHALL be refused.

### 3.2 Attach confirmation

The operator confirmation SHALL show:

1. the agent identity;
2. connector label, kind, and non-secret account label;
3. exact operation identifiers and read/propose/apply classification;
4. whether returned data enters a persistent agent's transcript or memory-bearing context;
5. the provider endpoints the service may reach;
6. the fact that the credential remains in a separate host service; and
7. the probes required before activation.

The browser submits the digest it was shown. A stale digest SHALL be refused.

### 3.3 Management surface

1. The Agents desk SHALL show available, pending, active, suspended, and retired connector
   instances using sanitized labels only.
2. It SHALL support propose-attach, confirm-attach, suspend, resume, and detach.
3. It SHALL not include credential fields, OAuth redirects, API keys, cookie import,
   arbitrary scopes, URLs, socket paths, service users, environment variables, or shell.
4. Credential provisioning and revocation stay host-local and provider-specific.
5. The desk SHALL distinguish `installed`, `attached`, and `active`; none is a synonym for
   another.

## 4. Catalog and program scope

### 4.1 Initial catalog families

The v0.4 catalog SHALL be extensible and SHALL reserve stable kinds for the program's
known or likely integrations:

1. Existing precedents: Gmail read/draft, Google Calendar read, and approval-gated Google
   Calendar write.
2. Google Workspace: Drive, Docs, Sheets, Tasks, and Contacts/People.
3. Microsoft 365: Outlook Mail, Outlook Calendar read and approval writes, OneDrive,
   SharePoint, Excel workbooks, To Do, and Teams as separately reviewable kinds.
4. Files and knowledge: Dropbox, Box, Notion, and Airtable.
5. Projects and collaboration: Basecamp, GitHub, Linear, Asana, Trello, Slack, Discord,
   and Microsoft Teams.
6. Professional presence: LinkedIn authenticated-member profile, owned-post reads, and
   post proposals. An adapter SHALL document which LinkedIn product access is actually
   available; catalog presence does not imply access to restricted APIs.
7. Personal work: Todoist, generic IMAP read/draft, and generic CalDAV/CardDAV where a
   scoped service identity is available.
8. Business data: Stripe read-only reporting.

This list is a roadmap/catalog surface, not a claim that adapters or credentials ship in
v0.4. A kind is usable only when a separately reviewed adapter and live instance pass the
requirements in this specification.

### 4.2 Google Workspace ruling

1. “Google Workspace” SHALL NOT be one broad connector or one broad OAuth grant.
2. Drive, Docs, Sheets, Tasks, Contacts, Gmail, and Calendar SHALL be separately reviewable
   kinds and separately attachable capability sets.
3. An implementation MAY use one dedicated service account for tightly coupled operations
   such as reading a Drive file and rendering its Google Doc content only when the provider
   cannot express the useful operation otherwise, but the combined scope set and affected
   kinds MUST be explicit in the instance digest.
4. Gmail compose/send SHALL not be smuggled into a Drive/Docs/Sheets credential.
5. Domain-wide delegation is a distinct high-impact capability and is outside v0.4.

### 4.3 Adapter acceptance gate

Microsoft 365 follows the same separation ruling: a shared API origin does not make Mail,
Calendar, OneDrive, SharePoint, Excel, To Do, and Teams one connector or one scope set.
Each attached kind and any intentionally combined instance SHALL be explicit in the
review digest.

A new adapter SHALL document and test:

1. exact provider scopes and endpoints;
2. exact typed operations and schemas;
3. read/write classification and approval behavior;
4. secret redaction and bounded output;
5. credential rotation and revocation procedure;
6. idempotency/replay behavior for writes;
7. positive service/socket probes; and
8. negative probes from every unrelated agent, `orderly-web`, `orderly-broker`, and the
   fixed agent containers.

## 5. Runtime mounting and attribution

1. Attachment activation SHALL mount only the designated instance's agent socket into the
   designated sandbox at a derived, read-only parent location.
2. The host credential store SHALL not be mounted, even read-only.
3. Socket mount paths SHALL be derived from validated connector identifiers and SHALL not
   be accepted from the browser or model.
4. An agent's standing orders SHALL list the non-secret connector label and exact available
   operations. Prompt text SHALL not create an operation that is absent from the socket.
5. Every connector result entering a transcript SHALL carry connector id, operation,
   request id, time, and untrusted-data attribution.
6. Persistent agents may summarize connector results into their own memory under their
   normal rules; a connector cannot write memory directly.
7. Detach or suspension SHALL remove the runtime route before recording the attachment as
   inactive. A failure to remove the route SHALL fail closed and remain visible.

## 6. Migration and precedent

1. The calendar-write helper is the worked precedent: host-side credential, separate store,
   typed socket, approval flow, no agent mount, and no delete verb.
2. Existing mail and calendar behavior SHALL remain byte-for-byte unchanged during framework
   adoption. They MAY be represented as legacy catalog entries, but SHALL NOT be silently
   moved, rescoped, or recredentialed.
3. Existing `openclaw.json` files with no connector control record SHALL behave exactly as
   before. No file SHALL be created merely by reading settings or listing agents.
4. Existing named agents SHALL have zero attachments. Missing attachment state means none.
5. Migration SHALL not broaden network, tool, sandbox, Docker, channel, owner, or credential
   settings.
6. A later migration of a legacy connector into the framework requires its own scope diff,
   credential rotation plan, live probes, and rollback. Catalog projection alone is not a
   migration.

## 7. Verification

1. Unit tests SHALL cover schema refusal, unknown fields, path derivation, digest binding,
   stale confirmations, one-owner enforcement, lifecycle transitions, atomic persistence,
   sanitization, and migration from no state.
2. Contract tests SHALL show that unapproved and uncompiled operations never reach an
   adapter.
3. Live activation SHALL require probes from inside the relevant containers; configuration
   inspection is not sufficient evidence.
4. Full `web`, `broker`, and `calendar` suites SHALL remain green because connector state
   must not weaken shared configuration invariants.

## 8. Explicit anti-goals

V0.4 is not:

1. a shared OAuth wallet or generic multi-provider daemon;
2. a browser form for secrets, arbitrary scopes, endpoints, paths, commands, or plugins;
3. automatic connector discovery or model-authored attachment;
4. one credential mounted into several agents;
5. direct provider egress from an agent sandbox;
6. a generic HTTP proxy, shell, CLI bridge, MCP pass-through, or URL fetcher;
7. blanket Google Workspace or domain-wide authority;
8. automatic write authority because read access was approved;
9. send, delete, charge, refund, publish, merge, invite, or permission-change authority;
10. proof that a catalog entry has an adapter or that an installed service is healthy;
11. a replacement for typed delegation, the approval queue, or immutable standing orders;
12. a reason to weaken sandbox-all, elevated-off, host-terminal-off, or the no-shared-keyring
    policy.
