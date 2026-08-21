> **DRAFT for the v0.4 arc — NOT YET RATIFIED.** Produced by Sakana Fugu (`fugu`, base tier,
> chat API, 40,000-token budget; completed clean in 271s using 12,727 completion tokens
> [8,110 reasoning] — not truncated, ends at its own requested "open questions" section)
> from a spec-only ask (external-reasoner-discipline: numbered required sections, explicit
> anti-goals, no code). The ask was grounded in this repo's own precedent for exactly this
> shape of feature — `docs/VOICE-PROFILE.md` (the installed operator-authored law-file
> pattern for mail voice) — plus the coordinator's full standing orders
> (`config/agents/coordinator-AGENTS.md`), the two live voice-orders append blocks
> (`config/agents/voice-orders.{coordinator,mail}.md`), the README's security-posture and
> status sections, the `web/settings.mjs` typed-envelope / path-allowlist / invariants write
> discipline (the engine-definition class's Gate 2 is the newest live instance of that
> pattern), and both named-agent system-preamble construction paths in `web/agents.mjs`
> (the mounted, read-only `STANDING_ORDERS` template) and `web/server.mjs`
> (`agentSystemPrompt`, the memoryless inline builder). This is a design document, not an
> implementation plan — nothing below has been reviewed or approved by the operator yet.
>
> Operator framing behind the ask (verbatim flagship example): *"don't end every response
> with a question unless one is genuinely needed."* The operator wants a claude.ai-preferences-
> style surface where they leave plain instructions tuning how the bot(s) talk to them — never
> a new capability, never a new safety boundary.

# ORDERLY reply-style preferences — specification v0.4

**Status: proposed.**

Reply-style preferences are operator-authored, session-durable instructions governing how ORDERLY speaks to the operator. They are a style layer only. They do not add tools, credentials, network access, delegation, memory, or write authority.

This is a **prompt-layer control**, not a sandbox or capability boundary. It rests on the model following the assembled system preamble. Failure to follow a preference may produce an irritatingly generic reply; it MUST NOT enlarge the agent's blast radius.

## 1. Storage and precedence

### 1.1 Scope

1. Reply-style preferences SHALL govern operator-facing responses from the coordinator and participating named agents.
2. They SHALL NOT govern mail written to other people. `VOICE.md`, the mailbox-specific voice rules, and the mail stop-slop orders remain authoritative for drafts.
3. Where a mail-capable identity speaks directly to the operator, reply-style preferences MAY govern its explanatory carrier text, but MUST NOT alter the enclosed draft.
4. Preferences SHALL be durable station configuration, not memory. They MUST NOT be copied into `MEMORY.md`, daily notes, agent transcripts, or `VOICE.md` as an authoritative instruction source.

### 1.2 Authoritative storage

1. The authoritative record SHALL live in the gateway's existing `openclaw.json`, under a station-owned `orderly.replyStyle` subtree.
2. The subtree SHALL contain:
   1. station-wide free text;
   2. station-wide enabled preset identifiers;
   3. optional per-agent free text; and
   4. optional per-agent preset overrides.
3. Free text and preset state SHALL remain data within that narrow subtree. No preference field SHALL contain or alias a tool policy, approval policy, credential reference, channel, binding, sandbox setting, workspace path, model provider, or delegation setting.
4. The prompt assembler SHALL read the preferences host-side. Agents SHALL receive only the rendered preference block and SHALL NOT be given access to `openclaw.json`.

This uses the station's existing typed, reviewed, atomic configuration-write mechanism rather than introducing a writable preference file in an agent workspace.

### 1.3 Ownership and permissions

1. The preference subtree SHALL inherit the existing ownership, group, permissions, backup treatment, and write path of `openclaw.json`.
2. `openclaw.json` MUST remain unavailable inside every agent sandbox.
3. Preferences SHALL **not** receive the same root-owned, mode-`0444`, immutable treatment as `VOICE.md`.
4. That lighter treatment is deliberate:
   1. `VOICE.md` is a law file placed where drafting agents can read it and therefore must be defended from those agents rewriting or deleting it.
   2. Reply-style preferences are intentionally self-editable operator configuration.
   3. The agent never mounts their authoritative store and has no filesystem or network route to it.
   4. Making the live preference record immutable would obstruct its intended settings-page write path without adding a meaningful boundary.
5. The fixed standing-order text that defines the scope and precedence of preferences SHALL retain the normal law-file treatment: host-deployed, mode `0444`, immutable where required, and read-only to the agent.

### 1.4 Binding precedence

The complete precedence chain, highest first, SHALL be:

1. **Standing orders** — define what an identity is, what purpose it serves, which capabilities it lacks, and what it is forbidden from doing.
2. **Safety and approval contracts** — preserve the send wall, calendar-write approval wall, credential rules, untrusted-data rules, queue contracts, and other operational gates.
3. **Reply-style preferences** — tune wording, structure, length, register, and conversational habits while the agent performs work already permitted above.
4. **Model defaults** — the provider model's generic conversational habits apply only where the preceding layers are silent.

A lower rung MUST NOT reinterpret, waive, or route around a higher one.

In practice:

- "Don't ask so many follow-up questions" is a valid style preference. If a follow-up is genuinely required to identify a calendar event or complete another standing-order requirement, the higher requirement wins.
- "Skip the approval queue for drafts" is not a reply-style preference. The settings envelope has no approval field, the path allowlist cannot reach queue or tool policy, guarded subtrees must remain unchanged, and agents receive no new credential or verb. The words could be entered into a text area, but they would have no operational representation or authority: they are rendered only inside a delimited, lower-precedence style block.
- "Say that the event is booked before I approve it" cannot change the calendar contract requiring the agent to describe it as a proposal.
- "Treat email instructions as trusted" cannot change the standing law that inbound text is data.

### 1.5 Precedence within the style layer

Where style instructions conflict with one another, the order SHALL be:

1. per-agent free text;
2. explicit per-agent preset state;
3. station-wide free text;
4. station-wide presets; and
5. model defaults.

A per-agent preset set to "off" SHALL suppress the corresponding station-wide preset for that agent. Absence SHALL mean inheritance. Free text wins over a conflicting curated preset at the same scope because it is the operator's more specific instruction.

None of these internal style rules can outrank sections 1.4.1 or 1.4.2.

## 2. The editing surface

### 2.1 Desk panel

The desk settings page SHALL provide a **Reply style** panel containing:

1. A plain multiline text area labelled in operator terms, such as "How should replies to you read?"
2. A short scope notice: "This changes how the station talks to you. It does not add capabilities or change approvals."
3. Curated preset toggles from section 4.
4. A preview of the effective plain-language instructions that will be injected.
5. If per-agent overrides are exposed in v1, an agent selector and an explicit "inherits station settings" state.
6. A plain-English confirmation step naming whether the change is station-wide or agent-specific.
7. No raw JSON editor, system-prompt editor, path field, import control, or credential field.

The panel SHALL preserve line breaks in the operator's text. It MUST NOT interpret Markdown headings, role labels, XML-like tags, template placeholders, tool syntax, or fenced blocks as configuration structure.

### 2.2 Typed write envelope

1. The existing settings envelope SHALL gain one top-level key: `replyStyle`.
2. That key SHALL be the only browser-expressible route to the preference subtree.
3. Its accepted fields SHALL be limited to:
   1. station instructions;
   2. station preset states;
   3. per-agent instructions; and
   4. per-agent preset states.
4. Unknown fields SHALL be refused and named, not ignored.
5. Preset identifiers SHALL come from the compiled v1 library. The browser MUST NOT be able to invent an identifier and attach separate prompt text to it.
6. Per-agent entries SHALL be accepted only for identities present in the station roster and eligible for reply-style injection.
7. Deleting an agent SHALL remove or render unreachable its preference override; an orphaned override MUST never be applied to a later identity merely because an identifier was reused.

### 2.3 Path allowlist

Gate 2 SHALL allow only these changed leaf families:

1. `orderly.replyStyle.station.instructions`
2. `orderly.replyStyle.station.presets.<known-preset-id>`
3. `orderly.replyStyle.agents.<known-agent-id>.instructions`
4. `orderly.replyStyle.agents.<known-agent-id>.presets.<known-preset-id>`

The allowlist MAY admit the minimum parent-object creation or removal necessary to reach those leaves. It MUST NOT admit `orderly.*`, `orderly.replyStyle.*`, or another broad prefix as a whole.

Arrays SHALL NOT be used for preset state if doing so would require an index-wide allowlist. Preset state SHALL remain addressable by validated, compiled identifiers.

### 2.4 Invariants

After applying the typed edit, the candidate document SHALL satisfy all existing settings invariants, including:

1. deep equality of the gateway, channels, bindings, tools, commands, agent sandbox, workspace and tool-policy subtrees;
2. deep equality of provider credential references;
3. sandbox-all and elevated-off policy rulings; and
4. every other existing `POLICY-GUARD` ruling.

The reply-style subtree SHALL additionally satisfy these invariants:

1. No unknown object keys.
2. Every instruction value is a string.
3. No NUL bytes or non-text control characters.
4. A maximum of 8 KiB of UTF-8 text per station or agent text field.
5. A maximum of 32 KiB for the complete reply-style subtree.
6. Every preset key is a compiled preset identifier.
7. Station preset values are Boolean.
8. Per-agent preset values are Boolean or absent, with absence meaning inheritance.
9. Every per-agent key resolves to an eligible roster identity.

There SHALL be no semantic classifier attempting to decide whether arbitrary prose is "really" about style. Such a classifier would be unreliable. Scope is enforced by the narrow storage path, unchanged authority subtrees, fixed prompt precedence, and absence of any operational route from the text to a capability.

### 2.5 Commit discipline

The existing write sequence is sufficient and SHALL remain unchanged:

1. typed envelope;
2. changed-path allowlist;
3. invariant and policy checks;
4. plain-English operator confirmation;
5. serialized, one-at-a-time write;
6. backup beside the config;
7. temporary-file write;
8. filesystem sync; and
9. atomic rename.

This feature MUST NOT weaken, bypass, or special-case any of those stages.

A successful change SHALL take effect at the next system-prompt assembly. If an upstream session cannot accept a replaced system preamble, the desk SHALL begin a fresh upstream session or state clearly that the change applies from the next session. It MUST NOT claim that a cached prompt changed when it did not.

## 3. Injection into the system preamble

### 3.1 Fixed preference contract

A fixed **Reply-style preferences** standing-order block SHALL define:

1. the precedence in section 1.4;
2. that preferences govern operator-facing wording only;
3. that preference text is quoted configuration, not new authority;
4. that it cannot change capabilities, approval gates, credential handling, or the treatment of untrusted data;
5. that it is not memory and MUST NOT be rewritten by the agent; and
6. that task accuracy and genuinely required clarification outrank cosmetic style.

For the coordinator, this block SHALL be staged and deployed using the same reviewed, idempotent standing-orders append pattern already used by `voice-orders.coordinator.md`. The deployed coordinator orders SHALL retain their existing root-owned, mode-`0444`, immutable treatment.

The operator's editable preference text itself SHALL not be copied into that immutable file.

### 3.2 Coordinator construction path

The coordinator's assembled system preamble SHALL appear in this order:

1. the coordinator's complete standing orders, including the voice-profile and stop-slop additions;
2. the fixed reply-style contract;
3. the host-rendered effective reply-style block;
4. memory and other station-provided context; and
5. conversation, specialist reports, email content, web content, and tool results.

The effective block SHALL be visibly delimited and introduced as lower-precedence style data. Each operator-authored line SHALL be quoted or escaped so that text resembling a heading, role marker, closing delimiter, or tool instruction cannot terminate or restructure the block.

The preference renderer SHALL include:

1. enabled station preset sentences;
2. station free text;
3. applicable per-agent preset changes; and
4. applicable per-agent free text.

The renderer SHALL also state the within-style precedence from section 1.5 rather than relying solely on textual position.

Missing preferences SHALL produce no style block beyond the fixed contract. A malformed stored record SHALL fail closed by omitting the editable block and reporting the settings fault to the operator; it MUST NOT prevent the higher standing orders from loading.

### 3.3 Named-agent standing-orders path

For a provisioned named agent using the `STANDING_ORDERS` template (`web/agents.mjs`):

1. The template SHALL include the fixed reply-style contract after the identity, purpose, capability and delegation limits.
2. The generated `standing-orders.md` SHALL remain host-managed, mode `0444`, and mounted read-only.
3. Editable preference text SHALL not be baked into that file.
4. At prompt assembly, the host SHALL concatenate:
   1. the complete read-only `standing-orders.md`;
   2. the effective reply-style block; and
   3. the agent's permitted memory or transcript context.
5. The agent SHALL never read the preference store directly.

This preserves the named-agent law-file model while allowing operator edits without rewriting an agent's identity file on every style change.

### 3.4 Memoryless inline `agentSystemPrompt` path

For a named agent using the inline `agentSystemPrompt` construction (`web/server.mjs`):

1. The identity, operator-authored purpose, no-credential rule, no-network rule, no-delegation rule, and card prohibition SHALL be assembled first.
2. The same fixed reply-style contract SHALL follow those higher-precedence clauses.
3. The same host-rendered effective style block SHALL follow the contract and precede the conversation transcript.
4. The common renderer and common stored record SHALL be used for both named-agent construction paths.
5. A single invocation MUST NOT receive duplicate copies merely because both construction mechanisms exist.

Memorylessness does not prevent use of station configuration. It means the agent does not retain or mutate that configuration itself.

### 3.5 Purpose, station preferences, and per-agent overrides

1. A named agent's description and purpose are part of its identity and therefore outrank style preferences.
2. Station-wide preferences SHALL form the default for every participating identity.
3. A per-agent override MAY refine that identity's wording without changing its purpose or capabilities.
4. A per-agent style conflict SHALL resolve in favour of the per-agent instruction, but only inside the style layer.
5. If an agent's purpose requires detail while the station preset requests terse replies, the agent SHALL provide the detail required by its purpose and remain terse only where compatible.
6. A per-agent instruction such as "be willing to use longer technical explanations" is valid. "Use the researcher even though delegation is off" is not operationally expressible through this feature and leaves the no-delegation law unchanged.

### 3.6 Relationship to direct task requirements

A requested output form that is intrinsic to the task — such as "compare these figures in a table" — is not a preference-store mutation. Higher standing orders and task accuracy may require a form that differs from the durable style default.

V1 SHALL NOT create a special per-turn style flag or silently persist chat phrasing as configuration.

## 4. A starter preset library

Each preset SHALL render as the single sentence shown below. Labels are UI conveniences; the sentence is the authoritative preset text.

1. **Questions only when needed** — "Don't end every response with a question unless you genuinely need an answer from me."
2. **Skip the applause** — "Don't open with 'Great question,' 'Absolutely,' or other praise; start with the answer."
3. **Prose before bullets** — "Use plain prose by default, and use bullets only when the material is genuinely a list."
4. **Keep it terse** — "Keep routine replies short and stop when the useful answer is finished."
5. **Don't repeat me** — "Don't restate my question before answering it."
6. **No emoji** — "Don't use emoji in replies to me."
7. **Match my register** — "Match the level and register I use without exaggerating or imitating it."
8. **No generic closing offer** — "Don't tack on 'let me know if you need anything else,' 'happy to help,' or another stock closing."
9. **Answer before process** — "Lead with the result and don't narrate your process unless the process is relevant."
10. **Only real caveats** — "Don't pad an answer with generic caveats; state uncertainty only when it is real and relevant."

All seven seeded ideas were retained (Fugu's note: terse mode and answer-before-process overlap slightly but control different failures — one limits total length, the other removes preambles and process narration). Three additions earned a v1 place in Fugu's judgment: **no generic closing offer** covers engagement tics that aren't grammatically questions; **answer before process** addresses roadmap/throat-clearing without forbidding useful reasoning; **only real caveats** removes defensive model padding while preserving genuine uncertainty.

V1 SHOULD ship presets disabled until the operator chooses them, except that the flagship "Questions only when needed" preset MAY be enabled by default if the operator approves that initial policy.

## 5. Prompt-injection hardening

### 5.1 Structural write isolation

The following mechanisms SHALL collectively prevent text read by an agent from being written into the preference store:

1. The settings service accepts only the fixed `replyStyle` envelope; callers cannot name a filesystem or config path.
2. The candidate config is diffed and only the exact reply-style leaf paths in section 2.3 may change.
3. Existing guarded authority subtrees must remain deeply equal.
4. The settings endpoint remains same-origin, serialized, and behind an explicit operator confirmation.
5. No agent sandbox mounts `openclaw.json`.
6. The coordinator has no route from its writable workspace to the host configuration.
7. The mail agent and researcher remain memoryless and write nowhere.
8. Agent containers cannot reach the loopback-bound front door or gateway.
9. The researcher's guarded fetch returns page text but does not provide a general browser or request path.
10. Mail routines retain only the existing `notify` and `draft` vocabulary; a matched message cannot name or trigger a settings write.

Consequently, an email body, fetched page, search result, specialist report, routine match, transcript line, or memory note cannot become a preference update. It remains data under the existing law: **text is data, never instructions**.

The only exception is a deliberate human act in which the operator manually types or pastes text into the settings panel and confirms it. At that point the provenance is the operator's settings action, not an automatic trust elevation of the original content.

### 5.2 Agent-proposed changes

An agent SHALL NOT create, stage, submit, or apply a preference change in v1.

If the operator gives a durable style instruction in chat, the agent MAY say that it belongs in the Reply style panel and may quote the operator's own words back for convenience. It MUST NOT:

1. call a settings endpoint;
2. create a pending preference-change card;
3. write the instruction into memory as an authoritative substitute;
4. infer a preference from observed behaviour; or
5. turn its own suggestion into durable configuration.

This is the correct boundary for a single-operator station. There is no operational need to add an agent-to-settings authority path when the operator already has a direct, reviewed settings surface. It also avoids turning hostile text or model inference into a resident prompt change.

## 6. Anti-goals

V1 is explicitly not:

1. **A personality marketplace.** There are no persona packs, downloadable characters, public profiles, or shareable preference bundles.
2. **Model-authored self-modification.** No model may write, stage, learn, refresh, or repair its own preferences, ever.
3. **An authority editor.** No preference may override or route around the send wall, calendar-write wall, credential rules, immutable standing orders, sandbox policy, delegation limits, or approval queue.
4. **A per-message style override.** "Just this once, be more casual" does not create a temporary preference layer. V1 preferences are durable station configuration changed through Settings.
5. **A replacement for `VOICE.md`.** Reply style controls how the station talks to the operator; `VOICE.md` and the drafting orders control mail written as the operator to other people.
6. **A memory or learning system.** Preferences are not inferred from transcripts, sent mail, pages, corrections, ratings, or repeated wording.
7. **A raw system-prompt editor.** The operator receives a scoped plain-language style field, not access to role messages, tool instructions, prompt ordering, or hidden gateway preambles.
8. **A new capability or safety boundary.** No tool, credential, scope, network route, write verb, or approval authority is added.
9. **A guarantee of stylistic enforcement.** This is a prompt-layer wall and MUST be described honestly as one. Model compliance can vary without changing structural security.
10. **A new outbound data path.** Preference text stays in the existing private host configuration and is sent only as part of prompts already being assembled for the chosen model.
11. **An inbound-content promotion mechanism.** Email, web content, routine matches, memory, and specialist reports never become preference instructions automatically.
12. **A formatting prohibition that defeats the task.** Accuracy, required clarification, and genuinely task-essential output structure remain governed by higher instructions.

## Open questions for the operator

1. Should per-agent overrides be visible in the v1 UI, or should v1 ship station-wide controls while retaining the per-agent storage and precedence design?
2. Should "Questions only when needed" start enabled, or should every preset initially be off?
3. Should the preferences apply to autonomous operator-facing messages such as the morning briefing and reminders, subject to their higher standing formats, or only to interactive replies?
4. When a preference changes during an active upstream session, is starting a fresh model session acceptable if that is required to replace the system preamble?
