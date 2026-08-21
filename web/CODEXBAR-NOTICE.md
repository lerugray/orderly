# CodexBar quota adapter notice

ORDERLY dashboard v1 is tested against and pins the CodexBar CLI at **v0.49.6**.
It consumes only the documented read-only JSON contract; no CodexBar source code
or user interface is included in ORDERLY.

Two transports carry that same pinned contract:

- **`codexbar-loopback`** (recommended) reads the documented `codexbar serve`
  HTTP endpoints on a loopback bind: `GET /health` for the running build, and
  `GET /usage?provider=<id>`, which is unauthenticated on loopback and returns
  the same document `usage --format json` prints. The server runs as the
  credential-owning user, so the ORDERLY web service holds no provider
  credential and no CodexBar config file. A host unit is in
  [`codexbar-serve.service`](codexbar-serve.service).
- **`codexbar-cli`** execs the CLI with fixed, read-only argv. This requires the
  ORDERLY web service to be able to read the provider credentials itself.

The dashboard token and `/dashboard/v1/snapshot` route are deliberately unused:
that route requires a bearer token, and the loopback transport is chosen
precisely so the desk holds no secret at all.

CodexBar is copyright Peter Steinberger and contributors and is distributed
under the MIT License. Upstream project and license:

- https://github.com/steipete/CodexBar/tree/v0.49.6
- https://github.com/steipete/CodexBar/blob/v0.49.6/LICENSE

The adapter refuses any other reported CodexBar version. Install the matching
Linux CLI release and verify its published SHA-256 checksum before enabling a
subscription.

## MIT License

Copyright (c) 2026 Peter Steinberger

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
