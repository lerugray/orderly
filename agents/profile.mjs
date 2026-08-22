// ORDERLY v0.4.1 — the compiled named-isolated OpenClaw profile.
//
// Operator input never reaches this module. Every host path is derived from a
// validated immutable agent id beneath the gateway-owned agents root, and each
// container target and tool policy is fixed here.

import { join, resolve } from "node:path";

import { AGENT_ID, agentDir } from "../web/agents.mjs";

export const PROFILE_NAME = "named-isolated";
export const PROFILE_REVISION = "named-isolated-v1";
export const CONTAINER_PATHS = Object.freeze({
  profile: "/orderly/profile.json",
  orders: "/orderly/standing-orders.md",
  memory: "/workspace",
  capabilities: "/orderly/capabilities",
});

const ALWAYS_DENY = Object.freeze([
  "apply_patch",
  "browser",
  "canvas",
  "computer",
  "cron",
  "gateway",
  "image",
  "message",
  "nodes",
  "process",
  "sessions_history",
  "sessions_list",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "telegram",
  "web_fetch",
  "web_search",
]);

function checkedRoot(root) {
  if (typeof root !== "string" || !root.startsWith("/")) throw new Error("Agent state root must be absolute.");
  return resolve(root);
}

export function namedIsolatedProfile({ root, record, capabilitySockets = [] }) {
  const stateRoot = checkedRoot(root);
  if (!record || !AGENT_ID.test(String(record.id))) throw new Error("A derived agent id is required.");
  if (!new Set(["persistent", "memoryless"]).has(record.memoryPolicy)) throw new Error("Unknown memory policy.");
  if (!Array.isArray(capabilitySockets) || capabilitySockets.length) {
    // v0.4.1 ships the base zero-capability profile. Connector socket mounts
    // stay a separately ruled lifecycle and are never accepted as desk input.
    throw new Error("The base named-isolated profile has no capability socket mounts.");
  }

  const dir = agentDir(stateRoot, record.id);
  const binds = [
    `${join(dir, "profile.json")}:${CONTAINER_PATHS.profile}:ro`,
    `${join(dir, "standing-orders.md")}:${CONTAINER_PATHS.orders}:ro`,
  ];
  const allow = ["exec", "read"];
  const deny = [...ALWAYS_DENY];
  if (record.memoryPolicy === "persistent") allow.push("write", "edit", "memory_get", "memory_search");
  else deny.push("write", "edit", "memory_get", "memory_search");

  const docker = {
    network: "none",
    readOnlyRoot: true,
    tmpfs: ["/tmp", "/var/tmp", "/run"],
    capDrop: ["ALL"],
    user: "1000:1000",
    binds,
    dangerouslyAllowExternalBindSources: true,
  };
  return {
    id: record.id,
    // OpenClaw owns /workspace. Persistent identities point that one
    // supported rw mount at their own memory directory; no other part of the
    // host-managed record becomes writable or visible there.
    workspace: record.memoryPolicy === "persistent" ? join(dir, "memory") : dir,
    sandbox: {
      mode: "all",
      backend: "docker",
      scope: "agent",
      workspaceAccess: record.memoryPolicy === "persistent" ? "rw" : "none",
      docker,
    },
    tools: {
      profile: "minimal",
      alsoAllow: allow,
      deny: [...new Set(deny)].sort(),
      sandbox: { tools: { alsoAllow: allow } },
    },
    subagents: { allowAgents: [] },
    memorySearch: record.memoryPolicy === "persistent"
      ? { enabled: true, provider: "none" }
      : { enabled: false },
  };
}

export function assertNamedIsolatedProfile({ root, record, entry }) {
  const expected = namedIsolatedProfile({ root, record });
  if (JSON.stringify(entry) !== JSON.stringify(expected)) {
    throw new Error(`Agent ${record.id} does not match the compiled ${PROFILE_NAME} profile.`);
  }
  return entry;
}
