// Gateway-side named-agent lifecycle. This module owns the manifest, OpenClaw
// agent entries, sandbox lifecycle, and live verification as one control plane.

import {
  AgentsRefused,
  appendTurns,
  createAgent,
  findAgent,
  listAgents,
  readManifest,
  readTranscript,
  recordContainerVerification,
  removeAgent,
  resetContainerVerification,
  setLifecycle,
  updateAgent,
} from "../web/agents.mjs";
import { AgentConfigRefused, writeAgentEntry } from "./config.mjs";
import { AgentProbeRefused, inspectNamedAgentSandbox, stopNamedAgentSandbox, verifyNamedAgentSandbox } from "./probes.mjs";

export class AgentRuntimeRefused extends Error {}
const refuse = (message) => { throw new AgentRuntimeRefused(message); };

function runtimeError(error) {
  if (error instanceof AgentRuntimeRefused || error instanceof AgentsRefused || error instanceof AgentConfigRefused || error instanceof AgentProbeRefused) {
    return error;
  }
  return new AgentRuntimeRefused("The gateway agent runtime could not complete that action.");
}

export function createAgentControl({ root, configPath, openclawBin = "openclaw", dockerBin = "docker", validate, run, warm } = {}) {
  if (typeof root !== "string" || !root.startsWith("/")) refuse("The gateway agent root must be absolute.");
  if (typeof configPath !== "string" || !configPath.startsWith("/")) refuse("The gateway config path must be absolute.");

  const config = (record, remove = false) => writeAgentEntry({
    configPath, root, record, remove, validate, openclawBin,
  });
  const verify = (record) => verifyNamedAgentSandbox({ record, openclawBin, dockerBin, run, warm });
  const stop = (record) => stopNamedAgentSandbox({ id: record.id, openclawBin, run });
  const reconcile = async (record) => {
    if (record.lifecycle !== "active") return record;
    const container = await inspectNamedAgentSandbox({ id: record.id, openclawBin, run });
    const revision = record.containerVerification?.revision;
    const current = container?.configHash && typeof revision === "string" && revision.endsWith(`:${container.configHash}`);
    if (container?.running === true && current) return record;
    await resetContainerVerification({ root, id: record.id, lifecycle: "pending" });
    return findAgent({ root, id: record.id });
  };

  return {
    async roster() {
      const manifest = await readManifest(root);
      for (const record of manifest.agents) await reconcile(record);
      return { agents: await listAgents({ root }), readAt: new Date().toISOString() };
    },

    async find(id) {
      let record = await findAgent({ root, id });
      if (record) record = await reconcile(record);
      return record ? (await listAgents({ root })).find((agent) => agent.id === id) ?? null : null;
    },

    async transcript(id) {
      const record = await findAgent({ root, id });
      if (!record) refuse("That isn't an agent on this station.");
      return { agent: (await listAgents({ root })).find((item) => item.id === id), turns: await readTranscript({ root, id }) };
    },

    async append(id, turns) {
      const record = await findAgent({ root, id });
      if (!record) refuse("That isn't an agent on this station.");
      await appendTurns({ root, id, turns });
      return { ok: true };
    },

    async create(fields) {
      try {
        const agent = await createAgent({ root, fields });
        const record = await findAgent({ root, id: agent.id });
        try {
          await config(record);
          return { agent: (await listAgents({ root })).find((item) => item.id === agent.id), configured: true };
        } catch (error) {
          // The durable identity remains pending and visibly owes every check.
          // Retrying activation will retry this derived config write.
          return {
            agent: (await listAgents({ root })).find((item) => item.id === agent.id),
            configured: false,
            note: error instanceof AgentConfigRefused ? error.message : "The sandbox profile is still pending on the gateway.",
          };
        }
      } catch (error) { throw runtimeError(error); }
    },

    async activate(id) {
      try {
        let record = await findAgent({ root, id });
        if (!record) refuse("That isn't an agent on this station.");
        if (record.lifecycle === "retired") refuse("A retired identity is not activated again.");
        if (record.containerVerification?.status !== "owed" || record.lifecycle !== "pending") {
          await resetContainerVerification({ root, id, lifecycle: "pending" });
          record = await findAgent({ root, id });
        }
        await config(record);
        try {
          const result = await verify(record);
          return await recordContainerVerification({ root, id, evidence: result.evidence });
        } catch (error) {
          // A sandbox that did not become verified is not left addressable.
          await stop(record).catch(() => {});
          throw error;
        }
      } catch (error) { throw runtimeError(error); }
    },

    async update(id, fields) {
      try { return { agent: await updateAgent({ root, id, fields }) }; }
      catch (error) { throw runtimeError(error); }
    },

    async lifecycle(id, lifecycle) {
      try {
        const record = await findAgent({ root, id });
        if (!record) refuse("That isn't an agent on this station.");
        if (lifecycle === "active") return this.activate(id);
        if (!["suspended", "retired"].includes(lifecycle)) refuse("That isn't a gateway-managed lifecycle change.");
        await stop(record);
        if (lifecycle === "retired") await config(record, true);
        return { agent: await setLifecycle({ root, id, lifecycle }) };
      } catch (error) { throw runtimeError(error); }
    },

    async remove(id) {
      try {
        const record = await findAgent({ root, id });
        if (!record) refuse("That isn't an agent on this station.");
        await stop(record);
        await config(record, true);
        return await removeAgent({ root, id });
      } catch (error) { throw runtimeError(error); }
    },

    async migrate() {
      try {
        const manifest = await readManifest(root);
        const results = [];
        for (const record of manifest.agents) {
          if (record.lifecycle === "retired") {
            if (await inspectNamedAgentSandbox({ id: record.id, openclawBin, run })) await stop(record);
            await config(record, true);
            results.push({ id: record.id, lifecycle: "retired" });
            continue;
          }
          const verificationPassed = record.containerVerification?.status === "passed";
          if (!verificationPassed) await resetContainerVerification({ root, id: record.id, lifecycle: "pending" });
          const current = await findAgent({ root, id: record.id });
          await config(current);
          const reconciled = await reconcile(current);
          results.push({ id: record.id, lifecycle: reconciled.lifecycle });
        }
        return { migrated: results.length, agents: results };
      } catch (error) { throw runtimeError(error); }
    },
  };
}
