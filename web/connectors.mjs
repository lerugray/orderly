// The source checkout keeps the connector framework beside web/. The installed
// front door carries the two control modules in its own application directory.
// Resolve that packaging difference without changing the control API.
import { existsSync } from "node:fs";

const installed = new URL("./connectors/control.mjs", import.meta.url);
const source = new URL("../connectors/control.mjs", import.meta.url);
const control = await import(existsSync(installed) ? installed : source);
const installedRuntime = new URL("./connectors/runtime.mjs", import.meta.url);
const sourceRuntime = new URL("../connectors/runtime.mjs", import.meta.url);
const runtime = await import(existsSync(installedRuntime) ? installedRuntime : sourceRuntime);

export const confirmAttachment = control.confirmAttachment;
export const connectorControlView = control.connectorControlView;
export const ConnectorRefused = control.ConnectorRefused;
export const proposeAttachment = control.proposeAttachment;
export const activateAttachment = control.activateAttachment;
export const transitionAttachment = control.transitionAttachment;
export const ATTACHMENT_PROBES = control.ATTACHMENT_PROBES;
export const ConnectorRuntimeRefused = runtime.ConnectorRuntimeRefused;
export const requestConnectorLifecycle = runtime.requestConnectorLifecycle;
