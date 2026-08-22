# ORDERLY connector framework

This directory is the v0.4 connector control plane. It provides:

- a compiled, non-authoritative catalog (`catalog.mjs`);
- a mode-0600 instance and attachment record with reviewed digests (`control.mjs`);
- a fixed HTTP-over-Unix-socket service boundary for provider adapters (`service.mjs`);
- a bounded client for that socket (`client.mjs`);
- a host-local administration command (`connectorctl.mjs`);
- a fixed host probe-program boundary (`probes.mjs`); and
- a typed runtime lifecycle controller (`runtime.mjs`).

The catalog is intentionally broader than the adapters that exist today. A catalog entry
does not install anything. A usable connector still needs one provider-specific adapter,
one external account, one service identity, one unit, one socket, one reviewed operation
set, and recorded verification results.

Google Workspace is represented by separate Gmail, Calendar, Drive, Docs, Sheets, Tasks,
and Contacts kinds. There is no broad Workspace kind.

## State progression

```text
catalog kind
  → host registers an instance (pending)
  → service and scope checks pass (active instance)
  → operator reviews an agent attachment digest (approved-pending-runtime)
  → derived socket mount checks pass (active attachment)
```

The Agents page can perform the reviewed attachment ruling and request suspend, resume, or
detach through the fixed host runtime socket. It cannot register an instance, provide
account material, name a route, submit probe booleans, or mark a runtime active. Those
remain host actions.
The review names and digest-binds the compiled provider endpoint allowlist. A kind with no
compiled endpoint list cannot be activated.

## Host control

The command reads a small JSON object from stdin. It never accepts provider account
material. Example registration:

```bash
sudo -u orderly-web /usr/bin/node /var/lib/orderly-web/connectors/connectorctl.mjs register \
  --state /var/lib/orderly-web/.orderly/connectors.json <<'JSON'
{
  "id": "drive-personal",
  "kind": "google-drive",
  "label": "Personal Drive",
  "accountLabel": "Personal workspace",
  "operations": ["files.list", "files.read"]
}
JSON
```

List the sanitized control view:

```bash
sudo -u orderly-web /usr/bin/node /var/lib/orderly-web/connectors/connectorctl.mjs list \
  --state /var/lib/orderly-web/.orderly/connectors.json
```

Activation runs the host-installed absolute `--probe-program` once for every exact name
exported by `INSTANCE_PROBES` or `ATTACHMENT_PROBES`. The program receives fixed argv and
must return bounded positive JSON evidence. The command no longer accepts caller-submitted
result booleans, so a control request cannot assert that a container probe passed.

Suspension and detachment require the runtime controller to remove the route first. Resume
restores the derived route and reruns every mount and negative-access probe; a failed resume
attempt rolls the route back and leaves authoritative state suspended. Control writes take an
exclusive sidecar lock as well as checking the state revision, so two administration
processes cannot silently replace one another's ruling.

## Adapter contract

An adapter starts `listenConnectorService` with:

- its instance and compiled kind;
- the installed operation ids;
- `surface: "agent"` or a separately deployed approval surface; and
- one handler per operation, each declaring its accepted input keys.

The framework accepts only `POST /v1/call` and the envelope
`{v, operation, requestId, input}`. Provider-specific handlers still validate value types
and limits for their own fields. Adapter errors return a fixed message; provider response
detail stays in that connector service's local journal.

This release does not enable an `apply` operation through the generic service. Apply stays
refused until a connector-specific approval adapter installs a persistent replay guard;
agent surfaces refuse it in every case. A successful result carries connector id,
operation, request id, time, and the untrusted-data attribution.

## Tests

```bash
node --test connectors/test/*.test.mjs
```

The web, broker, and calendar suites remain part of the full station check.
