import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

function waitForServer(child) {
  return new Promise((resolveReady, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`flat-layout server did not listen in time\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timeout);
      resolveReady({ port: Number(match[1]), stderr: () => stderr });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`flat-layout server exited before listening (${code ?? signal})\nstderr: ${stderr}`));
    });
  });
}

test("the install.sh flat layout serves every shipped identity and settings", async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "orderly-web-installed-")));
  const installed = join(scratch, "orderly-web");
  const serviceHome = join(scratch, "service-home");
  await mkdir(installed, { recursive: true });
  await mkdir(join(serviceHome, ".openclaw"), { recursive: true });
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const appFiles = await installedAppFiles();
  assert.deepEqual(appFiles, ["server.mjs", "settings.mjs", "queue.mjs", "calendar.mjs", "dashboard.mjs"]);
  for (const file of appFiles) await cp(resolve(WEB, file), join(installed, file));
  await cp(resolve(WEB, "public"), join(installed, "public"), { recursive: true });

  // This is host state, not a shipped web asset. It exercises the only uncaught
  // settings read without making the flat install depend on the developer's HOME.
  await writeFile(join(serviceHome, ".openclaw", "openclaw.json"), JSON.stringify({
    gateway: { mode: "local", reload: { mode: "hybrid" } },
    agents: { defaults: { model: { primary: "openai/gpt-5" } }, list: [] },
  }));

  const child = spawn(process.execPath, [join(installed, "server.mjs")], {
    cwd: installed,
    env: {
      ...process.env,
      HOME: serviceHome,
      ORDERLY_WEB_PORT: "0",
      ORDERLY_GATEWAY_PORT: "0",
      ORDERLY_SETTINGS_WRITE: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  });

  let ready;
  try {
    ready = await waitForServer(child);
  } catch (error) {
    if (/listen EPERM: operation not permitted 127\.0\.0\.1/.test(error.message)) {
      t.skip("sandbox denies loopback listen; the harvest host must run this flat-layout test");
      return;
    }
    throw error;
  }
  const get = (path) => fetch(`http://127.0.0.1:${ready.port}${path}`);

  const mark = await get("/mark.svg");
  assert.equal(mark.status, 200);
  assert.match(mark.headers.get("content-type") || "", /^image\/svg\+xml/);

  for (const theme of THEMES.slice(1)) {
    const mascot = await get(theme.mascot);
    assert.equal(mascot.status, 200, theme.mascot);
    assert.match(await mascot.text(), /^<svg[^>]+viewBox="0 0 32 32">/);
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

  const station = await get("/");
  const stationHtml = await station.text();
  assert.equal(station.status, 200);
  assert.match(stationHtml, /data-default-mascot/);
  assert.match(stationHtml, /src="\/mark\.svg" data-theme-mascot/);
  assert.equal(ready.stderr(), "");
});
