// Pure presentation helpers shared by the browser and the node:test suite.
// Keeping the digest formatter here makes the review surface testable without
// teaching a test runner to impersonate a browser DOM.

export function digestJson(proposal) {
  if (!proposal || typeof proposal !== "object" || !proposal.digest) return "";
  return JSON.stringify(proposal.digest, null, 2);
}

export function optionRecords(items, idKey) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === "string") return { id: item, label: item };
      const id = item?.[idKey];
      if (typeof id !== "string" || !id) return null;
      const detail = idKey === "repo_id" ? item.branch : item.sandbox;
      return { id, label: typeof detail === "string" && detail ? `${id} · ${detail}` : id };
    })
    .filter(Boolean);
}

export function proposalPrefill(proposal, allowlist) {
  if (proposal?.decision !== "dispatch" || !proposal.brief || typeof proposal.brief !== "object") {
    return null;
  }
  const brief = proposal.brief;
  const repo = Array.isArray(allowlist?.repos)
    ? allowlist.repos.find((item) => item?.repo_id === brief.repo)
    : null;
  const preset = Array.isArray(allowlist?.presets)
    ? allowlist.presets.find((item) => item?.preset_id === brief.lane_preset)
    : null;
  if (!repo || !preset || !Number.isInteger(preset.timeout_max_s) || preset.timeout_max_s < 1) {
    return null;
  }
  const minimumTimeout = Math.min(60, preset.timeout_max_s);
  const requestedTimeout = Number.isFinite(brief.timeout_s) ? Math.trunc(brief.timeout_s) : minimumTimeout;
  return {
    repo_id: repo.repo_id,
    preset_id: preset.preset_id,
    brief_text: JSON.stringify(brief, null, 2),
    timeout_s: Math.min(preset.timeout_max_s, Math.max(minimumTimeout, requestedTimeout)),
  };
}
