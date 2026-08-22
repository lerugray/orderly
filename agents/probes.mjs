// Live named-agent verification. Every probe command is compiled here and runs
// through `docker exec` in the one OpenClaw sandbox resolved for the immutable
// agent id. Browser requests cannot supply a command, path, container, or result.

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { AGENT_ID, CONTAINER_PROBES } from "../web/agents.mjs";
import { CONTAINER_PATHS, PROFILE_REVISION } from "./profile.mjs";

const execFile = promisify(execFileCallback);

export class AgentProbeRefused extends Error {}
const refuse = (message) => { throw new AgentProbeRefused(message); };

const SCRIPTS = Object.freeze({
  "network-none": String.raw`set -eu
test "$(ls -1 /sys/class/net 2>/dev/null | tr '\n' ' ')" = "lo "
! awk 'NR>1 && $2=="00000000" { found=1 } END { exit found ? 0 : 1 }' /proc/net/route`,
  "credential-stores-absent": String.raw`set -eu
for p in /gog-store /gog-store-write /run/secrets /var/lib/orderly-connectors /root/.openclaw /root/.ssh /home/sandbox/.ssh; do
  test ! -e "$p"
done
! env | cut -d= -f1 | grep -Eiq '(^|_)(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)$'`,
  "other-agent-state-absent": String.raw`set -eu
for p in /orderly/agents /agent /workspace/conversations /orderly/conversations; do
  test ! -e "$p"
done
test ! -e /orderly/transcripts.sqlite
test ! -e /orderly/transcript.jsonl`,
  "standing-orders-read-only": String.raw`set -eu
test -r /orderly/standing-orders.md
! sh -c 'printf x >>/orderly/standing-orders.md' 2>/dev/null
! rm -f /orderly/standing-orders.md 2>/dev/null`,
  "profile-read-only": String.raw`set -eu
test -r /orderly/profile.json
! sh -c 'printf x >>/orderly/profile.json' 2>/dev/null
! rm -f /orderly/profile.json 2>/dev/null`,
  "typed-sockets-only": String.raw`set -eu
paths="$(awk 'NR>1 && $8 ~ /^\// { print $8 }' /proc/net/unix 2>/dev/null || true)"
test -z "$paths"`,
});

function memoryScript(policy) {
  if (policy === "persistent") {
    return String.raw`set -eu
test -d /workspace
awk '$5=="/workspace" && $6 ~ /(^|,)rw(,|$)/ { found=1 } END { exit found ? 0 : 1 }' /proc/self/mountinfo
probe=/workspace/.orderly-container-probe
printf verified >"$probe"
test "$(cat "$probe")" = verified
rm -f "$probe"
scratch=/tmp/.orderly-container-scratch
printf ephemeral >"$scratch"
rm -f "$scratch"
awk '$5=="/tmp" { for (i=7; i<NF; i++) if ($i=="-" && $(i+1)=="tmpfs") found=1 } END { exit found ? 0 : 1 }' /proc/self/mountinfo`;
  }
  if (policy === "memoryless") {
    return String.raw`set -eu
test -d /workspace
! sh -c 'printf persistent >/workspace/.orderly-container-probe' 2>/dev/null
! awk '$5=="/workspace" && $6 ~ /(^|,)rw(,|$)/ { found=1 } END { exit found ? 0 : 1 }' /proc/self/mountinfo
scratch=/tmp/.orderly-container-scratch
printf ephemeral >"$scratch"
test "$(cat "$scratch")" = ephemeral
rm -f "$scratch"
awk '$5=="/tmp" { for (i=7; i<NF; i++) if ($i=="-" && $(i+1)=="tmpfs") found=1 } END { exit found ? 0 : 1 }' /proc/self/mountinfo`;
  }
  refuse("Unknown named-agent memory policy.");
}

async function defaultRun(file, args, options = {}) {
  return execFile(file, args, { timeout: 30_000, maxBuffer: 128 * 1024, ...options });
}

function parseSandboxList(stdout, agentId) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { refuse("OpenClaw did not return a sandbox registry document."); }
  const containers = (Array.isArray(parsed?.containers) ? parsed.containers : []).filter((item) =>
    item?.sessionKey === `agent:${agentId}` || item?.sessionKey?.startsWith(`agent:${agentId}:`),
  );
  if (containers.length !== 1) refuse(`Expected one live sandbox for ${agentId}; found ${containers.length}.`);
  const container = containers[0];
  if (container.backendId !== "docker" || container.running !== true) refuse("The named-agent sandbox is not a running Docker runtime.");
  if (typeof container.containerName !== "string" || !new RegExp(`^openclaw-sbx-agent-${agentId}-[a-z0-9]+$`).test(container.containerName)) {
    refuse("OpenClaw returned a non-derived sandbox identity.");
  }
  return container;
}

async function findContainer({ agentId, openclawBin, run }) {
  const { stdout } = await run(openclawBin, ["sandbox", "list", "--json"]);
  return parseSandboxList(stdout, agentId);
}

export async function inspectNamedAgentSandbox({ id, openclawBin = "openclaw", run = defaultRun }) {
  if (!AGENT_ID.test(String(id))) refuse("A valid named-agent id is required.");
  const { stdout } = await run(openclawBin, ["sandbox", "list", "--json"]);
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { refuse("OpenClaw did not return a sandbox registry document."); }
  const containers = (Array.isArray(parsed?.containers) ? parsed.containers : []).filter((item) =>
    item?.sessionKey === `agent:${id}` || item?.sessionKey?.startsWith(`agent:${id}:`),
  );
  if (containers.length === 0) return null;
  return parseSandboxList(stdout, id);
}

async function defaultWarm({ record, openclawBin, run }) {
  const message = [
    "This is the station's activation check.",
    "Use the exec tool exactly once with: printf orderly-container-ready",
    "Then answer only: ready",
  ].join(" ");
  let last;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await run(openclawBin, [
        "agent", "--agent", record.id,
        "--session-key", "orderly-v041-activation",
        "--message", message,
        "--timeout", "120",
        "--json",
      ], { timeout: 150_000 });
      return;
    } catch (error) {
      last = error;
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw last;
}

export async function resolveOrCreateSandbox({ record, openclawBin = "openclaw", run = defaultRun, warm = defaultWarm }) {
  if (!record || !AGENT_ID.test(String(record.id))) refuse("A valid named-agent id is required.");
  try { return await findContainer({ agentId: record.id, openclawBin, run }); }
  catch (error) {
    if (!(error instanceof AgentProbeRefused) || !/found 0/.test(error.message)) throw error;
  }
  await warm({ record, openclawBin, run });
  return findContainer({ agentId: record.id, openclawBin, run });
}

export async function runContainerProbes({ record, container, dockerBin = "docker", run = defaultRun }) {
  if (!record || !AGENT_ID.test(String(record.id))) refuse("A valid named-agent id is required.");
  if (!container || typeof container.containerName !== "string") refuse("A resolved live sandbox is required.");
  const checks = [];
  const raw = [];
  for (const definition of CONTAINER_PROBES) {
    const script = definition.id === "own-memory-policy" ? memoryScript(record.memoryPolicy) : SCRIPTS[definition.id];
    if (!script) refuse(`No compiled probe exists for ${definition.id}.`);
    let ok = false;
    let diagnostic = "";
    try {
      const result = await run(dockerBin, ["exec", container.containerName, "sh", "-lc", script]);
      ok = true;
      diagnostic = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(0, 4000);
    } catch (error) {
      diagnostic = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.slice(0, 4000);
    }
    checks.push({
      id: definition.id,
      ok,
      detail: ok ? "passed inside the live sandbox" : "the in-container check did not pass",
    });
    raw.push({ id: definition.id, ok, diagnostic });
  }
  return {
    evidence: {
      revision: `${PROFILE_REVISION}:${String(container.configHash || "unlabelled").slice(0, 64)}`,
      checkedAt: new Date().toISOString(),
      container: container.containerName,
      checks,
    },
    raw,
  };
}

export async function verifyNamedAgentSandbox(options) {
  const container = await resolveOrCreateSandbox(options);
  return runContainerProbes({ ...options, container });
}

export async function stopNamedAgentSandbox({ id, openclawBin = "openclaw", run = defaultRun }) {
  if (!AGENT_ID.test(String(id))) refuse("A valid named-agent id is required.");
  if (!(await inspectNamedAgentSandbox({ id, openclawBin, run }))) return true;
  await run(openclawBin, ["sandbox", "recreate", "--agent", id, "--force"]);
  const { stdout } = await run(openclawBin, ["sandbox", "list", "--json"]);
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { refuse("OpenClaw did not return a sandbox registry document."); }
  const remains = (parsed?.containers ?? []).some((item) => item?.sessionKey === `agent:${id}` || item?.sessionKey?.startsWith(`agent:${id}:`));
  if (remains) refuse("OpenClaw did not prove the named-agent sandbox removed.");
  return true;
}

export { CONTAINER_PATHS };
