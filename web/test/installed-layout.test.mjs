import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { THEMES } from "../public/themes.js";

const TEST_DIR = resolve(fileURLToPath(import.meta.url), "..");
const WEB = resolve(TEST_DIR, "..");

async function installedAppFiles() {
  const installer = await readFile(resolve(WEB, "deploy", "install.sh"), "utf8");
  const match = /^APP_FILES="([^"]+)"$/m.exec(installer);
  assert.ok(match, "install.sh must declare its flat APP_FILES list");
  return match[1].trim().split(/\s+/);
}

async function installedConnectorFiles() {
  const installer = await readFile(resolve(WEB, "deploy", "install.sh"), "utf8");
  const match = /^CONNECTOR_FILES="([^"]+)"$/m.exec(installer);
  assert.ok(match, "install.sh must declare its connector control files");
  return match[1].trim().split(/\s+/);
}

test("the install.sh flat layout serves every shipped identity and settings", async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "orderly-web-installed-")));
  const installed = join(scratch, "orderly-web");
  const serviceHome = join(scratch, "service-home");
  await mkdir(installed, { recursive: true });
  await mkdir(join(serviceHome, ".openclaw"), { recursive: true });
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const appFiles = await installedAppFiles();
  assert.deepEqual(appFiles, [
    "server.mjs",
    "settings.mjs",
    "queue.mjs",
    "calendar.mjs",
    "dashboard.mjs",
    "agents.mjs",
    "agent-runtime-client.mjs",
    "engines.mjs",
    "reply-style.mjs",
    "connectors.mjs",
  ]);
  for (const file of appFiles) await cp(resolve(WEB, file), join(installed, file));
  await mkdir(join(installed, "connectors"));
  for (const file of await installedConnectorFiles()) {
    await cp(resolve(WEB, "..", "connectors", file), join(installed, "connectors", file));
  }
  await cp(resolve(WEB, "public"), join(installed, "public"), { recursive: true });

  // This is host state, not a shipped web asset. It exercises the only uncaught
  // settings read without making the flat install depend on the developer's HOME.
  await writeFile(join(serviceHome, ".openclaw", "openclaw.json"), JSON.stringify({
    gateway: { mode: "local", reload: { mode: "hybrid" } },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          auth: "api-key",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          models: [{ id: "gpt-5", name: "GPT-5", input: ["text"], contextWindow: 128000, maxTokens: 8192 }],
        },
      },
    },
    agents: { defaults: { model: { primary: "openai/gpt-5" } }, list: [{ id: "coordinator" }] },
  }));

  // The seat-engine overlay is host state too, and it is read by a module the
  // flat install has to have shipped. A file the installer forgets is exactly
  // the failure this whole test exists to catch.
  await mkdir(join(serviceHome, ".orderly"), { recursive: true });
  await writeFile(join(serviceHome, ".orderly", "engines.json"), JSON.stringify({
    version: 1,
    models: { "openai/gpt-5": { toolProtocol: "openai-tools", tiers: ["chat-research"] } },
    seats: { defaults: { capabilityTier: "chat-research", contextBudget: 32000 } },
  }));

  process.env.HOME = serviceHome;
  process.env.ORDERLY_SETTINGS_WRITE = "off";
  process.env.ORDERLY_AGENTS_ROOT = join(serviceHome, ".orderly", "agents");
  process.env.ORDERLY_AGENT_RUNTIME_SOCKET = "off";
  delete process.env.ORDERLY_CONFIG;
  delete process.env.ORDERLY_CONNECTORS_CONFIG;
  delete process.env.ORDERLY_REPLY_STYLE_CONFIG;
  const { dispatchWebRequest } = await import(`${new URL(`file://${join(installed, "server.mjs")}`).href}?flat=${Date.now()}`);
  const get = (path) => dispatchWebRequest({ url: path });

  const mark = await get("/mark.svg");
  assert.equal(mark.status, 200);
  assert.match(mark.headers.get("content-type") || "", /^image\/svg\+xml/);
  const markSvg = await mark.text();

  for (const theme of THEMES.slice(1)) {
    const mascot = await get(theme.mascot);
    assert.equal(mascot.status, 200, theme.mascot);
    const svg = await mascot.text();
    assert.match(svg, /^<svg[^>]+viewBox="0 0 32 32">/);
    // Each variant route serves that variant's own artwork. Serving the default
    // here would look exactly like the palette-only swap the hero bug produced.
    assert.notEqual(svg, markSvg, `${theme.id} served the default mascot`);
    assert.equal(svg, await readFile(join(installed, "public", "theme-mascots", `${theme.id}.svg`), "utf8"));
    // The hero fetches this exact file and inlines it to work the eye, so a
    // flat install serving artwork without the moving parts ships a mascot that
    // sits there — from the page's side, the old <img> hero all over again.
    assert.match(svg, /<g class="m-pupil">/, `${theme.id} served artwork with no pupil to move`);
    assert.match(svg, /<rect class="m-lid"[^>]*data-lid-close="/, `${theme.id} served artwork with no lid`);
    assert.match(svg, /<path class="m-mouth"[^>]*data-mouth-flat="/, `${theme.id} served artwork with one mouth`);
    assert.match(svg, new RegExp(`id="eyeClip-${theme.id}"`), `${theme.id} served artwork with no eye clip`);
  }

  const settingsPage = await get("/settings");
  const settingsHtml = await settingsPage.text();
  assert.equal(settingsPage.status, 200);
  assert.equal(settingsHtml.includes("expects it"), false);
  assert.match(settingsHtml, /src="\/mark\.svg" data-theme-mascot/);

  const settingsApi = await get("/api/settings");
  const settingsBody = await settingsApi.text();
  assert.equal(settingsApi.status, 200, settingsBody);
  assert.equal(settingsBody.includes("expects it"), false);

  // The engines readout, in the flat layout, against real host state: the seat
  // resolves, the classification is read, and no credential value appears.
  const enginesApi = await get("/api/engines");
  const enginesBody = await enginesApi.text();
  assert.equal(enginesApi.status, 200, enginesBody);
  const engines = JSON.parse(enginesBody);
  assert.equal(engines.configured, true);
  assert.deepEqual(engines.problems, []);
  const seat = engines.seats.find((s) => s.seat === "coordinator");
  assert.equal(seat.modelRef, "openai/gpt-5");
  assert.equal(seat.capabilityTier, "chat-research");
  assert.equal(seat.credentialRef, "OPENAI_API_KEY");
  assert.equal(enginesBody.includes("apiKey"), false);

  const station = await get("/");
  const stationHtml = await station.text();
  assert.equal(station.status, 200);
  assert.match(stationHtml, /data-default-mascot/);
  assert.match(stationHtml, /src="\/mark\.svg" data-theme-mascot/);

  // The hero swap ships as wiring, not only as artwork. A flat install that
  // serves five variant files but hides nothing is exactly today's defect.
  const themeModule = await get("/themes.js");
  assert.equal(themeModule.status, 200);
  const themeSource = await themeModule.text();
  assert.match(themeSource, /toggleAttribute\("hidden"/);
  assert.doesNotMatch(themeSource, /\.hidden\s*=/, "`.hidden =` does nothing on the inline <svg> mascot");
  assert.match(themeSource, /data-mascot-src/, "the hero slot must be told which variant file to draw");

  // And the module that draws it ships too, or the themed hero stays an empty
  // <svg>: a flat install can serve every asset and still show nothing.
  const stationModule = await get("/orderly.js");
  assert.equal(stationModule.status, 200);
  const stationSource = await stationModule.text();
  assert.match(stationSource, /data-themed-mascot/);
  assert.match(stationSource, /bindMascot\(visibleMascot\(\)\)/);

  // The agents surface, in a flat install. The module is copied beside the
  // server rather than imported from a parent — the whole reason APP_FILES is
  // asserted above — and its page, its script and its two API routes all serve.
  const agentsPage = await get("/agents");
  assert.equal(agentsPage.status, 200);
  const agentsHtml = await agentsPage.text();
  assert.match(agentsHtml, /<title>Agents · ORDERLY<\/title>/);
  assert.match(agentsHtml, /src="\/agents\.js"/);
  // A handle in the address bar is a desk route the page resolves, never a
  // filesystem path: every /agents/* serves the same file.
  const deepRoute = await get("/agents/reading-log");
  assert.equal(deepRoute.status, 200);
  assert.equal(await deepRoute.text(), agentsHtml);

  const agentsModule = await get("/agents.js");
  assert.equal(agentsModule.status, 200);
  const agentsSource = await agentsModule.text();
  // The management page draws no control this surface must not have (§5.1).
  for (const forbidden of [/type="password"/, /API[_ ]?KEY/i, /Dockerfile/i, /"image"/]) {
    assert.doesNotMatch(agentsSource, forbidden, `the agents page offers ${forbidden}`);
  }

  const roster = await get("/api/agents");
  assert.equal(roster.status, 200);
  const rosterBody = await roster.json();
  assert.equal(rosterBody.state, "ok");
  // §6.1 — the fixed trio are in the same roster, and marked as the station's.
  assert.deepEqual(
    rosterBody.system.map((agent) => agent.id),
    ["coordinator", "mail", "orchestration"],
  );
  assert.ok(rosterBody.system.every((agent) => agent.systemLocked === true));
  // Migration §6: a station nobody has named an agent on has none, and has
  // written nothing to disk to say so.
  assert.deepEqual(rosterBody.agents, []);
  assert.equal(rosterBody.counts.named, 0);
  assert.equal(
    await readFile(join(serviceHome, ".orderly", "agents", "identity-manifest.json"), "utf8").then(
      () => "written",
      () => "absent",
    ),
    "absent",
    "reading the roster must not create host state",
  );

  const missing = await get("/api/agents/thread?agent=a-doesnotexist1");
  assert.equal(missing.status, 404);

  const connectors = await get("/api/connectors");
  assert.equal(connectors.status, 200);
  const connectorBody = await connectors.json();
  assert.equal(connectorBody.state, "ok");
  assert.ok(connectorBody.catalog.some((entry) => entry.id === "google-drive"));
  assert.deepEqual(connectorBody.instances, []);
  assert.equal(
    await readFile(join(serviceHome, ".orderly", "connectors.json"), "utf8").then(
      () => "written",
      () => "absent",
    ),
    "absent",
    "reading connector state must not create host state",
  );

  assert.equal(
    await readFile(join(serviceHome, ".orderly", "reply-style.json"), "utf8").then(
      () => "written",
      () => "absent",
    ),
    "absent",
    "reading reply style must not create host state",
  );

});
