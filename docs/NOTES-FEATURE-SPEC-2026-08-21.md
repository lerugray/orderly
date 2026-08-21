# ORDERLY Notes Feature Specification

## 1. Core concept and the human/AI boundary

### 1.1 Product definition

Notes is a human-owned notepad with optional assistance beside it.

The authoritative note is the operator’s text. AI output is commentary about a saved version of that text; it is never part of the note document unless the operator deliberately copies and pastes it.

Notes must remain fully useful when AI assistance is disabled, unavailable, misconfigured, or failing.

### 1.2 Non-negotiable invariant

**No model or agent has a capability that can write to the note store.**

Enforce this structurally:

1. The note editor is the only normal path that submits new note text.
2. The note-writing component accepts operator editor saves, imports, and explicitly confirmed version restores. It does not accept analyzer output.
3. The assistance engine receives a copy of a saved note version. It receives no note-store write handle, filesystem mount, connector, tool access, or browser authority.
4. Validated assistance output is written only to the annotation store by a narrow host-side broker.
5. Annotation content is never included in the editor’s document model or save payload.
6. No “apply,” “rewrite,” “replace,” inline completion, or automatic insertion operation exists.
7. “Copy” places assistance on the clipboard. Only a subsequent operator paste or retyping changes the note.

An operator who pastes an AI summary into a note has consciously adopted that text. The system must not blur this distinction.

### 1.3 Visual separation

Use a two-part note view:

- **Main canvas:** the editable human note.
- **Assistance rail:** a visually bounded, read-only panel beside the note.

The rail must:

- Use a border/background distinction, not color alone.
- Label each model-derived section **AI-generated**.
- Show which saved version it describes and whether it is current or stale.
- Render output as inert text, never model-supplied markup.
- Be collapsible without affecting the editor.
- Move below the note or into an explicit drawer on narrow screens; it must never overlay or annotate the text.

Locally extracted links should be labeled **Extracted locally**, not AI-generated.

### 1.4 Scope of assistance

V1 assistance is **per note and per saved version**.

Per-selection assistance is deferred. Selection anchors become fragile after edits and encourage inline rewriting behavior. A later selection feature may still use the external rail, but must preserve the same no-write invariant.

---

## 2. Assistance catalog, ranked by value and cost

“Cost” includes model usage, latency, privacy exposure, false-positive risk, and implementation complexity.

| Rank | Assistance | Release | Rationale |
|---|---|---|---|
| 1 | Saved-version summary | **V1** | Highest general value and the clearest expression of “AI beside the note.” One concise summary helps with long meeting, research, and planning notes. Moderate model cost. |
| 2 | Link extraction | **V1** | Very low cost and high reliability because it can be deterministic and local. Extract Markdown links and bare HTTP(S) URLs, deduplicate them, and show their labels or nearby context. Do not fetch pages or titles. |
| 3 | Action-item extraction | **V1** | Useful for meeting and planning notes and can share the summary’s model pass. Items remain labeled suggestions; they do not become reminders, tasks, or calendar events. |
| 4 | Related-note surfacing | **Deferred** | Potentially useful only after a meaningful corpus exists. Start later with local keyword/title similarity, not embeddings or external indexing. Quality and information-density need evaluation first. |
| 5 | Backlink suggestions | **Deferred** | Requires a settled note-link syntax and suggests an editorial change to the human’s text. It is lower value until related-note quality is proven. Any future version may only offer a copyable link. |
| 6 | Stale-fact flags | **Deferred** | Expensive and unreliable. Verifying claims may require web access, temporal reasoning, and hostile external content. False confidence would be worse than no flag. |

### 2.1 V1 summary behavior

The summary should be compact by default: approximately one short paragraph or three to five bullets. It should describe the note rather than offer unsolicited advice.

It must not claim completeness or truth. The label should say that it is a generated summary of a particular saved version.

### 2.2 V1 action-item behavior

Each suggested action may contain:

- The action text.
- An apparent owner, only if explicitly stated.
- An apparent date, only if explicitly stated.
- A short excerpt or location reference explaining why it was extracted.

The engine must not infer commitments from vague discussion. Each item gets an individual Copy control, plus an optional Copy all control. There is no “create reminder” or “schedule” action in V1.

### 2.3 V1 link behavior

Extract only links actually present in the note:

- Markdown links, preserving the human’s label.
- Bare `http` or `https` URLs.
- Repeated links collapsed into one entry, with occurrence count if useful.

Apply the front door’s established URL safety posture: parse before offering, allow only HTTP(S), use inert text for invalid schemes, and never render model-supplied HTML. No link is opened or fetched automatically.

---

## 3. Data model

### 3.1 Authoritative note storage

Notes live in an operator-configurable directory on the ORDERLY host.

Requirements:

- One UTF-8 Markdown file per note.
- Ordinary `.md` files that remain readable and editable without ORDERLY.
- No required frontmatter, hidden markers, proprietary blocks, or AI metadata inserted into note files.
- A title derived from the filename; an initial Markdown heading may be displayed but is not required.
- Owner-only filesystem permissions.
- No cloud synchronization supplied by ORDERLY.

Saving must preserve the editor’s submitted text without automatic reformatting, AI cleanup, metadata insertion, or link rewriting.

### 3.2 Stable identity and metadata

Each note receives a host-generated opaque note ID. The ID is kept outside the Markdown file in an ORDERLY-managed metadata store.

Metadata should include:

- Note ID.
- Current relative file path.
- Creation and modification timestamps.
- Current content hash.
- Archive state.
- Per-note AI eligibility.
- Last known file attributes needed to detect external changes.

Renames performed through the UI update the mapping without changing note bytes.

If a file is renamed outside ORDERLY, the system may relink it automatically only when an exact previous content hash yields one unambiguous match. Otherwise, present an operator repair choice rather than attaching annotations to the wrong note.

### 3.3 Versioning

Every successful save creates a local revision record:

- The current revision is identified by a cryptographic hash of the exact saved bytes.
- Previous text snapshots live in an ORDERLY-managed history directory, not in the note file.
- History is never sent for analysis merely because the current note is analyzed.
- Restoring a version requires preview and explicit confirmation.
- A restore creates a new revision; it does not erase intervening history.
- The operator can purge history independently.

Writes must be atomic. If the file changed externally after the editor loaded it, saving must stop and offer comparison/reload rather than silently overwrite the external change.

### 3.4 Annotation storage

AI annotations live in a separate store keyed by:

- Note ID.
- Source content hash.
- Annotation type.
- Analysis timestamp.
- Analyzer/prompt version.
- Model and provider identifier.
- Output status.

The stored output is the validated summary and action-item structure, not arbitrary executable markup. Raw model responses should not be retained by default.

Local link extraction may be recomputed directly from the current text or cached under the same content hash.

Annotations must never be appended to or embedded in Markdown files.

### 3.5 Staleness model

An annotation has one of these states:

- **Current:** its source hash matches the saved note.
- **Stale:** its source hash differs from the saved note.
- **Draft-outdated:** the operator has unsaved edits differing from the analyzed saved version.
- **Running:** analysis is in progress for a named source hash.
- **Failed:** that run failed; the note remains unaffected.

On any edit, the UI immediately indicates that existing assistance describes the last saved version. On save, a hash mismatch marks it stale.

Stale annotations are retained but collapsed by default under “Based on an earlier version.” They are never silently relabeled as current.

If the operator edits while analysis is running, the result remains attached to the original hash and arrives already marked stale. It must not replace current-version assistance.

---

## 4. Interaction flow and controls

### 4.1 Normal note flow

1. Open Notes.
2. Create or select a note.
3. Write in the main canvas.
4. Save the note.
5. Local link extraction updates without a model call or network request.
6. Optionally request AI assistance for that saved version.

The operator can create, edit, search, rename, archive, restore, and read notes with AI completely disabled.

### 4.2 AI enablement

Use two gates:

1. **Global setting:** “Notes AI assistance,” off by default.
2. **Per-note eligibility:** off by default for every new and existing note.

Enabling either gate does not run analysis. Every analysis still requires an explicit **Analyze saved version** action.

If the configured backend is remote, the action must clearly state that this note version will be sent to the named configured provider. ORDERLY must not imply that a third-party provider has no retention unless that is independently known.

The Analyze control is disabled while the note has unsaved changes, with a prompt to save first.

### 4.3 Execution policy

V1 has:

- No analysis on save.
- No timer.
- No background refresh.
- No scheduled corpus scan.
- No automatic retry.
- No analysis triggered by opening a note.

A single requested run may produce both the summary and action items to control cost. Progress, cancellation, failure, and the analyzed source version must be visible.

The analysis path must be tool-free. Note content is data, not instructions; content inside a note cannot authorize connector use, web research, file access, memory changes, or additional model calls.

### 4.4 Editing after analysis

After the note changes:

- Local links update from the current text.
- Existing AI sections visibly become stale.
- The operator may keep, delete, or inspect stale output.
- Refresh requires another explicit analysis action.
- The UI must never refresh silently because the per-note gate remains enabled.

Turning off AI eligibility prevents future runs. Existing local annotations remain until the operator separately deletes them, avoiding an ambiguous destructive toggle.

### 4.5 Promoting a suggestion

Every generated item may offer **Copy**.

Copying:

- Puts plain text on the clipboard.
- Does not focus, move the cursor in, or alter the editor.
- Does not preserve hidden provenance or markup.
- Shows brief confirmation that it was copied.

V1 must not include “Insert,” “Accept,” drag-to-editor, automatic checkbox creation, or keyboard shortcuts that mutate the note from the rail.

---

## 5. Surface and channel fit

### 5.1 Web front door

Notes should be a first-class destination in the existing front door, not a chat conversation with an agent. Calling it a desk is acceptable for product consistency, but its interaction model is an editor, not a session.

**ASSUMPTION:** The front-door shell can accommodate a Notes destination alongside the existing desk surfaces. If it cannot, Notes should use a dedicated `/notes` route served by the same front-door process and origin.

**ASSUMPTION:** The existing card rail pattern can be adapted into a persistent assistance rail. If the current layout cannot support that, use a clearly separated panel below the editor rather than placing AI content inside the note canvas.

Proposed layout:

- Left: note list, local keyword search, Create, Rename, and Archive.
- Center: filename/title, save state, version indicator, and Markdown editor.
- Right: collapsible Assistance rail.
- Narrow viewport: list view → editor view, with Assistance as a labeled drawer or section below the note.

Any rendered Markdown preview must disable raw HTML and apply the same safe-link rules as the existing front door.

### 5.2 Mobile and Telegram

V1 mobile access is the tailnet-only web surface with a responsive editor and readable assistance panel.

There is no Telegram note listing, reading, editing, or AI-analysis command in V1. Sending note bodies through Telegram would disclose them to an additional service and create confusing write and version semantics.

A future Telegram read path must be separately enabled, read-only by default, and explicit about which note content leaves the host. It must not make notes part of coordinator memory.

---

## 6. Anti-goals

Notes must not:

1. Provide inline completion, ghost text, grammar corrections, silent rewriting, or automatic formatting.
2. Let a model, agent, annotation, or chat response invoke a note write.
3. Treat copied note content as instructions to ORDERLY or its agents.
4. Automatically feed notes into coordinator memory, chat context, briefings, mail routines, or research.
5. Create notes automatically from email, calendar events, chats, or reminders.
6. Turn extracted action items into reminders, tasks, messages, or calendar events.
7. Fetch extracted links, generate previews, or expose browsing capability in V1.
8. Use embeddings, a hosted vector database, or external search indexing in V1.
9. Sync notes or annotations to a cloud note service.
10. Present AI output without an explicit **AI-generated** label and source-version status.
11. Render model output as HTML or trust model-provided URLs without parsing them.
12. Hide provider use, model-call failures, stale output, or external-edit conflicts.
13. Require a functioning model to open, edit, save, search, version, or archive notes.
14. Place note files in an agent-writable workspace.
15. Interpret enabling AI as ongoing permission for automatic or background analysis.

When assistance fails, the result is a plain working notepad plus an honest failure message.

---

## 7. Open design-axis questions for the operator

1. Should the front-door label be **Notes**, **Notebook**, or a named desk?
2. Should the assistance rail open by default when current assistance exists, or always begin collapsed?
3. Should the editor be Markdown source only, source plus optional preview, or a split source/preview view?
4. Should summaries default to a short paragraph or three-to-five bullets?
5. Should V1 present one flat note list, or show filesystem folders as the primary organization?

---

## 8. V1 minimal slice and rough build shape

### 8.1 Minimal operator-visible slice

V1 includes:

- A web Notes destination.
- Plain Markdown files in a configurable host directory.
- Create, open, edit, save, rename, archive, and local keyword search.
- Atomic saves, external-change conflict detection, and local version history.
- A responsive human-only editor canvas.
- A separate collapsible assistance rail.
- Deterministic local extraction of HTTP(S) and Markdown links.
- On-demand AI summary and action-item extraction.
- Global and per-note default-off AI gates.
- Explicit analysis of saved versions only.
- Content-hash attachment and visible staleness.
- Copy-only promotion of generated text.
- Controls to delete annotations and purge local history.
- Plain-notepad operation during all AI failures.
- No Telegram integration.

### 8.2 Implementation components

1. **Note storage service**
   - File discovery, owner-only paths, atomic writes, renames, archives, conflict detection, and content hashing.

2. **Metadata and history service**
   - Stable note IDs, path mapping, revision snapshots, retention/purge operations, and external-rename repair.

3. **Annotation service**
   - Separate annotation storage, schema validation, model/provider provenance, current/stale resolution, and deletion.

4. **Local extraction component**
   - Markdown and bare-URL parsing, deduplication, context display, and safe HTTP(S) rendering without fetches.

5. **Narrow analysis broker**
   - Receives one saved note version, invokes the configured model through the narrowest supported path, exposes no tools or note-write capability, and returns validated summary/action structures.

6. **Front-door Notes UI**
   - Note browser, editor, save/conflict states, history view, assistance rail, copy controls, and narrow-screen behavior.

7. **Settings integration**
   - Guarded global default-off capability and per-note eligibility, with provider disclosure and no credential values exposed.

8. **Security and failure probes**
   - Verify that model output cannot reach a note-write path, disabled gates produce no model request, hostile note text cannot invoke tools, stale in-flight results attach to the correct hash, invalid links remain inert, external edits are not overwritten, and model outages leave note operations working.