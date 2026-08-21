> **RATIFIED AS BUILD DIRECTION 2026-08-21 (orchestrator, by the operator's delegation).** Reviewed against the identity-split posture and accepted; operator rulings inside this doc bind. Build lanes ground here.

# ORDERLY Configurable Seat Engines (incl. Small Local Models) — design spec (2026-08-21)

Produced via a deep-reasoning model from a spec-only ask (numbered required sections,
explicit anti-goals, no code), grounded in this project's own broker source and configuration
files — plus a read of the operator's own prior-art harness on separate infrastructure he
runs, which drives a fine-tuned 7B-class model through multi-step chained tasks despite the
model being empirically a single-step tool executor.

The operator's framing for this ask: a friend would find ORDERLY more useful if the friend's
own local 7B-class models (Ollama or similar) could handle ORDERLY's chat seat. The operator
has already proven, on his own infrastructure, that a 7B can do real chat/research work and
that a harness he built lets that same 7B chain multi-step tasks as a single-step executor.
This spec's job is to make small local models a first-class, honestly-tiered, configurable
engine choice in ORDERLY — never a silent downgrade, never an overpromise, and never a
backdoor into the dispatch broker's pinned, exact-seat coding lane.

This is a design document, not an implementation plan — nothing below has been reviewed or
approved by the operator yet.

---

# SPEC — Configurable Chat-Seat Engines for ORDERLY

**Status:** Proposed for operator ruling
**Scope:** OpenClaw chat/agent surfaces and named-agent composition only
**Normative terms:** "SHALL," "SHALL NOT," "SHOULD," and "MAY" are binding as conventionally defined.

For this specification, "seat" means an OpenClaw-hosted chat or named-agent seat. It SHALL NOT mean `broker/seat.mjs` or any dispatch-broker coding seat.

## 1. Engine abstraction

### 1.1 Existing provider registry remains authoritative

1. ORDERLY SHALL continue to describe model endpoints through the existing `models.providers` registry in `config/openclaw.json`.

2. An engine SHALL resolve through:
   - a provider identifier;
   - the provider's `baseUrl`;
   - the provider's `api`;
   - the provider's `auth` declaration;
   - an exact model `id` or tag from the provider's `models[]`;
   - that model's `contextWindow`;
   - that model's `maxTokens`;
   - the seat's effective `contextBudget`;
   - the seat's `capabilityTier`; and
   - when required, the seat's `harnessRef`.

3. A provider `baseUrl` MAY name:
   - a cloud OpenAI-compatible service;
   - an Ollama or llama.cpp-class server on the ORDERLY host;
   - an endpoint on the operator's LAN;
   - an operator-owned endpoint reachable through Tailscale or an equivalent private network; or
   - another OpenAI-compatible endpoint deliberately configured by the operator.

4. ORDERLY SHALL NOT create a second provider registry for "local models." Local and cloud endpoints SHALL use the same provider abstraction.

5. A provider's model entry SHALL continue to own the physical `contextWindow` and `maxTokens` declarations. A seat's `contextBudget` SHALL be an effective limit and SHALL NOT exceed the selected model's `contextWindow`.

6. A model entry SHALL declare `toolProtocol` as either a supported OpenAI-compatible tool protocol or `none`. ORDERLY SHALL NOT infer reliable tool use solely from a model name or parameter count.

7. A provider-qualified model reference SHALL identify an exact configured provider and exact model tag. Display aliases SHALL NOT substitute for the identity used during invocation or probing.

**Choice and tradeoff:** This specification extends the existing provider-and-model registry instead of introducing a separate `engines` registry. This avoids duplicated endpoint, credential, and context metadata. The tradeoff is that an "engine" is a resolved binding rather than one standalone configuration object.

### 1.2 Seat bindings and inheritance

1. `agents.defaults.model.primary` and its ordered `fallbacks` SHALL remain the default model-selection mechanism.

2. ORDERLY SHALL add an optional per-agent `model` override with the same `primary` and `fallbacks` semantics as `agents.defaults.model`.

3. Each effective seat binding SHALL also resolve:
   - `contextBudget`;
   - `capabilityTier`; and
   - `harnessRef`, when applicable.

4. An agent without a per-agent override SHALL continue to inherit the default binding.

5. A per-agent override SHALL affect only that agent. It SHALL NOT alter `agents.defaults`, another agent's engine, or any provider declaration.

6. Existing cloud model selections and fallback ordering SHALL remain unchanged during adoption of this specification. Any configuration migration SHALL preserve the exact existing provider-qualified model references.

7. Before tier enforcement is enabled for an existing binding, that binding SHALL receive an explicit reviewed tier classification. ORDERLY SHALL NOT silently infer a weaker tier and thereby remove existing behavior.

### 1.3 Fallback and context semantics

1. A fallback SHALL be used only when its provider-qualified model reference appears in the operator-authored `fallbacks` array.

2. ORDERLY SHALL NOT invent a fallback, use a provider default, or cross to another endpoint because the selected endpoint failed.

3. Every configured fallback SHALL pass the same configuration-time probes required for the binding's `capabilityTier`.

4. Every fallback in a chained-task binding SHALL be qualified with the same `harnessRef`. A fallback to a bare model SHALL NOT preserve a chained-task claim.

5. If any fallback is qualified only for a lower tier, ORDERLY SHALL reject the binding rather than silently lower capability during fallback.

6. Runtime fallback use SHALL be reported at point of use with the selected `modelRef` and `fallbackUsed` status.

7. ORDERLY SHALL enforce `contextBudget` before invocation. The effective input budget plus reserved `maxTokens` SHALL fit within the selected model's `contextWindow`.

8. ORDERLY SHALL NOT silently truncate a request merely to fit a smaller local model. If an existing, visible conversation-compaction policy is used, ORDERLY SHALL identify that compaction occurred; otherwise it SHALL refuse the invocation with the applicable budget figures.

## 2. Capability tiers — honest, not silent

### 2.1 Tier semantics

1. `capabilityTier` SHALL express an enforced execution ceiling. It SHALL NOT be a marketing label, quality score, or assertion that models of different sizes are equivalent.

2. ORDERLY SHALL recognize these operation classes:
   - `chat`;
   - `singleStepTool`;
   - `chainedTask`; and
   - `codingLane`.

3. The gateway SHALL check the requested operation class against the active tier before invoking a model or tool.

4. A model SHALL NOT promote its own tier through generated text, a tool call, a self-reported identity, or a proposed plan.

5. Model size SHALL NOT automatically confer a tier. A 7B-class model MAY qualify for the first two tiers below under their stated conditions, but SHALL NOT qualify for the coding/lane tier under this specification.

**Choice and tradeoff:** Tiers are enforced at typed operation and tool boundaries rather than by attempting to classify every natural-language request perfectly. This provides checkable enforcement. The tradeoff is that an ambiguous complex request may remain an ordinary best-effort chat request unless the user or agent requests a protected chained or coding operation.

### 2.2 Chat/research tier

1. The tier identifier SHALL be `chat-research`.

2. A `chat-research` seat SHALL be permitted to perform:
   - direct single-turn chat;
   - short multi-turn chat using the agent's existing memory policy; and
   - at most one approved tool invocation per assistant turn when `toolProtocol` has passed its probe.

3. After one tool invocation, the model MAY produce a final answer using that result. It SHALL NOT initiate a second tool invocation in the same turn.

4. A `chat-research` seat SHALL NOT:
   - run an autonomous multi-step tool chain;
   - retry tools autonomously after failure;
   - invoke a recursive orchestration tool;
   - represent that one tool result as a completed multi-source chain; or
   - initiate a `codingLane` operation.

5. If `toolProtocol` is `none`, the seat MAY perform direct chat but SHALL refuse `singleStepTool` and research operations that require a tool. The point-of-use tier display SHALL state that tools are unavailable.

6. A request explicitly requiring multiple tool steps SHALL be refused with a plain explanation that the active engine is limited to `chat-research` and lacks a chained-task harness.

### 2.3 Chained-task tier

1. The tier identifier SHALL be `chained-task`.

2. A `chained-task` seat SHALL consist of an engine binding plus an approved non-model orchestration harness.

3. A bare model SHALL NOT be described as having chained-task capability. The capability SHALL always be attributed to the `(modelRef, harnessRef)` pair.

4. A `chained-task` seat SHALL support the `chat`, `singleStepTool`, and `chainedTask` operation classes.

5. Every `chainedTask` operation SHALL use the plan → gate → bounded execute → synthesize process specified in §3.

6. The tier SHALL NOT imply:
   - open-ended autonomous operation;
   - arbitrary retries;
   - dependent step-to-step result threading;
   - permission to invoke tools outside the agent's existing tool profile;
   - authority to alter a delegation allowlist; or
   - coding/lane qualification.

7. A chained task SHALL expose an execution trace and SHALL identify whether it used a validated model plan, a deterministic fallback plan, or no executable plan.

### 2.4 Coding/lane tier

1. The tier identifier SHALL be `coding-lane`.

2. `coding-lane` SHALL be a reserved description of the separate dispatch-broker lane. It SHALL NOT be a selectable `capabilityTier` for an OpenClaw chat-seat engine under this specification.

3. A 7B-class engine SHALL never be presented as a coding/lane engine, regardless of its model tag, fine-tuning claims, tool syntax, or operator-selected chat tier.

4. Configuring a local engine for `coordinator`, `researcher`, `coder`, `reviewer`, `mail`, or a named agent SHALL NOT change the engine used by `broker/seat.mjs`.

5. A chat engine MAY draft a narrow coding brief as ordinary text if its existing policy permits. That act SHALL NOT authorize a dispatch, execute code, or qualify the chat engine as the coding seat.

6. A `codingLane` request SHALL use only the broker's existing separately authorized path. The gateway SHALL NOT silently reinterpret an unsupported coding request as chat, a chained research task, or a weaker local-model attempt.

7. This separation is required by the recorded `trial-seat` evidence: GPT-5.6 at high effort scored 90.5/100 with zero hard failures across 48 invocations, while the mid-tier control scored 60/100 and made two unapproved dispatches. ORDERLY SHALL treat unapproved dispatch as disqualifying safety evidence, not merely reduced answer quality.

### 2.5 Operator disclosure

1. At configuration time, ORDERLY SHALL display:
   - the provider identifier;
   - sanitized `baseUrl`;
   - exact model tag;
   - `contextWindow`;
   - effective `contextBudget`;
   - `maxTokens`;
   - `toolProtocol`;
   - `capabilityTier`;
   - `harnessRef`, if any; and
   - every explicit fallback.

2. At point of use, the web UI SHALL display a persistent engine-and-tier indicator for the active agent.

3. Telegram and other channel attachments SHALL expose the same information through visible response metadata or an immediately available agent-status surface.

4. Every chained-task result SHALL visibly identify its tier, model, harness, plan disposition, and failed or skipped steps.

5. Every runtime fallback SHALL be disclosed in the resulting response.

6. When a request exceeds the active tier, ORDERLY SHALL refuse it with:
   - the requested operation class;
   - the active tier;
   - the missing requirement, such as `harnessRef` or coding-lane authorization; and
   - a non-automatic next action available to the operator.

7. ORDERLY SHALL NOT silently downgrade an operation class, silently omit requested steps, or claim completion after a tier refusal.

## 3. Embedding the harness pattern for chained tasks

### 3.1 Selected design

1. ORDERLY SHALL provide a gateway-owned harness identified by `harnessRef` value `bounded-sequencer-v1`.

2. The harness SHALL be implemented in the OpenClaw gateway or an adjacent ORDERLY-owned service operating under gateway policy.

3. The harness SHALL NOT be implemented in `broker/`, loaded by `broker/seat.mjs`, or represented as a broker command preset.

4. The first-party chained-task tier SHALL NOT depend on the operator's existing local orchestration bot's tailnet endpoint or bespoke `/api/chat-with-tools` endpoint.

5. An operator MAY select their own fine-tuned model's endpoint as an ordinary OpenAI-compatible provider endpoint, but ORDERLY's tier claim SHALL depend on ORDERLY's own `bounded-sequencer-v1`, not on an undisclosed external loop.

**Choice and tradeoff:** ORDERLY shall minimally reimplement the proven harness invariants inside the gateway rather than call the operator's existing local orchestrator remotely. This avoids making chained tasks dependent on Tailscale reachability, a second service's tool registry, and a different trust boundary. The tradeoff is duplicated orchestration logic that must remain behaviorally aligned with the validated harness.

### 3.2 Plan phase

1. The model SHALL receive one goal and a fixed planner instruction.

2. Planner tool access SHALL be disabled. The model SHALL emit the proposed plan as text.

3. The plan SHALL identify:
   - an ordered set of steps;
   - one step label per step;
   - exactly one requested tool per step;
   - one independent prompt per step; and
   - a separate synthesis instruction.

4. The planner prompt SHALL request two to four independent steps by default.

5. `maxSteps` SHALL default to four and SHALL have a hard ceiling of five.

6. Step-to-step result threading SHALL NOT be supported by `bounded-sequencer-v1`. A step SHALL NOT consume another step's result as an input.

7. The model SHALL NOT set or increase any hard limit.

### 3.3 Gate phase

1. A strict validator SHALL gate every proposed plan before any plan step executes.

2. Deterministic normalization MAY correct only explicitly recognized structural drift, including:
   - a synthesis instruction emitted as a numbered step; or
   - omission of a defaultable bounded field.

3. Normalization SHALL NOT:
   - invent a new substantive step;
   - replace a requested tool with a more privileged tool;
   - increase a numeric bound;
   - convert a dependent plan into an apparently independent one; or
   - treat unparseable prose as authorization.

4. The validator SHALL verify:
   - plan structure;
   - step count;
   - required labels and prompts;
   - exactly one tool per step;
   - tool membership in the agent's effective tool profile;
   - tool membership in the agent's `capabilityBindings`;
   - tool eligibility for chained execution;
   - absence of result-threading references;
   - absence of recursion targets; and
   - all numeric and text-length limits.

5. A capability SHALL be unavailable to the sequencer unless its policy metadata explicitly marks it `sequencerEligible`. Absence of that marker SHALL mean denied.

6. Side-effecting tools SHALL be ineligible by default. A standing policy MAY mark a specific typed capability eligible, but the harness SHALL NOT create that permission.

7. Coding-lane dispatch, `orchestrate`, `decision_session`, and the sequencer itself SHALL be recursion- or lane-blocked regardless of model output.

8. An unvalidated model plan SHALL never execute.

9. If validation fails and `deep_research` is both bound and `sequencerEligible`, the harness MAY use the fixed one-step fallback plan naming the original goal.

10. If that deterministic fallback is unavailable, the harness SHALL refuse the chained task without executing a tool.

11. Use of a fallback plan SHALL be disclosed as `planDisposition=fallback`. It SHALL NOT be described as successful execution of the model's original plan.

### 3.4 Bounded execution phase

1. Validated steps SHALL execute in their declared order.

2. Each step SHALL expose only its validated tool schema to the model.

3. Each step SHALL permit at most one tool invocation.

4. A missing, malformed, duplicate, or different tool call SHALL fail that step.

5. The gateway SHALL execute the tool through ORDERLY's existing typed capability and policy layer. The model SHALL NOT call an arbitrary URL or command merely because it placed one in plan text.

6. The harness SHALL enforce, outside the model:
   - a two-minute planning timeout;
   - a five-minute timeout for each step;
   - a two-minute synthesis timeout;
   - a fifteen-minute overall wall-clock timeout;
   - default `maxSteps` of four; and
   - hard `maxSteps` of five.

7. The overall deadline SHALL be checked before every step. A step that cannot begin within the deadline SHALL be recorded as skipped.

8. Tool or model failure SHALL be recorded for the affected step. The harness SHALL NOT conceal the failure or ask the model to decide whether a hard bound should be ignored.

9. The recursion guard SHALL remain active for every planner, step, and synthesis invocation.

### 3.5 Synthesis and trace

1. The final synthesis invocation SHALL have tool access disabled.

2. The synthesis instruction SHALL require the model to:
   - combine available findings;
   - distinguish successful, failed, and skipped steps;
   - state plainly when evidence is missing; and
   - avoid claiming that an unavailable step completed.

3. The harness SHALL synthesize available successful outputs even when one or more steps fail, unless policy requires total failure.

4. The returned trace SHALL include, for each step:
   - label;
   - requested tool;
   - actual tool used, if any;
   - status;
   - output length;
   - timeout or failure category; and
   - whether the step was skipped.

5. The trace SHALL include `modelRef`, `harnessRef`, `capabilityTier`, `planDisposition`, and `fallbackUsed`.

6. Trace metadata SHALL NOT expose credentials or raw secret-bearing tool output.

## 4. Configuration surface and validation

### 4.1 Required fields

1. Adding a provider for a local or operator-owned endpoint SHALL require:
   - `providerId`;
   - `baseUrl`;
   - `api`;
   - `auth`;
   - exact model `id`;
   - `contextWindow`;
   - `maxTokens`; and
   - `toolProtocol`.

2. Activating that model for a seat SHALL additionally require:
   - `model.primary`;
   - any explicit `model.fallbacks`;
   - `contextBudget`;
   - `capabilityTier`; and
   - `harnessRef` when `capabilityTier` is `chained-task`.

3. `harnessRef` SHALL be absent for `chat-research`.

4. The configuration validator SHALL reject `coding-lane` as a chat-seat `capabilityTier`.

5. A URL SHALL NOT contain embedded credentials. Authentication SHALL use the existing provider `auth` and credential-reference mechanism.

6. The common local-no-auth case SHALL use the existing no-auth representation. It SHALL NOT require a placeholder API key or a new secret type.

### 4.2 Configuration-time probe

1. ORDERLY SHALL probe every new or materially changed engine before it becomes active.

2. The probe SHALL originate from the gateway's runtime environment, not from the browser, because the gateway is the component that will invoke the endpoint.

3. The probe SHALL verify:
   - URL parsing and allowed scheme;
   - DNS or address resolution;
   - network reachability;
   - TLS validation when HTTPS is used;
   - declared API compatibility;
   - authentication acceptance;
   - availability of the exact configured model tag;
   - a minimal no-tool completion;
   - conformance with the declared output protocol; and
   - basic consistency of the declared token limits.

4. If `toolProtocol` is not `none`, the probe SHALL perform a harmless synthetic one-tool test and SHALL reject zero, multiple, or malformed tool calls when exactly one is requested.

5. A `chained-task` probe SHALL additionally run a side-effect-free synthetic plan, validation, one-tool execution, and no-tool synthesis through the selected `harnessRef`.

6. Probe tools SHALL be dedicated no-side-effect test capabilities. A configuration probe SHALL NOT perform web research, access memory, dispatch code, send mail, or invoke an agent's production tools.

7. A successful probe SHALL establish connectivity and protocol compatibility only. The UI SHALL NOT describe it as a general quality benchmark or frontier-model equivalence test.

8. Probe failure SHALL prevent the proposed binding from becoming active.

9. A failed edit MAY remain as an explicitly inactive draft. The previously active binding SHALL remain unchanged.

10. Probe failure SHALL NOT cause ORDERLY to activate or test-drive a different engine as a substitute.

11. A probe error SHALL identify in plain English:
    - the sanitized endpoint tried;
    - the API mode;
    - the exact model tag;
    - the failed probe stage;
    - the observed status or protocol mismatch; and
    - whether the existing active configuration was retained.

12. Probe errors and logs SHALL redact credentials, authorization headers, and secret-bearing response bodies.

### 4.3 Settings write gates

1. Local-engine editing SHALL use the existing settings architecture:
   - a typed browser-to-gateway envelope;
   - an explicit changed-path allowlist;
   - guarded-subtree deep-equality checks; and
   - gateway-side validation before persistence.

2. Arbitrary browser-supplied configuration paths SHALL remain impossible.

3. `baseUrl`, `api`, `auth`, `capabilityTier`, and `harnessRef` SHALL use a dedicated `engine-definition` edit class rather than the ordinary model-tag-only edit class.

4. The dedicated edit class SHALL be required because:
   - `baseUrl` controls gateway outbound traffic;
   - `api` changes protocol interpretation;
   - `auth` changes credential behavior; and
   - `capabilityTier` and `harnessRef` change execution policy.

5. Existing model-choice and model-tag editing MAY remain ordinary editable configuration within its current explicit allowlist.

6. `contextWindow`, `maxTokens`, and `contextBudget` MAY be edited through the engine-definition operation, but SHALL be range-checked and probed before activation.

7. Existing deep-equality protection SHALL remain in force for:
   - the gateway block;
   - channels;
   - bindings;
   - tool policy;
   - every agent's sandbox;
   - every agent's tools;
   - every agent's workspace; and
   - every existing provider credential reference.

8. Adding or changing an engine SHALL NOT provide a path to change any protected subtree listed above.

9. The UI SHALL continue to receive only a credential environment-variable name and whether it is set. It SHALL never receive the credential value.

10. A provider requiring authentication SHALL use the existing credential-reference process. The engine-definition operation SHALL NOT create, reveal, or accept raw credential values.

**Choice and tradeoff:** Endpoint and tier edits receive their own guarded operation rather than being treated like ordinary model-tag changes. This adds friction to local endpoint setup, but it prevents a compromised browser surface from converting a benign model edit into arbitrary gateway egress or a capability escalation.

## 5. Composition with named agents

### 5.1 Manifest extension

1. `docs/SPEC-NAMED-AGENTS-FUGU-2026-08-21.md` SHALL be extended with a per-agent `engine` field if that specification is approved.

2. The `engine` field SHALL contain only non-secret binding information:
   - `model.primary`;
   - `model.fallbacks`;
   - `contextBudget`;
   - `capabilityTier`; and
   - `harnessRef`, when required.

3. Provider endpoint, API mode, physical context limit, and authentication SHALL continue to resolve from `models.providers`. They SHALL NOT be duplicated in the identity manifest.

4. The gateway projection for a named agent SHALL match the manifest's effective `engine` binding. ORDERLY SHALL NOT maintain two independently editable engine choices for the same identity.

5. An absent named-agent `engine` field SHALL mean inheritance from `agents.defaults`; it SHALL NOT mean automatic local-model selection.

6. A named identity SHALL not own provider credentials. Its engine field SHALL only reference configured provider-qualified models and approved harnesses.

**Choice and tradeoff:** The named-agent manifest gains a non-secret `engine` binding rather than embedding a provider block. This makes model choice part of the named identity's declared operation while preserving the gateway as the sole owner of endpoint and credential configuration. The tradeoff is that resolving a manifest requires access to the gateway's provider registry.

### 5.2 Simultaneous engines

1. Different named agents MAY use different providers, model tags, context budgets, tiers, and approved harnesses simultaneously.

2. One agent MAY use a local 7B-class endpoint while another uses the existing Ollama Cloud provider.

3. An endpoint failure affecting one agent SHALL NOT cause another agent's binding to change.

4. Provider-specific concurrency or rate limits SHALL be enforced per resolved provider without merging agent identities or memories.

5. Web UI and optional Telegram attachments SHALL show the engine and tier of the named agent actually receiving the message.

### 5.3 Independence from identity policy

1. Choosing a 7B-class engine SHALL NOT alter the named agent's:
   - `id`;
   - `handle`;
   - `runtimeProfile`;
   - `policyRef`;
   - `policyRevision`;
   - `capabilityBindings`;
   - delegation allowlist;
   - `memoryPolicy`; or
   - lifecycle state.

2. `runtimeProfile` SHALL remain a sandbox, network, credential, and mount profile. It SHALL NOT become a model-selection field.

3. Engine selection SHALL NOT grant a tool, delegation target, mount, network path, or credential absent from the existing identity policy.

4. A chained-task harness SHALL take the intersection of the agent's tool profile, `capabilityBindings`, standing policy, and `sequencerEligible` capabilities. It SHALL NOT broaden any of them.

5. Changing engines SHALL NOT erase, migrate, reinterpret, or merge an agent's persistent memory.

6. The selected `contextBudget` MAY limit how much memory is injected into one invocation. Any compaction or omission SHALL follow the existing memory policy and SHALL be disclosed where that policy requires.

7. Activating, suspending, or archiving a named agent SHALL NOT start, stop, download, or delete the endpoint's model process or weights.

8. If a named agent's endpoint is unavailable, the identity MAY remain active with engine status `unavailable`. ORDERLY SHALL report the outage rather than silently moving the identity to an unconfigured engine.

9. The 2026-08-21 ruling remains unchanged: named-agent chats SHALL be hosted natively in the web UI by default, with Telegram as an optional per-agent attachment. Engine choice SHALL be independent of channel attachment.

## 6. Explicit anti-goals

This specification:

- [ ] **SHALL NOT make ORDERLY a model runtime.** ORDERLY SHALL NOT install Ollama, install llama.cpp, download weights, update weights, quantize models, allocate inference devices, or serve model inference. An engine always means an endpoint the operator already runs or deliberately subscribes to.

- [ ] **SHALL NOT overpromise small-model capability.** A 7B-class engine SHALL NOT be described as equivalent to a frontier engine merely because it responds to the same API or supports function-call syntax.

- [ ] **SHALL NOT attribute chained capability to a bare 7B model.** `chained-task` SHALL always identify the approved `(modelRef, harnessRef)` pair.

- [ ] **SHALL NOT expose coding/lane capability through chat configuration.** Selecting a weaker engine for any chat or named agent SHALL never make the broker coding lane reachable as that engine's tier.

- [ ] **SHALL NOT alter the credential model for common local endpoints.** A no-auth local endpoint SHALL remain no-auth. A genuinely authenticated operator-owned endpoint SHALL use the existing credential-reference mechanism.

- [ ] **SHALL NOT place credential values in the UI, named-agent manifest, response metadata, traces, or probe errors.**

- [ ] **SHALL NOT modify, loosen, parameterize, or add fallback behavior to `broker/seat.mjs`.** Its command, model identity, reasoning effort, environment restriction, self-reported identity check, and `fallback_authorized: false` posture remain outside this specification.

- [ ] **SHALL NOT modify or generalize `broker/allowlist.json5`.** It SHALL NOT add model template substitution, local-model presets, generated argv elements, or a `{model}`-style placeholder.

- [ ] **SHALL NOT treat the gateway harness as part of the coding broker.** `bounded-sequencer-v1` SHALL remain a chat/agent orchestration facility.

- [ ] **SHALL NOT break the existing identity split.** `orderly-web` SHALL continue to have no provider credential values or model secrets. The gateway SHALL remain the sole owner of provider credentials and model invocation configuration.

- [ ] **SHALL NOT grant capabilities through engine selection.** Changing `model.primary`, `capabilityTier`, or `harnessRef` SHALL NOT modify tool policy, delegation authorization, sandboxing, mounts, memory policy, or standing orders.

- [ ] **SHALL NOT silently change an existing agent's engine.** The current cloud defaults SHALL continue to work with the same provider-qualified model selections and fallback order unless the operator deliberately changes that agent or the defaults.

- [ ] **SHALL NOT silently substitute another engine after configuration or probe failure.** A failed proposed configuration SHALL remain inactive, and the prior active configuration SHALL be retained and identified.

- [ ] **SHALL NOT hide partial chained-task execution.** Failed, skipped, fallback, and timed-out steps SHALL be visible in the result trace.

- [ ] **SHALL NOT claim that configuration-time probing proves general model quality.** Probing establishes endpoint, protocol, model-tag, tool-call, and harness compatibility only.
