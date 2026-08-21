# ORDERLY Notes — v1 Specification

## 1. THE BOUNDARY INVARIANT

**The note is the operator’s text. AI may read a deliberately supplied snapshot and may write only to a separate sidecar. It can never write into, autocomplete, continue, replace, correct, summarize in place, or reformat the note body.**

This applies to the body and any other human-authored text field, including the note title.

The boundary is enforced at every layer:

1. **Separate authority.** The note editor alone has note-write authority. An assistance run receives one immutable note revision and a write capability scoped only to sidecar records. No agent, model, prompt, or assistance worker receives a note-mutation tool, credential, filesystem mount, or network route.

2. **Separate stores.** Human text and AI output are different record types in different storage namespaces. A sidecar record cannot contain a note-body replacement, patch, insertion range, cursor position, or formatting operation.

3. **One-way handoff.** Running an assist copies the selected note revision into that run’s input. The model cannot retrieve another revision, browse other notes, or write anything back unless a separately scoped assist explicitly permits that read.

4. **No editor integration.** There is no AI autocomplete, ghost text, selection toolbar, rewrite command, grammar correction, smart formatting, or generated text inside the editor surface.

5. **No transfer control.** Sidecar cards have no Apply, Insert, Replace, Accept into note, or drag-to-editor action. ORDERLY never routes generated prose into the note. A deliberate operator copy-and-paste remains an operator edit, not an authority granted to AI.

6. **Inert rendering.** Model output renders outside the editor as data, never markup or commands. URLs are parsed and safely offered under the front door’s existing link law; malformed or non-HTTP addresses remain inert text.

7. **Revision proof.** Every assist run records the note revision and content fingerprint it read. Completing, failing, promoting, dismissing, or deleting an assist must leave the note revision and body fingerprint unchanged.

8. **Staleness, not silent refresh.** Editing a note marks existing assistance as based on an older revision. AI does not regenerate automatically or reinterpret the edit.

9. **Explicit exposure.** Before a run, the surface states that the selected revision will be sent to the configured model provider. Enabling an assist does not itself send anything.

10. **A structural claim, not a prompt promise.** Prompts also instruct the model not to rewrite the note, but the boundary does not depend on obedience. A malicious or malformed response still has nowhere to write except its sidecar card.

ORDERLY supplies no AI writing aid inside the note editor and requests browser autocomplete and autocorrect remain off. Writing aids independently enabled at the operating-system level are outside the station’s authority and must not be represented as ORDERLY behavior.

## 2. ASSISTANCE CATALOG

On a wide surface, assistance renders in a clearly labelled rail to the **right** of the note. On a narrow surface, it occupies a separate **Sidecar** panel reached beside the editor—not between paragraphs, over a selection, or inside the body.

### 2.1 V1

| Assist | Purpose | Rendering |
|---|---|---|
| **Orientation summary** | A short account of what the current note says, useful when returning to it. It does not rewrite, improve, or judge the prose. | First card in the sidecar rail, aligned with the top of the note. It carries its source revision, generation time, model, and stale state. |

One assist is enough for v1. It proves the boundary, permission posture, versioning, and sidecar interaction without introducing web access or cross-note retrieval.

### 2.2 Later, each as a separate capability decision

| Assist | Purpose | Rendering |
|---|---|---|
| **Useful links** | Research links relevant to the note, with a short reason each may be useful. Requires an explicit web-research expansion and treats fetched pages as untrusted text. | A Links card beneath the summary; never linked from words inside the note. |
| **Related notes** | Finds potentially relevant notes without merging or modifying them. Requires a separate grant to read the Notes corpus. | A Related notes card in the sidecar, with title, reason, and source revision. |
| **Possible dates and actions** | Surfaces language that may describe a date, commitment, or next step. It creates nothing and schedules nothing. | A clearly qualified “Possible” card low in the rail, visually distinct from real reminders or calendar proposals. |
| **Questions and tensions** | Points out unresolved questions, contradictions, or missing context for the operator to consider. | A Questions card beneath factual assists. |
| **Station context** | Offers relevant mail, calendar, or reminder items where the operator has enabled that source. Accounts and origins remain separate. | Its own labelled Context band at the bottom of the sidecar, never blended into note-derived output. |
| **Metadata suggestions** | Suggests titles or tags without changing either. | A metadata card above the other assists. Acceptance may change metadata only; it can never touch the body. |

No later assist inherits another assist’s authority. Enabling Summary does not enable web research, corpus search, mail access, calendar access, or action-taking.

## 3. SIDECAR DATA MODEL

### 3.1 Human record

A note contains:

- Stable note identity.
- Human-authored title.
- Human-authored plain-text body, preserving the operator’s line breaks.
- Monotonic note revision.
- Created and last-edited times.
- Operator-controlled archive or deletion state.

The note record contains no generated summary, embedding, inferred tag, model annotation, or hidden prompt material.

### 3.2 Capability grant

Each assist has an independent grant recording:

- Assist type and definition version.
- Scope: in v1, one named assist on one named note.
- State: disabled or enabled.
- When the operator enabled or disabled it.
- What input the assist may read.
- Whether it may use the configured model, external research, other notes, or station connectors.

Every assist begins **disabled**. New notes inherit no grants. V1 has no Enable all control.

Enabling permits the assist to be offered; it does not run it. Each model call still requires an explicit **Run on this revision** action.

### 3.3 Generated artifact

Each run creates a separate, immutable sidecar artifact containing:

- Artifact identity and assist type.
- Note identity and exact source revision.
- Input fingerprint.
- Assist-definition and prompt versions.
- Provider and model identity.
- Generation time and terminal state.
- Typed output appropriate to the assist.
- Sources, where applicable.
- Failure or partial-result information.
- Operator disposition: candidate, promoted, dismissed, superseded, or deleted.
- Stale state when the note has since changed.

The artifact schema has no note mutation field. Generated output is not silently reused as input to later runs; each run starts from the human note revision and the explicitly permitted sources.

### 3.4 Version and promotion law

- A rerun creates a new candidate; it never overwrites an earlier artifact.
- **Promote** means “keep this version as the displayed sidecar result.” It does not copy anything into the note, coordinator memory, or another system.
- Promoting a new version supersedes the prior promoted version but preserves its provenance until the operator deletes it.
- Editing the note marks prior artifacts stale. It does not discard or refresh them.
- Disabling an assist prevents further runs. It does not silently delete retained artifacts.
- Deletion is explicit and applies only to the selected sidecar artifact or assist history.

## 4. V1 SLICE

A single front-door build lane ships:

1. A station-held Notes surface with a note list and the ability to create, open, rename, edit, archive, and delete notes.
2. A plain-text body editor that autosaves operator edits as note revisions.
3. A permanently separate sidecar rail.
4. One installed assist: **Orientation summary**, disabled on every note by default.
5. An explicit sequence: **Enable Summary → Run on this revision → Promote or Dismiss**.
6. A plain statement naming the configured provider before note text is sent.
7. Summary cards carrying source revision, model, generation time, and current/stale status.
8. Immutable sidecar versions; rerunning does not replace a promoted result without operator promotion.
9. Safe, inert output rendering with no path back into the editor.
10. Boundary acceptance checks proving that successful, failed, malformed, and adversarial assist runs cannot change the note body or revision.

V1 does **not** include web research, related-note indexing, embeddings, connector access, automatic refresh, bulk enablement, imports, collaboration, or note-to-agent memory.

## 5. ANTI-GOALS

Notes must never become:

1. **A collaborative AI editor.** No co-writing, autocomplete, rewrite, tone adjustment, cleanup, or generated formatting in the body.
2. **A disguised chat transcript.** The note remains a quiet writing surface, not a conversation with a model.
3. **An ambient agent memory.** Notes are not loaded into coordinator context, indexed for every agent, or treated as standing instructions.
4. **An automation launchpad.** Dates and actions found in notes do not schedule, send, file, or modify anything without a separate proposal and existing operator approval law.
5. **A background model feed.** No automatic summarization, silent refresh, speculative indexing, or hidden model spend.
6. **An AI-organized knowledge base by default.** Cross-note search, inferred structure, and embeddings are separate capability expansions, not natural consequences of creating a note.
7. **A source of forged truth.** Sidecar output remains attributed model assistance, never part of the human record and never presented as something the operator wrote.
8. **A multi-user document product.** This remains one operator’s surface on one station.

## 6. OPERATOR QUESTIONS

1. Are these notes primarily a scratchpad, a durable personal reference, or a journal? Which use should set v1’s tone and density?
2. Should every model call always require a deliberate Run, or may an enabled assist eventually refresh after edits?
3. Is a promoted sidecar result meant to be a durable artifact, or only a convenient result until the next visit?
4. Should later related-item assistance remain inside the Notes corpus, or may it deliberately cross into mail, calendar, and reminders?
5. Is deliberate operator copy-and-paste from a sidecar into the note acceptable, or should the surface actively discourage AI-derived prose from entering the human record?