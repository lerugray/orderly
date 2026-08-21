// ORDERLY seat engines — resolving, classifying and probing the model endpoint
// a chat seat thinks with, including a small model on the operator's own box.
//
// The spec this implements is docs/SPEC-LOCAL-MODEL-SEATS-FUGU-2026-08-21.md.
// Three ideas carry the whole file, and each is a refusal to be convenient:
//
//   1. AN ENGINE IS A RESOLVED BINDING, NOT A NEW REGISTRY. The endpoint, its
//      API mode, its credential reference and every model tag stay in the
//      gateway's own `models.providers` — the same place a cloud provider has
//      always lived. A "local model" is a provider whose baseUrl happens to be
//      on the operator's LAN. There is no second registry, so there is no
//      second place for an endpoint to be wrong.
//
//   2. A TIER IS AN ENFORCED CEILING, NOT A LABEL. `capabilityTier` says what
//      the seat is allowed to be asked to do. A model cannot promote itself by
//      claiming to be capable, and ORDERLY never quietly does less than was
//      asked and calls it done: an operation past the ceiling is refused in
//      plain English, naming what was asked, what the ceiling is, what is
//      missing and what the operator can do about it. Where the ceiling sits
//      is worth being exact about — every boundary ORDERLY owns (the chat
//      path, this gate, configuration time, probe time). ORDERLY does not
//      police the gateway's own agent loop, which is a third-party package;
//      inside a turn, the per-agent tool policy in openclaw.json is still the
//      wall it always was. The tier's guarantee is that nothing here STARTS an
//      operation past a seat's ceiling, and that the ceiling cannot be raised
//      by a model asserting that it should be.
//
//   3. AN UNCLASSIFIED SEAT IS LEFT ALONE. A station with no engine overlay
//      behaves exactly as it did before this file existed. Tiers bind only
//      where the operator has written one down, because inferring a weaker
//      tier for a working seat would remove behavior nobody asked to lose.
//
// Two files, one fact in each. The gateway's `openclaw.json` owns endpoints,
// credentials and model choice. ORDERLY's own `~/.orderly/engines.json` owns
// the things the gateway has no concept of: which tier a model is qualified
// for, what tool protocol it actually speaks, and each seat's effective
// context budget. Nothing is editable in both places.
//
// No credential VALUE is read, returned, logged or written anywhere in here,
// and none is ever attached to a request. The desk holds no provider
// credentials at all — only the gateway bearer, which is operator-equivalent —
// so a provider that declares a credential is not probed from here: the
// credentialed check belongs to the gateway (spec §4.2.2), the component that
// actually invokes the endpoint and owns the key, and this file defers to it
// with an honest message rather than reading a caller-named variable and
// sending it to a caller-named address.

import { readFile, writeFile, rename, open, mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const ENGINES_CONFIG_VERSION = 1;

// The tiers, in ascending order of what they permit.
export const TIERS = Object.freeze(["chat-research", "chained-task", "coding-lane"]);

// The operation classes the gateway checks a request against before it invokes
// anything. These are typed boundaries, not an attempt to classify prose.
export const OPERATION_CLASSES = Object.freeze([
  "chat",
  "singleStepTool",
  "chainedTask",
  "codingLane",
]);

const TIER_OPERATIONS = Object.freeze({
  "chat-research": Object.freeze(["chat", "singleStepTool"]),
  "chained-task": Object.freeze(["chat", "singleStepTool", "chainedTask"]),
  // Never reachable as a seat tier — see SELECTABLE_TIERS. Present so that the
  // table is total and a future reader does not read the omission as an
  // oversight.
  "coding-lane": Object.freeze([]),
});

// What an operator may write in `capabilityTier`. `coding-lane` is deliberately
// absent: it names the dispatch broker's separate, pinned, exact-seat lane, and
// this file has no path to it. Selecting a weaker engine for a chat seat must
// never be a way to reach it, so the configuration validator refuses the word
// rather than accepting it and hoping the runtime check holds.
export const SELECTABLE_TIERS = Object.freeze(["chat-research", "chained-task"]);

// A harness is a non-model orchestration facility owned by ORDERLY. A tier that
// needs one is the (modelRef, harnessRef) PAIR — never the bare model.
//
// `bounded-sequencer-v1` is specified in §3 and is not built in this build.
// It is declared here rather than omitted so that a config naming it gets a
// straight answer about what is missing, instead of a config error that reads
// like a typo — and so that nothing can silently behave as though a plan/gate/
// bounded-execute/synthesize loop existed when it does not.
export const HARNESSES = Object.freeze({
  "bounded-sequencer-v1": Object.freeze({
    ref: "bounded-sequencer-v1",
    available: false,
    note: "Specified in the local-model-seats spec §3; not built in this release. Chained-task seats cannot be activated until it is.",
  }),
});

// A model entry declares what it speaks. It is never inferred from a model
// name or a parameter count, because a 7B that emits function-call-shaped text
// is not the same thing as a 7B that reliably emits exactly one tool call.
export const TOOL_PROTOCOLS = Object.freeze(["none", "openai-tools"]);

// The only API mode this build knows how to speak and therefore the only one it
// will claim to have probed.
export const PROBE_ABLE_APIS = Object.freeze(["openai-completions"]);

export const PROBE_STAGES = Object.freeze([
  "url",
  "reachability",
  "auth",
  "api",
  "model-tag",
  "completion",
  "protocol",
  "limits",
  "tools",
  "harness",
]);

export const PROBE_TIMEOUT_MS = 30_000;
// A probe asks for a handful of tokens. Anything larger is not the answer to
// the question being asked, and reading it would only be a way to be surprised.
const MAX_PROBE_BYTES = 256 * 1024;
const PROBE_COMPLETION_TOKENS = 16;

const PROVIDER_ID = /^[A-Za-z0-9_-]+$/;
const MODEL_TAG = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,119}$/;
const SEAT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class EngineRefused extends Error {}
const refuse = (msg) => {
  throw new EngineRefused(msg);
};

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// sanitising an endpoint for display
// ---------------------------------------------------------------------------

// Everything an operator needs to recognise the endpoint, and nothing that
// could carry a secret: userinfo, query and fragment are dropped rather than
// masked, because a masked secret is still a secret that travelled.
export function sanitizeUrl(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const port = url.port ? `:${url.port}` : "";
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.hostname}${port}${path}`;
}

function urlProblem(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "has no address";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "isn't a readable web address";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `uses ${url.protocol.replace(":", "")}, and only http and https can be reached`;
  }
  // §4.1.5. A key in a URL ends up in logs, error text and shoulder-surfing
  // distance of a browser address bar; the provider's credential reference is
  // the one place a credential is named.
  if (url.username || url.password) {
    return "carries a credential in the address itself, which this station will not store — use the provider's credential reference";
  }
  return null;
}

function endpointBase(baseUrl) {
  return String(baseUrl).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// the overlay: ORDERLY's own half of an engine
// ---------------------------------------------------------------------------

export function emptyOverlay() {
  return { version: ENGINES_CONFIG_VERSION, models: {}, seats: {} };
}

// Reads the sidecar. A missing file is not an error and not a default: it means
// this station has no engine overlay, every seat is unclassified, and nothing
// about the station's behavior changes.
export async function readEngineConfig({ path }) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { present: false, path, overlay: emptyOverlay(), error: null };
    return {
      present: false,
      path,
      overlay: emptyOverlay(),
      error: "The engine file exists but this desk's identity cannot read it.",
    };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return {
      present: true,
      path,
      overlay: emptyOverlay(),
      error: "The engine file isn't readable as JSON. No seat was reclassified; every seat is being treated as unclassified.",
    };
  }
  return { present: true, path, overlay: normaliseOverlay(doc), error: null };
}

// Shape-only normalisation. It fills in absent containers so the rest of the
// file can read without guarding; it never invents a tier, a budget or a
// protocol, because each of those is a claim about capability.
function normaliseOverlay(doc) {
  const out = emptyOverlay();
  if (!isObj(doc)) return out;
  out.version = doc.version;
  if (isObj(doc.models)) out.models = doc.models;
  if (isObj(doc.seats)) out.seats = doc.seats;
  return out;
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

function splitRef(ref) {
  if (typeof ref !== "string") return null;
  const cut = ref.indexOf("/");
  if (cut <= 0 || cut === ref.length - 1) return null;
  return { providerId: ref.slice(0, cut), modelId: ref.slice(cut + 1) };
}

// The provider-and-model half of an engine, straight out of the gateway's
// registry. Returns null when the reference names something the station doesn't
// have configured — the caller decides whether that is a refusal or a finding.
export function resolveModelRef(gatewayConfig, ref) {
  const split = splitRef(ref);
  if (!split) return null;
  const provider = gatewayConfig?.models?.providers?.[split.providerId];
  if (!isObj(provider)) return null;
  const models = Array.isArray(provider.models) ? provider.models : [];
  const entry = models.find((m) => m?.id === split.modelId);
  if (!isObj(entry)) return null;
  const apiKeyEnv = typeof provider?.apiKey?.id === "string" ? provider.apiKey.id : null;
  return {
    ref,
    providerId: split.providerId,
    modelId: split.modelId,
    baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : null,
    api: provider.api ?? null,
    // "none" is a real answer, not a missing one: a local endpoint that wants
    // no key is the common case and gets no placeholder.
    auth: provider.auth ?? "none",
    apiKeyEnv,
    contextWindow: Number.isInteger(entry.contextWindow) ? entry.contextWindow : null,
    maxTokens: Number.isInteger(entry.maxTokens) ? entry.maxTokens : null,
    name: typeof entry.name === "string" ? entry.name : null,
  };
}

function seatOverlay(overlay, seatId) {
  const seats = overlay?.seats ?? {};
  if (isObj(seats[seatId])) return { record: seats[seatId], from: "seat" };
  if (isObj(seats.defaults)) return { record: seats.defaults, from: "defaults" };
  return { record: null, from: null };
}

function modelOverlay(overlay, ref) {
  const record = overlay?.models?.[ref];
  return isObj(record) ? record : null;
}

// The seat's model choice, out of the gateway config alone.
//
// A per-agent `model` block REPLACES the default block rather than merging with
// it. A partial merge would let an operator who deliberately pointed one seat at
// their own box inherit cloud fallbacks they never paired with it — which is
// exactly the silent cross-endpoint move §1.3.2 forbids. So an agent that names
// a primary and no fallbacks has no fallbacks.
function seatModelChoice(gatewayConfig, seatId) {
  const defaults = gatewayConfig?.agents?.defaults?.model ?? {};
  const list = Array.isArray(gatewayConfig?.agents?.list) ? gatewayConfig.agents.list : [];
  const agent = list.find((a) => a?.id === seatId);
  const own = isObj(agent?.model) ? agent.model : null;
  const block = own ?? defaults;
  return {
    exists: Boolean(agent) || seatId === "defaults",
    source: own ? "seat" : "defaults",
    primary: typeof block?.primary === "string" ? block.primary : null,
    fallbacks: Array.isArray(block?.fallbacks) ? block.fallbacks.filter((r) => typeof r === "string") : [],
  };
}

// The whole engine for one seat: the gateway's endpoint facts, ORDERLY's
// classification, and an honest account of what is missing. Throws only when
// the seat cannot be resolved at all; a seat with no classification resolves
// fine and comes back `classified: false`.
export function resolveSeatEngine({ gatewayConfig, overlay, seatId }) {
  if (typeof seatId !== "string" || !SEAT_ID.test(seatId)) refuse("That isn't a seat name this station uses.");
  const choice = seatModelChoice(gatewayConfig, seatId);
  if (!choice.exists) refuse(`There is no "${seatId}" seat in the gateway config.`);
  if (!choice.primary) refuse(`The "${seatId}" seat has no model chosen, and this station does not pick one for it.`);

  const primary = resolveModelRef(gatewayConfig, choice.primary);
  if (!primary) {
    refuse(
      `The "${seatId}" seat names ${choice.primary}, which this station doesn't have configured as a provider and model.`,
    );
  }

  const { record, from } = seatOverlay(overlay, seatId);
  const declared = modelOverlay(overlay, choice.primary);

  const fallbacks = choice.fallbacks.map((ref) => {
    const resolved = resolveModelRef(gatewayConfig, ref);
    const fallbackDeclared = modelOverlay(overlay, ref);
    return {
      ref,
      resolved: Boolean(resolved),
      contextWindow: resolved?.contextWindow ?? null,
      maxTokens: resolved?.maxTokens ?? null,
      baseUrl: resolved?.baseUrl ?? null,
      api: resolved?.api ?? null,
      auth: resolved?.auth ?? null,
      apiKeyEnv: resolved?.apiKeyEnv ?? null,
      toolProtocol: typeof fallbackDeclared?.toolProtocol === "string" ? fallbackDeclared.toolProtocol : null,
      tiers: Array.isArray(fallbackDeclared?.tiers) ? fallbackDeclared.tiers : [],
    };
  });

  return {
    seatId,
    modelSource: choice.source,
    classificationSource: from,
    classified: Boolean(record),
    modelRef: choice.primary,
    providerId: primary.providerId,
    modelId: primary.modelId,
    modelName: primary.name,
    baseUrl: primary.baseUrl,
    endpoint: sanitizeUrl(primary.baseUrl),
    api: primary.api,
    auth: primary.auth,
    apiKeyEnv: primary.apiKeyEnv,
    contextWindow: primary.contextWindow,
    maxTokens: primary.maxTokens,
    contextBudget: Number.isInteger(record?.contextBudget) ? record.contextBudget : null,
    capabilityTier: typeof record?.capabilityTier === "string" ? record.capabilityTier : null,
    harnessRef: typeof record?.harnessRef === "string" ? record.harnessRef : null,
    toolProtocol: typeof declared?.toolProtocol === "string" ? declared.toolProtocol : null,
    qualifiedTiers: Array.isArray(declared?.tiers) ? declared.tiers : [],
    fallbacks,
  };
}

// §2.5.1 — everything the operator is owed at configuration time, and not one
// field that could carry a credential.
export function describeEngine(binding) {
  return {
    seat: binding.seatId,
    provider: binding.providerId,
    endpoint: binding.endpoint,
    model: binding.modelId,
    modelRef: binding.modelRef,
    api: binding.api,
    auth: binding.auth,
    // The NAME of the variable and whether the operator has to set one. Never
    // a value, and never a presence check that needed to read one.
    credentialRef: binding.apiKeyEnv,
    contextWindow: binding.contextWindow,
    contextBudget: binding.contextBudget,
    maxTokens: binding.maxTokens,
    toolProtocol: binding.toolProtocol ?? "undeclared",
    capabilityTier: binding.capabilityTier ?? "unclassified",
    harnessRef: binding.harnessRef ?? null,
    classified: binding.classified,
    fallbacks: binding.fallbacks.map((f) => ({
      modelRef: f.ref,
      endpoint: sanitizeUrl(f.baseUrl),
      resolved: f.resolved,
      toolProtocol: f.toolProtocol ?? "undeclared",
      qualifiedTiers: f.tiers,
    })),
  };
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function problem(where, message) {
  return { where, message };
}

// §4.1, §1.2.7, §1.3. Every problem is a sentence an operator can act on, and
// the list is exhaustive rather than first-failure, because fixing one field at
// a time across a round trip each is not a configuration experience.
export function validateEngineConfig({ overlay, gatewayConfig }) {
  const problems = [];

  if (overlay?.version !== ENGINES_CONFIG_VERSION) {
    problems.push(
      problem(
        "version",
        `This build reads version ${ENGINES_CONFIG_VERSION} of the engine file; that one says ${JSON.stringify(overlay?.version ?? null)}.`,
      ),
    );
  }

  for (const [ref, record] of Object.entries(overlay?.models ?? {})) {
    const where = `models["${ref}"]`;
    if (!isObj(record)) {
      problems.push(problem(where, "should be an object holding toolProtocol and tiers."));
      continue;
    }
    for (const key of Object.keys(record)) {
      if (!["toolProtocol", "tiers", "note"].includes(key)) {
        problems.push(problem(where, `"${key}" isn't something a model declaration holds.`));
      }
    }
    const split = splitRef(ref);
    if (!split || !PROVIDER_ID.test(split.providerId) || !MODEL_TAG.test(split.modelId)) {
      problems.push(problem(where, "isn't a provider-and-model reference, which looks like provider/model-tag."));
    } else if (gatewayConfig && !resolveModelRef(gatewayConfig, ref)) {
      problems.push(problem(where, "names a provider and model this station doesn't have configured."));
    }
    if (!TOOL_PROTOCOLS.includes(record.toolProtocol)) {
      problems.push(
        problem(
          where,
          `needs toolProtocol set to one of ${TOOL_PROTOCOLS.join(", ")}. This station never guesses it from a model's name or size.`,
        ),
      );
    }
    const tiers = record.tiers;
    if (!Array.isArray(tiers) || !tiers.length) {
      problems.push(problem(where, "needs a tiers list saying which tiers this model has been reviewed for."));
    } else {
      for (const tier of tiers) {
        if (tier === "coding-lane") {
          problems.push(
            problem(
              where,
              "cannot be qualified for coding-lane. That names the dispatch broker's own pinned seat, and nothing configured here can reach it.",
            ),
          );
        } else if (!SELECTABLE_TIERS.includes(tier)) {
          problems.push(problem(where, `"${tier}" isn't a tier. The tiers are ${SELECTABLE_TIERS.join(" and ")}.`));
        }
      }
    }
  }

  for (const [seatId, record] of Object.entries(overlay?.seats ?? {})) {
    const where = `seats.${seatId}`;
    if (seatId !== "defaults" && !SEAT_ID.test(seatId)) {
      problems.push(problem(where, "isn't a seat name this station uses."));
      continue;
    }
    if (!isObj(record)) {
      problems.push(problem(where, "should be an object holding capabilityTier and contextBudget."));
      continue;
    }
    for (const key of Object.keys(record)) {
      if (!["capabilityTier", "contextBudget", "harnessRef", "note"].includes(key)) {
        problems.push(problem(where, `"${key}" isn't something a seat classification holds.`));
      }
    }

    const tier = record.capabilityTier;
    if (tier === "coding-lane") {
      // §2.4.2 and the anti-goal that matters most in this file.
      problems.push(
        problem(
          where,
          "cannot be set to coding-lane. That tier names the dispatch broker's separate, pinned coding seat; a chat seat is never it, whatever engine it runs.",
        ),
      );
    } else if (!SELECTABLE_TIERS.includes(tier)) {
      problems.push(
        problem(where, `needs capabilityTier set to ${SELECTABLE_TIERS.map((t) => `"${t}"`).join(" or ")}.`),
      );
    }

    if (tier === "chat-research" && record.harnessRef !== undefined) {
      problems.push(problem(where, "is chat-research, which runs no harness, so it must not name a harnessRef."));
    }
    if (tier === "chained-task") {
      const harness = HARNESSES[record.harnessRef];
      if (!record.harnessRef) {
        problems.push(
          problem(
            where,
            "is chained-task, which is always a model AND a harness together, so it must name a harnessRef.",
          ),
        );
      } else if (!harness) {
        problems.push(problem(where, `names harness "${record.harnessRef}", which this station doesn't have.`));
      } else if (!harness.available) {
        // The honest error the milestone split demands: not a stub, not a
        // silent downgrade to chat-research, and not a pretend chain.
        problems.push(problem(where, `names harness "${harness.ref}". ${harness.note}`));
      }
    }

    if (record.contextBudget !== undefined) {
      if (!Number.isInteger(record.contextBudget) || record.contextBudget < 1) {
        problems.push(problem(where, "has a contextBudget that isn't a positive whole number of tokens."));
      }
    }

    if (!gatewayConfig) continue;

    let binding;
    try {
      binding = resolveSeatEngine({ gatewayConfig, overlay, seatId: seatId === "defaults" ? "defaults" : seatId });
    } catch (err) {
      problems.push(problem(where, err instanceof EngineRefused ? err.message : "couldn't be resolved."));
      continue;
    }

    problems.push(...bindingProblems(where, binding, tier));
  }

  return { ok: problems.length === 0, problems };
}

// The checks that need the resolved binding: budgets against the real context
// window, and fallback parity.
function bindingProblems(where, binding, tier) {
  const problems = [];

  if (!Number.isInteger(binding.contextWindow) || binding.contextWindow < 1) {
    problems.push(
      problem(where, `runs ${binding.modelRef}, whose model entry declares no contextWindow, so no budget can be checked against it.`),
    );
  }

  const budget = binding.contextBudget;
  const window = binding.contextWindow;
  const reserved = binding.maxTokens ?? 0;
  if (Number.isInteger(budget) && Number.isInteger(window)) {
    // §1.1.5 and §1.3.7 — the effective budget is a limit under the physical
    // one, and the reply has to fit beside the question.
    if (budget > window) {
      problems.push(
        problem(where, `sets a contextBudget of ${budget} tokens on a model whose context window is ${window}.`),
      );
    } else if (budget + reserved > window) {
      problems.push(
        problem(
          where,
          `sets a contextBudget of ${budget} tokens and reserves ${reserved} for the reply, which is ${budget + reserved} against a ${window}-token window.`,
        ),
      );
    }
  }

  if (SELECTABLE_TIERS.includes(tier)) {
    if (!binding.qualifiedTiers.includes(tier)) {
      // §1.2.7 — a tier is a reviewed classification of a specific model, not
      // an assertion made about a seat in passing.
      problems.push(
        problem(
          where,
          `is set to ${tier}, but ${binding.modelRef} has not been declared as qualified for it. Add it to that model's tiers in the engine file.`,
        ),
      );
    }
    if (binding.toolProtocol === null) {
      problems.push(problem(where, `runs ${binding.modelRef}, which has no toolProtocol declared.`));
    }
    for (const fallback of binding.fallbacks) {
      if (!fallback.resolved) {
        problems.push(problem(where, `lists fallback ${fallback.ref}, which this station doesn't have configured.`));
        continue;
      }
      // §1.3.5 — a fallback qualified only for less is a silent downgrade
      // waiting for the primary to have a bad afternoon.
      if (!fallback.tiers.includes(tier)) {
        problems.push(
          problem(
            where,
            `lists fallback ${fallback.ref}, which isn't qualified for ${tier}. A fallback that can do less would quietly lower what the seat can do at the worst moment.`,
          ),
        );
      }
      if (fallback.toolProtocol === null) {
        problems.push(problem(where, `lists fallback ${fallback.ref}, which has no toolProtocol declared.`));
      }
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// the tier gate
// ---------------------------------------------------------------------------

// §2.5.6. A refusal names the operation, the ceiling, the missing piece and one
// thing the operator can do — and it is a refusal, never a smaller thing done
// quietly and reported as the thing asked for.
export function checkOperation({ binding, operationClass }) {
  if (!OPERATION_CLASSES.includes(operationClass)) {
    return {
      allowed: false,
      refusal: {
        requested: String(operationClass),
        activeTier: binding?.capabilityTier ?? "unclassified",
        missing: "a known operation class",
        nextAction: `Ask for one of ${OPERATION_CLASSES.join(", ")}.`,
        message: `"${String(operationClass)}" isn't an operation this station recognises.`,
      },
    };
  }

  if (operationClass === "codingLane") {
    // Structurally unreachable from here: no chat tier lists it, and the
    // broker's lane is a different door with its own authorisation.
    return {
      allowed: false,
      refusal: {
        requested: "codingLane",
        activeTier: binding?.capabilityTier ?? "unclassified",
        missing: "coding-lane authorisation, which no chat seat has",
        nextAction: "Dispatch through the orchestration desk, which is the only path to a coding lane and is reviewed by you.",
        message:
          "A coding lane can't be run from a chat seat. That lane is a separate, pinned seat behind the dispatch broker, and choosing any engine here never becomes a way in.",
      },
    };
  }

  // An unclassified seat is a station that predates this file. It keeps
  // working, and it does not gain a ceiling it was never given.
  if (!binding?.classified || !binding?.capabilityTier) {
    return { allowed: true, tier: null, unclassified: true };
  }

  // A seat classified `coding-lane` is in an invalid state: that tier is not
  // selectable (SELECTABLE_TIERS, the config validator and the typed edit all
  // refuse it) and names the dispatch broker's own pinned seat, which no chat
  // seat is. However one got written, it runs nothing — so it gets its OWN
  // accurate refusal rather than the chat-research chained-task text below,
  // which would falsely tell the operator this seat "can answer, and it can use
  // one tool in a turn" when a coding-lane seat can do neither.
  if (binding.capabilityTier === "coding-lane") {
    return {
      allowed: false,
      refusal: {
        requested: operationClass,
        activeTier: "coding-lane",
        missing: "a valid chat-seat tier; coding-lane is not one",
        nextAction:
          "Reclassify this seat as chat-research, or clear its classification. The coding lane is the dispatch broker's own pinned seat and is never reached from a chat seat.",
        message:
          "This seat is classified coding-lane, which is not a tier a chat seat can run — it names the dispatch broker's separate, pinned seat, and no chat, tool, or chained operation runs from a seat in this state.",
      },
    };
  }

  const tier = binding.capabilityTier;
  const permitted = TIER_OPERATIONS[tier] ?? [];
  if (!permitted.includes(operationClass)) {
    const missing =
      operationClass === "chainedTask"
        ? "a chained-task harness, which this seat has not been given"
        : `${operationClass} on the ${tier} tier`;
    return {
      allowed: false,
      refusal: {
        requested: operationClass,
        activeTier: tier,
        missing,
        nextAction:
          operationClass === "chainedTask"
            ? "Ask for one step at a time, or classify a seat whose engine has an approved harness."
            : "Ask for something within this seat's tier, or classify the seat higher after reviewing the engine.",
        message:
          operationClass === "chainedTask"
            ? `This seat is ${tier}: it can answer, and it can use one tool in a turn, but it has no harness to run a multi-step chain. It will not run part of one and call it done.`
            : `This seat is ${tier} and can't be asked to ${operationClass}.`,
      },
    };
  }

  // §2.2.5 — a model that speaks no tool protocol can chat, and says plainly
  // that tools are unavailable rather than pretending to have tried one.
  if (operationClass === "singleStepTool" && binding.toolProtocol !== "openai-tools") {
    return {
      allowed: false,
      refusal: {
        requested: "singleStepTool",
        activeTier: tier,
        missing: "a tool protocol on this engine",
        nextAction: "Ask this seat a question it can answer directly, or point it at an engine that speaks a tool protocol.",
        message: `This seat's engine is declared as speaking no tool protocol${binding.toolProtocol === null ? " — nothing has been declared for it at all" : ""}, so tools are unavailable to it.`,
      },
    };
  }

  return { allowed: true, tier, unclassified: false };
}

// ---------------------------------------------------------------------------
// the configuration-time probe
// ---------------------------------------------------------------------------

function stage(name, ok, detail) {
  return { stage: name, ok, detail };
}

function failure(stages, name, detail, message) {
  stages.push(stage(name, false, detail));
  return { ok: false, stages, failedStage: name, message };
}

// Why a fetch failed, in words, from the error the platform gave us — never the
// error's own text, which can carry a URL with anything in it.
function reachabilityDetail(err) {
  const code = err?.cause?.code || err?.code || "";
  if (err?.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT") return "nothing answered in time";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "that host name doesn't resolve from this box";
  if (code === "ECONNREFUSED") return "the address resolved but nothing is listening there";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "there's no route to that address from this box";
  if (String(code).startsWith("CERT_") || String(code).startsWith("DEPTH_") || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return "the HTTPS certificate didn't check out";
  }
  return "the connection failed";
}

async function readCapped(response) {
  const text = await response.text();
  if (text.length > MAX_PROBE_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// §4.2. Runs from this process — which sits on the gateway's host, in the
// gateway's network position — never from the browser, because the browser is
// not the thing that will have to reach the endpoint.
//
// `binding` may be a resolved seat engine or a proposed one that is not in any
// config yet: this function reads no files and holds no state, so a proposal
// can be probed before it is written anywhere.
export async function probeEngine({
  binding,
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const stages = [];
  const endpoint = sanitizeUrl(binding?.baseUrl) ?? "(no address)";

  // 1 — url
  const urlIssue = urlProblem(binding?.baseUrl);
  if (urlIssue) {
    return failure(stages, "url", urlIssue, `The endpoint ${urlIssue}.`);
  }
  stages.push(stage("url", true, endpoint));

  const base = endpointBase(binding.baseUrl);

  // §4.2.2 and the identity split (README; spec §6): the desk holds no provider
  // credentials — only the gateway bearer, which is operator-equivalent — so it
  // NEVER reads an environment variable to build an Authorization header and
  // NEVER attaches one to a request. A provider that declares a credential is
  // therefore not probed from here at all: the gateway, which owns the key and
  // is the component that will invoke the endpoint, verifies it at activation.
  // This is the whole defence against a proposal naming BOTH a variable to read
  // and an address to send it to — there is no read-and-send path to abuse.
  if (binding.auth && binding.auth !== "none") {
    // A chained-task's missing harness is a definitive LOCAL fact and is worth
    // surfacing over the deferral, so a config error still reads like one.
    if (binding.capabilityTier === "chained-task") {
      const harness = HARNESSES[binding.harnessRef];
      return failure(
        stages,
        "harness",
        binding.harnessRef ? `${binding.harnessRef} unavailable` : "no harness named",
        harness
          ? harness.note
          : `The seat names harness "${binding.harnessRef}", which this station doesn't have.`,
      );
    }
    stages.push(stage("auth", true, "deferred to the gateway"));
    return {
      ok: true,
      deferred: true,
      stages,
      failedStage: null,
      message: `${endpoint} declares a credential${binding.apiKeyEnv ? ` (${binding.apiKeyEnv})` : ""}. This desk holds no provider credentials by design, so it reads none and attaches none to a request; the gateway verifies the credential, reachability, the model tag and a completion when it activates the binding.`,
      endpoint,
    };
  }

  // From here the provider declares no credential, so every request goes without
  // an Authorization header — the common local case, and the only one the desk
  // can verify end to end.
  const authHeaders = {};

  if (!PROBE_ABLE_APIS.includes(binding.api)) {
    return failure(
      stages,
      "api",
      `api is ${JSON.stringify(binding.api ?? null)}`,
      `This build can only probe ${PROBE_ABLE_APIS.join(", ")} endpoints, so it will not claim to have checked ${JSON.stringify(binding.api ?? null)}.`,
    );
  }

  // 2/3/4 — reachability, auth acceptance, API compatibility, in one call,
  // because /models is the one request every OpenAI-compatible endpoint answers.
  let listing;
  {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${base}/models`, {
        method: "GET",
        headers: { Accept: "application/json", ...authHeaders },
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      clearTimeout(timer);
      const detail = reachabilityDetail(err);
      return failure(stages, "reachability", detail, `${endpoint} couldn't be reached: ${detail}.`);
    }
    clearTimeout(timer);
    stages.push(stage("reachability", true, `answered ${res.status}`));

    if (res.status === 401 || res.status === 403) {
      // Only no-credential providers reach this point (a declared credential is
      // deferred above), so a 401/403 here is an endpoint that wants a key the
      // operator has configured this provider as not needing.
      return failure(
        stages,
        "auth",
        `answered ${res.status}`,
        `${endpoint} wants a credential, and this provider is configured as needing none.`,
      );
    }
    stages.push(stage("auth", true, "no credential needed"));

    if (!res.ok) {
      return failure(
        stages,
        "api",
        `answered ${res.status}`,
        `${endpoint} answered ${res.status} when asked for its model list, so it isn't answering as an OpenAI-compatible endpoint.`,
      );
    }
    const body = await readCapped(res);
    if (body === null) {
      return failure(stages, "api", "oversized model list", `${endpoint} returned more than this probe will read.`);
    }
    if (body === undefined || !Array.isArray(body?.data)) {
      return failure(
        stages,
        "api",
        "no data array",
        `${endpoint} answered, but not in the shape an OpenAI-compatible model list has.`,
      );
    }
    listing = body.data;
    stages.push(stage("api", true, `${listing.length} model${listing.length === 1 ? "" : "s"} listed`));
  }

  // 5 — the exact tag, not a family, not a display alias.
  const entry = listing.find((m) => m?.id === binding.modelId);
  if (!entry) {
    return failure(
      stages,
      "model-tag",
      `${binding.modelId} not listed`,
      `${endpoint} is answering, but doesn't serve a model tagged exactly "${binding.modelId}".`,
    );
  }
  stages.push(stage("model-tag", true, binding.modelId));

  // 6/7 — a minimal completion, and whether it came back in the declared shape.
  let completion;
  {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders },
        body: JSON.stringify({
          model: binding.modelId,
          stream: false,
          max_tokens: PROBE_COMPLETION_TOKENS,
          messages: [{ role: "user", content: "Reply with the single word: ready." }],
        }),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      clearTimeout(timer);
      const detail = reachabilityDetail(err);
      return failure(stages, "completion", detail, `${endpoint} took the model list but not a completion: ${detail}.`);
    }
    clearTimeout(timer);
    if (!res.ok) {
      return failure(
        stages,
        "completion",
        `answered ${res.status}`,
        `${endpoint} answered ${res.status} to a one-line completion for "${binding.modelId}".`,
      );
    }
    completion = await readCapped(res);
    stages.push(stage("completion", true, "answered"));
  }

  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.length) {
    return failure(
      stages,
      "protocol",
      "no message content",
      `${endpoint} answered a completion, but without the message content an OpenAI-compatible reply carries.`,
    );
  }
  stages.push(stage("protocol", true, `${content.length} characters back`));

  // 8 — the declared numbers against each other and against anything the
  // endpoint volunteered about itself.
  {
    const window = binding.contextWindow;
    const reserved = binding.maxTokens ?? 0;
    const budget = binding.contextBudget;
    if (!Number.isInteger(window) || window < 1) {
      return failure(stages, "limits", "no contextWindow declared", `The model entry for ${binding.modelId} declares no context window.`);
    }
    if (Number.isInteger(budget) && budget + reserved > window) {
      return failure(
        stages,
        "limits",
        `${budget} + ${reserved} > ${window}`,
        `The budget of ${budget} tokens plus ${reserved} reserved for the reply is more than the model's ${window}-token window.`,
      );
    }
    // Some servers report the real thing. If they do, a declaration larger
    // than the truth is a number that will fail later, at the worst moment.
    const served = Number.isInteger(entry?.context_length)
      ? entry.context_length
      : Number.isInteger(entry?.max_context_length)
        ? entry.max_context_length
        : null;
    if (served !== null && window > served) {
      return failure(
        stages,
        "limits",
        `${window} declared, ${served} served`,
        `The model entry declares a ${window}-token window, but ${endpoint} reports ${served} for that tag.`,
      );
    }
    stages.push(stage("limits", true, served === null ? `${window} declared` : `${window} declared, ${served} served`));
  }

  // 9 — §4.2.4. A dedicated no-side-effect capability, and exactly one call.
  if (binding.toolProtocol && binding.toolProtocol !== "none") {
    const toolResult = await probeTool({ base, binding, authHeaders, fetchImpl, timeoutMs, endpoint });
    if (!toolResult.ok) return failure(stages, "tools", toolResult.detail, toolResult.message);
    stages.push(stage("tools", true, toolResult.detail));
  }

  // 10 — §4.2.5. There is no harness in this build, so a chained-task binding
  // cannot be probed and therefore cannot be activated. Said out loud.
  if (binding.capabilityTier === "chained-task") {
    const harness = HARNESSES[binding.harnessRef];
    return failure(
      stages,
      "harness",
      binding.harnessRef ? `${binding.harnessRef} unavailable` : "no harness named",
      harness
        ? `The endpoint is fine. ${harness.note}`
        : `The endpoint is fine, but the seat names harness "${binding.harnessRef}", which this station doesn't have.`,
    );
  }

  return { ok: true, stages, failedStage: null, message: `${endpoint} answered as ${binding.modelId}.`, endpoint };
}

// A synthetic tool that does nothing and is not any agent's tool. §4.2.6: a
// configuration probe never touches a production capability.
const PROBE_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "orderly_probe_echo",
    description: "A configuration probe. Call this once with the word ready. It does nothing.",
    parameters: {
      type: "object",
      properties: { word: { type: "string" } },
      required: ["word"],
    },
  },
});

async function probeTool({ base, binding, authHeaders, fetchImpl, timeoutMs, endpoint }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders },
      body: JSON.stringify({
        model: binding.modelId,
        stream: false,
        max_tokens: PROBE_COMPLETION_TOKENS,
        tools: [PROBE_TOOL],
        tool_choice: "auto",
        messages: [{ role: "user", content: "Call orderly_probe_echo exactly once with the word ready." }],
      }),
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (err) {
    clearTimeout(timer);
    const detail = reachabilityDetail(err);
    return { ok: false, detail, message: `${endpoint} didn't answer the tool check: ${detail}.` };
  }
  clearTimeout(timer);
  if (!res.ok) {
    return {
      ok: false,
      detail: `answered ${res.status}`,
      message: `${endpoint} answered ${res.status} when asked for one tool call, so this engine's declared tool protocol isn't proven.`,
    };
  }
  const body = await readCapped(res);
  const calls = body?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    return {
      ok: false,
      detail: "no tool call",
      message: `${binding.modelId} is declared as speaking ${binding.toolProtocol}, but made no tool call when asked for exactly one.`,
    };
  }
  if (calls.length > 1) {
    // §4.2.4 — more than one is as wrong as none. A seat allowed one tool per
    // turn cannot be run on an engine that reliably emits two.
    return {
      ok: false,
      detail: `${calls.length} tool calls`,
      message: `${binding.modelId} made ${calls.length} tool calls when asked for exactly one, which a one-tool-per-turn seat can't be built on.`,
    };
  }
  const call = calls[0];
  if (call?.function?.name !== PROBE_TOOL.function.name) {
    return {
      ok: false,
      detail: "wrong tool named",
      message: `${binding.modelId} called something other than the probe's own test tool.`,
    };
  }
  return { ok: true, detail: "one tool call, as asked" };
}

// ---------------------------------------------------------------------------
// writing the overlay
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = Object.freeze(["models", "seats"]);

// The typed envelope, in the same spirit as the settings page's: the caller
// cannot name a path, only a seat or a model reference, and the only fields
// that exist are the ones written here.
export function applyOverlayEdits(overlay, edits) {
  if (!isObj(edits)) refuse("Nothing to change.");
  for (const key of Object.keys(edits)) {
    if (!ENVELOPE_KEYS.includes(key)) refuse(`"${key}" is not something the engine file holds.`);
  }
  const next = {
    version: ENGINES_CONFIG_VERSION,
    models: { ...(overlay?.models ?? {}) },
    seats: { ...(overlay?.seats ?? {}) },
  };

  if (edits.models !== undefined) {
    if (!isObj(edits.models)) refuse("Malformed model declarations.");
    for (const [ref, record] of Object.entries(edits.models)) {
      const split = splitRef(ref);
      if (!split || !PROVIDER_ID.test(split.providerId) || !MODEL_TAG.test(split.modelId)) {
        refuse(`"${String(ref).slice(0, 60)}" isn't a provider-and-model reference.`);
      }
      if (record === null) {
        delete next.models[ref];
        continue;
      }
      if (!isObj(record)) refuse("Malformed model declarations.");
      for (const key of Object.keys(record)) {
        if (!["toolProtocol", "tiers", "note"].includes(key)) {
          refuse(`A model declaration has no "${key}".`);
        }
      }
      if (!TOOL_PROTOCOLS.includes(record.toolProtocol)) {
        refuse(`${ref} needs a toolProtocol of ${TOOL_PROTOCOLS.join(" or ")}.`);
      }
      if (!Array.isArray(record.tiers) || !record.tiers.length) {
        refuse(`${ref} needs a tiers list saying what it has been reviewed for.`);
      }
      for (const tier of record.tiers) {
        if (!SELECTABLE_TIERS.includes(tier)) {
          refuse(
            tier === "coding-lane"
              ? "coding-lane is not a tier a chat engine can be qualified for."
              : `"${String(tier).slice(0, 40)}" isn't a tier.`,
          );
        }
      }
      next.models[ref] = {
        toolProtocol: record.toolProtocol,
        tiers: [...record.tiers],
        ...(typeof record.note === "string" ? { note: record.note.slice(0, 200) } : {}),
      };
    }
  }

  if (edits.seats !== undefined) {
    if (!isObj(edits.seats)) refuse("Malformed seat classifications.");
    for (const [seatId, record] of Object.entries(edits.seats)) {
      if (seatId !== "defaults" && !SEAT_ID.test(seatId)) refuse(`"${String(seatId).slice(0, 40)}" isn't a seat name.`);
      if (record === null) {
        delete next.seats[seatId];
        continue;
      }
      if (!isObj(record)) refuse("Malformed seat classifications.");
      for (const key of Object.keys(record)) {
        if (!["capabilityTier", "contextBudget", "harnessRef", "note"].includes(key)) {
          refuse(`A seat classification has no "${key}".`);
        }
      }
      if (record.capabilityTier === "coding-lane") {
        refuse(
          "coding-lane is not a tier a chat seat can be set to. It names the dispatch broker's own pinned seat, and nothing configured here reaches it.",
        );
      }
      if (!SELECTABLE_TIERS.includes(record.capabilityTier)) {
        refuse(`A seat's capabilityTier must be ${SELECTABLE_TIERS.map((t) => `"${t}"`).join(" or ")}.`);
      }
      if (record.contextBudget !== undefined && (!Number.isInteger(record.contextBudget) || record.contextBudget < 1)) {
        refuse("A contextBudget is a positive whole number of tokens.");
      }
      if (record.harnessRef !== undefined && !HARNESSES[record.harnessRef]) {
        refuse(`"${String(record.harnessRef).slice(0, 40)}" isn't a harness this station has.`);
      }
      next.seats[seatId] = {
        capabilityTier: record.capabilityTier,
        ...(record.contextBudget !== undefined ? { contextBudget: record.contextBudget } : {}),
        ...(record.harnessRef !== undefined ? { harnessRef: record.harnessRef } : {}),
        ...(typeof record.note === "string" ? { note: record.note.slice(0, 200) } : {}),
      };
    }
  }

  return next;
}

// A whole file appears or none does, and the previous one is kept beside it.
// The same discipline as the settings write, for the same reason: a half-written
// engine file would leave seats classified as something nobody chose.
export async function writeEngineConfig({ path, overlay }) {
  await mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(overlay, null, 2)}\n`;
  try {
    await copyFile(path, `${path}.orderly-bak`);
  } catch {
    /* no previous file is not a problem; there is nothing to keep */
  }
  const tmp = join(dirname(path), `.engines.json.orderly-tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, body, { mode: 0o600 });
  const handle = await open(tmp, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  return { bytes: Buffer.byteLength(body) };
}

// The whole write: apply the envelope, validate the result against the real
// gateway config, probe every seat the edit touches, and only then persist.
// A probe failure leaves the file exactly as it was — §4.2.8 and §4.2.10, which
// together mean a failed edit changes nothing and substitutes nothing.
export async function applyEngineEdits({ path, overlay, gatewayConfig, edits, probe = probeEngine }) {
  const next = applyOverlayEdits(overlay, edits);
  const { ok, problems } = validateEngineConfig({ overlay: next, gatewayConfig });
  if (!ok) {
    return { ok: false, stage: "validation", problems, probes: [], retained: true };
  }

  const touched = Object.keys(edits?.seats ?? {}).filter((id) => next.seats[id]);
  const probes = [];
  for (const seatId of touched) {
    const binding = resolveSeatEngine({ gatewayConfig, overlay: next, seatId });
    const result = await probe({ binding });
    probes.push({ seat: seatId, ...result });
    if (!result.ok) {
      return {
        ok: false,
        stage: "probe",
        problems: [
          problem(
            `seats.${seatId}`,
            `${result.message} Nothing was changed; the seat is still running what it was.`,
          ),
        ],
        probes,
        retained: true,
      };
    }
  }

  await writeEngineConfig({ path, overlay: next });
  return { ok: true, stage: "written", problems: [], probes, overlay: next, retained: false };
}
