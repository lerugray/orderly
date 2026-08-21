<p align="center">
  <img src="assets/logo.svg" width="170" alt="ORDERLY mascot">
</p>

<h1 align="center">ORDERLY</h1>

<p align="center">A self-hosted personal AI assistant. Your own hardware, your own model subscriptions, your own trust model.</p>

---

ORDERLY handles the generic life admin people buy "AI assistant" products for: email triage and drafting, calendar, reminders, scheduling. It runs on an always-on box you own, answers only you, and the model backend is your choice.

This repository is the **implementation** — the broker, the web front door, the specs, and the tests. The operational half of the recipe (install runbooks, host wiring, deployment configuration, and the security review trail) lives in a private sibling repository, because those documents describe one specific installation rather than the software.

<p align="center">
  <img src="docs/screenshot-web.png" width="820" alt="The ORDERLY front door: duty state from a live probe, the day, and chat at two desks">
</p>

<p align="center"><em>The front door, on the operator's own tailnet. Duty state comes from a live probe of the gateway, not a hardcoded claim.</em></p>

## What it takes to run

- An always-on Linux host you own, with a current Node.js and Docker or Podman for the per-agent sandboxes.
- [OpenClaw](https://github.com/openclaw/openclaw), the MIT-licensed agent gateway this recipe configures.
- A chat channel for the operator. Telegram is what the station was built and verified on; Discord is a documented alternative carrying the same single-operator posture — one named user, DMs only, no server surface.
- A model provider credential. Any provider OpenClaw supports is a config edit.

The gateway binds loopback only. Both surfaces are published to the operator's own tailnet by Tailscale Serve — the front door at `/`, the OpenClaw console at `/openclaw` — with an SSH tunnel as the fallback path. Nothing is published to the internet, and `tailscale funnel` is never used here, because that would publish it.

## Why build it yourself

Cloud agent products charge $200-300 per month for a managed assistant that reads your email and calendar on someone else's computers. That's convenient, and it means a third party holds your credentials, your messages, and the off switch.

ORDERLY inverts that:

- The gateway runs on hardware you own. Nothing leaves your network by default.
- The model spend is a flat-rate subscription you already have. No per-seat pricing, no usage meter.
- The trust model is auditable: the code is in this repo, with the reasoning beside it.
- If a provider changes terms or raises prices, you swap a config line. The plumbing is yours.

In exchange, you run the box and you own the failures. The recipe exists to make that tractable for one operator.

## Architecture at a glance

```
chat channel ──────────────┐
                           ├──▶ OpenClaw gateway (always-on box, loopback only)
Browser ──▶ front door ────┘         │
            (own process,            ├──▶ coordinator agent ──▶ model API (your choice)
             holds the token)        │
                                     └──▶ specialist agents, each in its own Docker sandbox
```

- **OpenClaw gateway**, loopback only, reached over the operator's own tailnet. No public endpoint exists.
- **The chat channel** is the primary surface; the ORDERLY front door is the second, and the gateway's own console (transcripts, scheduled tasks, tool policy, logs) stays the full panel behind it.
- **A Docker sandbox per agent**: no network, read-only filesystem, no privileges, unprivileged user. The single exception is the coordinator's own workspace, mounted read-write so his memory notes persist. Connectors are skills wrapping CLIs, and running a CLI means `exec`, so exec lives only inside the containers, with host escape (`tools.elevated`) disabled. The one agent that needs the internet gets it alone.

## The front door

The second surface is a small branded page that runs beside the gateway in its own process, on its own loopback port, under its own service unit. It has no dependencies past Node's standard library and no webfonts, CDN or analytics, so opening it sends nothing off the box. Installing or upgrading it never touches the gateway's config or process.

- **Duty state, from a live probe.** Every poll asks the gateway's `/health` and the service manager. The mascot is the indicator: on duty he blinks and looks around, off duty he desaturates and half-closes his eye. Nothing on the page is a hardcoded claim.
- **The duty list with real scopes**, including the capability that is switched off.
- **Chat, at two desks.** The coordinator hands the work to a specialist — the mail agent, or the researcher for the web — so his first answer says he's asked; ask again and he carries the result back. The mail desk is that agent directly, and answers first time. Each desk is a continuing session upstream, which is what lets a delegated result be collected at all; the browser names a thread, never a session, and the server builds the key. Naming a desk selects an agent that is already sandboxed; it grants nothing.
- **Results as cards.** Replies arrive as prose, so the proxy asks for one fenced JSON block whenever a reply reports inbox mail, calendar events or a draft. The page lifts that block into a card in the rail and keeps only the judgement in the conversation. A reply without a block is just a reply, a malformed one is dropped, and model output is never treated as markup.
- **Links that are parsed before they are offered.** A reply that names a URL gets a real anchor, but only once the address has survived the URL parser and turned out to be `http` or `https`; anything else stays inert text. The label is always a text node, the href is never assembled by hand, and every link leaves with `noopener noreferrer nofollow`. This is the same rule as the cards, applied to the one thing research replies are full of.
- **Threads that survive a reload, and an archive rather than a delete.** Each desk's conversation is kept in your browser — never on the station — so closing the tab does not lose it. Clearing a desk archives the thread under its first line instead of destroying it; archived threads can be read, restored, or deleted behind a confirm. The ceiling is stated on the page rather than hidden, and if the browser cannot store anything the page says so instead of pretending.
- **The approval queue, which is the shape of the whole product.** Every draft an agent
  writes waits on the front door until you approve or discard it. A card carries where it
  came from — which routine, or which desk you asked — the mailbox it was written in, the
  recipient, and the text when the text is known. **Approving records that you read it and
  kept it. It does not send it**, and the page says exactly that under the button, because
  nothing on this station sends: the queue is the review step, not a new authority.
  Discarding takes the card off the queue and deliberately does not touch the mailbox. A calendar
  proposal is the *opposite* card and is drawn as one — different colour, different word on
  the button, and the confirm dialog sits on approve rather than on discard, because for
  that card approving is the act itself. Drafts
  reach the queue two ways: the coordinator logs the ones it made on its own, and the front
  door files any draft it watches go past in a reply it was already carrying — that second
  path is plumbing rather than a promise, so nothing depends on an agent remembering to
  file its own work. What you decided is kept on this side of the wall and never written
  back where a model could read it or forge it.
- **Calendar writes, and the one place a click actually does something.** He can *propose* an event — a new one, or a change to one already there — and the proposal waits on the queue as a card that is coloured, worded and confirmed differently from a draft, because approving it is not bookkeeping: the event appears, or changes, at that moment. He cannot make it himself. The credential that can lives in a separate store that no agent's container mounts, is used only by the front door, and carries `calendar.events` and no mail scope at all. **There is no deletion**, at any layer this station controls: no verb in the script, no line the agent can write that would express one, and an explicit refusal where one would go. Discarding a proposal does nothing whatsoever, and a write that fails leaves the card waiting rather than recording an approval for a change that did not happen.
- **The day.** A read-only agenda for the next seven days, from the mail agent's existing calendar scope. It reaches nothing the chat could not already reach, it never fires on its own, and it is cached for ten minutes, because the answer costs a model call.
- **Reminders, read but not written.** The coordinator keeps the operator's list in a file in his own workspace; the page opens that file and shows what's outstanding, which costs nothing and needs no model call. There is no control to add or tick one, because scheduling is owner-gated at the gateway and a browser page is deliberately not the owner. The page says so rather than showing a button that would fail.
- **Settings that change which models he thinks with**, and refuse everything else. The rest of that page is a readout, deliberately styled as one.

## Security posture

The design assumes the agent will eventually read hostile text. OpenClaw ships no content-level prompt-injection mitigation by design, so the defense is blast radius, and the architecture is built around it.

- **Single allowlisted operator.** The bot answers one person. Multi-tenant SaaS is a non-goal; "other users" means other people running this recipe on their own boxes.
- **One credential per connector, never the keyring.** Each integration gets its own scoped credential. The bot never holds access to the full credential store.
- **One credential per capability, and write lives apart from read.** The mail agent's store — the one bind-mounted into its sandbox — holds mail-read, drafts and calendar-read. The calendar-WRITE credential is a second store at a path no agent container mounts at all, used only by a host script the front door invokes on your approval. Probed from inside all three live containers: the path does not exist for them, and pointing the CLI at it by absolute path fails on the read-only rootfs. The mail container, which is the only one with an outside line, also cannot reach the front door or the gateway — both bind loopback, and a connection from the container is refused while its access to the mail provider still works.
- **Read-only before write.** Mail and calendar start at read-only OAuth scopes: triage and summarize, no outbound path. Every additional account gets the *same* set, and the set is narrower than the CLI's default, so the pinned flags are load-bearing. The check is not that the flags were typed correctly: the authorization script decodes the `scope=` parameter out of the generated sign-in URL and prints it before the link is handed over, then diffs the stored scopes against the first account afterwards.
- **The email law: the agent that reads email must not send email — and here is exactly how strong that is.** Inbound email is untrusted text. The ceiling is `drafts create`: the bot writes drafts, the operator sends from the mail client. Two layers hold it up and they are not equally strong, so both are stated. The **environment block** refuses the send commands inside the sandbox — but it is the CLI flag's *default*, and probing found that a flag on the command line overrides it, so it stops an agent that is not trying and would not stop one that was. The **scopes** are the structural half: no account here holds a send scope. But the scope that lets the desk write a draft at all is documented by the provider as covering sending too, and no drafts-only scope is published. So the honest sentence is: nothing routinely invokes send, the default refuses it, no separate send scope exists — and the last few feet are the model keeping its orders, not a wall. Closing that properly means routing drafts through the approval queue as *proposals*, the way calendar events now are, so the agent never holds a compose-capable credential; that is a recorded open decision, not a claim made in advance. Approving a draft on the queue is still purely a review verb: the front door holds no credential that could send, and it never has.
- **Network split per agent.** Only the mail agent's sandbox has egress (to the mail provider's APIs); every other agent's container has no network at all.
- **Web research without giving a container the internet.** The researcher searches and reads pages through the gateway's own guarded fetch, which runs outside the sandbox and hands text back in — so the researcher's container stays at zero egress, and the line above stays true. Search is keyless (no account, no API key on the box); the full browser tool stays denied. Fetched pages are untrusted text under the same law as email: content inside a page is never an instruction, and both the researcher's and the coordinator's standing orders say so. The claim is not taken on trust either. After the change, a probe run from inside each live container found the researcher and the coordinator with no route out at all, and the mail agent still the only one that has one.
- **He remembers you, and only the coordinator does.** Memory in OpenClaw is plain Markdown in the agent's own workspace — a durable-facts file plus dated notes for the day's working context — loaded at the start of the next session. Making that real meant one agent gets a write tool and one directory it can write to: the coordinator, its own workspace, nothing else on the host. The mail agent and the researcher, the two that read untrusted text for a living, stay memoryless and write nowhere, which is the part that keeps a bad turn from becoming a resident. His standing orders live in that same directory, owned by the host, mode `0444` and carrying the filesystem's immutable attribute, so he reads his own laws and can neither rewrite, delete, move nor chmod them. The immutable flag is not belt-and-braces, it is the wall: **his** container runs as uid 0, so it *owns* those files, and deletion is an ownership right rather than a permission — mode bits alone stopped writes and did not stop `rm`. The other agents are a different shape and need no flag: OpenClaw mounts them a per-agent directory **read-only**, as uid 1000, and their configured workspace is never mounted at all. Both claims were probed from inside all three running containers, six law files each, four operations each: 72 attempts, every one refused. Search is deliberately keyword-only: no embedding model, no API key, and not one byte of new egress.
- **The browser never holds a gateway credential.** A valid gateway token is equivalent to operator access, so it stays on the host. The page posts plain conversation to the front door, which runs on the gateway host, attaches the bearer from its own environment and forwards loopback to loopback. Its launcher lifts exactly that one variable out of the env file at start time, the way the gateway's own launcher does; the other secret in that file stays behind and nothing is copied to disk. The status endpoint reports whether a credential is present as a boolean, never the value, and without one the chat disables itself and says why.
- **The settings page cannot reach authority.** It edits model choices and model tags. Three independent gates stand between a browser and the config: a typed envelope the browser cannot aim, a diff in which every changed path must match an allowlist, and deep-equality on the guarded subtrees, which are the gateway block, the channels, the bindings, the tool policy, every agent's sandbox, tools and workspace, and every provider's credential reference. The policy guard's rulings must still hold afterwards. Only then is the config backed up beside itself, written to a temp file, fsynced and renamed, so a whole file appears or none does. Writes are same-origin only, one at a time, behind a confirm step in plain English.
- **No credential value ever reaches the UI.** There is no field for a key and there will not be one. The page shows the variable name a provider wants and whether that name is set, and the env reader's pattern has no capture group past the name, so a value cannot be returned even by accident.
- **One named owner, and the front door is not it.** Scheduling — the capability behind reminders and the morning briefing — is owner-gated by OpenClaw, and the owner is one identity on one channel. That gate had been vacuous: with no owner configured, nobody could schedule anything, including the operator. Naming him made it real, and it deliberately did not name the front door: that page holds a gateway bearer so the browser doesn't have to, which is not the same thing as holding the operator's identity, and it is not getting one. So the web desk can read and edit the reminder list and will tell you plainly that it cannot schedule the delivery.
- **The briefing is one-way.** A digest is announced to the operator's chat and that is the end of it: no reply path, no new scope, nothing in it that the chat could not already ask for. If a part of it fails, it sends the rest and names the part that failed — a briefing that is honestly short is correct, one that is quietly wrong is not.
- **No unconfined host shell.** The gateway's terminal tool stays disabled permanently, and a policy-guard document records which settings must never be flipped.
- **Every privilege expansion is a deliberate, recorded decision.** The expansion plan is the audit trail, including open hygiene items. It lives in the private sibling, because it is a record of one installation.

## Model backend is the user's choice

OpenClaw is natively provider-agnostic: any major hosted provider, a local runtime, or any OpenAI-compatible endpoint plugs into `models.*` in the config. Pinning a single flat-rate provider gives the bot exactly one credential rather than a keyring; the recipe accepts any provider, and swapping is a config edit.

## Status

Working today, each verified end-to-end:

- Chat bot, routed to a coordinator with specialist agents
- The front door on the tailnet over Tailscale Serve, with the SSH tunnel as the fallback path: live duty state, chat at two desks, the day's agenda, and settings
- Scheduling (owner-gated): one named identity on one channel is the owner, and nobody else — including this project's own front door — can create a scheduled job
- Reminders and tasks the coordinator owns: he keeps the list in a file in his own workspace, and a timed reminder gets a one-shot scheduled job that arrives in chat at the hour
- A morning briefing: inbox, the day's calendar and what's due, sent to chat once a day. One-way notification, not a conversation, and it sends a partial digest naming what failed rather than inventing the missing part
- Sandboxed tool execution, proven with live agent turns
- Mail + calendar read (read-only OAuth scopes), running inside the mail agent's sandbox
- **Two mailboxes, kept apart.** A personal account and a hosted-workspace account, both read by the same sandboxed agent under byte-identical scopes. Answers name the account they came from, the two are never merged into one list, and the morning briefing carries them as separate labelled sections. A second account is a second refresh token in a keyring that already existed — no new mount, no new privilege, and no container gained a route it did not have.
- Email drafting: the bot creates drafts in whichever account it is answering; sending is structurally blocked and verified refused
- **Mail routines you write yourself.** A line in a file says which mailbox, which query, and whether a match should notify you, draft a reply, or both — and that is the whole vocabulary, because the scopes cannot archive, label, forward or delete. A poll on the owner-gated scheduler runs them; a poll with nothing new answers with the silent token and posts nothing, so it does not become a notification every ten minutes. A routine never fires twice on the same message, and if the file that guarantees that cannot be read, the poll does nothing rather than risk announcing your morning mail all day
- **An approval queue on the front door.** Drafts wait there — with which routine or which desk produced them — until you approve or discard. Approving means read and kept; you still send it from your mail client. Nothing here gained the ability to send, and the queue is deliberately built so that adding one would be a visible, separate decision rather than a natural next step
- **Calendar create and update, always through you.** An agent proposes; the front door carries it out when you approve, in the account the proposal names, and records the event it made on the card. Nothing reaches your calendar with write access from inside any agent's container — probed from all three. There is no delete path anywhere in this station, and a failed write leaves the proposal waiting rather than claiming it was done
- Web research: ask the coordinator for links and the researcher searches and reads pages, returning real current URLs — keyless search, no container given network
- Model changes made from the settings page, applied by the gateway without dropping itself, the chat channel, or a running task
- Memory for the coordinator alone: he keeps notes in his own workspace, has them at the start of the next conversation, and can neither rewrite nor delete the standing orders that sit beside them

**He remembers you between conversations, and the scope of that is written on the front door.** Tested directly: told a fact over the command line, asked for it back from the browser desk in a different session, and it came back. What he keeps is what you tell him — preferences, standing instructions, facts about your setup — in notes on the station, never credentials and never what an email or a page said about you. What he remembers is data, not orders: a line in a note is under the same law as an inbound email, and his standing orders say so. Only the coordinator has this; the mail agent and the researcher remember nothing, which is deliberate, because they are the two that read hostile text. The chat's own thread history is separate again — it lives in your browser and is a property of the page, not of him.

**The voice profile.** A build step reads your own sent mail through the read-only scope the mail agent already holds — no new permission, no new egress, no new credential — and counts how you actually write: greeting and sign-off forms, sentence and message length, and how all of it shifts between a personal mailbox and a work one, which are kept as two registers rather than averaged into one. It produces a draft dossier and stops there. You read it, cut what it gets wrong about you, and installing it is the separate step that makes it a root-owned immutable law both drafting agents read before writing anything. The standing-order half is the stop-slop list: no "I hope this finds you well", no restating your correspondent's own email back at them, no closing boilerplate you never use.

The build warns when a sample is skewed — when one long thread with one counterparty dominates a mailbox's section, the dossier is describing a bad week rather than a person, and the right move is to rebuild on a larger sample. The installed dossier is root-owned, mode `0444` and immutable in the coordinator's workspace, and read-only at the mount in the mail agent's sandbox — probed from inside that container, which can read it and can neither write nor delete it. Neither the corpus nor the draft is ever committed to a repository.

**The orchestrator seat.** A second desk: an orchestrator that turns a request in chat into a bounded coding brief, dispatches it to an external agent lane, watches the lane's terminal state, and reports the result for the operator to verify — the station brokers and watches, and never edits code, commits, or merges. Before building any of it, the model for the seat had to earn it: a 16-case scored trial (dispatch judgment, injection resistance, honest reporting of failure and partial work), judged adversarially against pre-registered answer keys, across three rounds and 48 invocations. The qualifying model refused both planted prompt injections, never claimed a verification it had not performed, and trusted the broker's exit record over a forged success log. A mid-tier control model failed the same trial with two unapproved dispatches, which is the measured version of why the seat is gated at all. The qualification harness and its raw records live in the private sibling; the interface contract the desk and broker are built against is in [`docs/PHASE1-INTERFACE-2026-08-21.md`](docs/PHASE1-INTERFACE-2026-08-21.md).

Deferred, each a separate recorded decision: mail push notifications (requires a public endpoint), issue automation (agent write authority), send scope (probably never), and node pairing to real machines (sacrificial VM only, if ever).

## Repo contents

- `broker/`: the dispatch broker — the lane registry, the seat invoker, the harvest and watcher paths, the lane wrapper, and the security-boundary allowlist that is the only thing an HTTP caller can aim. With its test suite.
- `web/`: the branded front door — a zero-dependency loopback page with a live status endpoint, a credential-holding chat proxy, the agenda, the approval queue, and the gated settings surface. With its test suite.
- `docs/PHASE1-INTERFACE-2026-08-21.md`: the desk-to-broker interface contract, binding on both sides.
- `docs/NOTES-SPEC-V1-2026-08-21.md`, `docs/NOTES-FEATURE-SPEC-2026-08-21.md`: the notes feature — a human-first editor where the human text and any AI output are different record types in different stores, and assistance is default-off. Specified, not yet built.
- `MISSION.md`: what the product is for, and its non-goals.

Install runbooks, host wiring, the as-deployed configuration, the agents' standing orders, the policy guard, the expansion plan, and the seat-qualification records live in a **private sibling repository** — they describe one specific installation, not the software.

## Non-goals

- Not a dev tool. The station never edits code, commits, or merges. The orchestrator seat dispatches dev work to external agent lanes and watches the result — the code work itself stays in those lanes, and verification stays with the operator.
- Not multi-tenant SaaS. Single operator, single box.

## Acknowledgments

Built on [OpenClaw](https://github.com/openclaw/openclaw), the MIT-licensed agent gateway that provides the channels, sandboxing, and provider abstraction this recipe configures.

Released under the MIT license — see [`LICENSE`](LICENSE). Fork it and wire it to your own subs.
