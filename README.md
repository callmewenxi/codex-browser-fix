# codex-browser-mac-fix

[![Tests](https://github.com/callmewenxi/codex-browser-mac-fix/actions/workflows/test.yml/badge.svg)](https://github.com/callmewenxi/codex-browser-mac-fix/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

An experimental macOS and Windows compatibility patch for the browser service used by Codex Desktop with the Chrome/Edge extension and an API key or custom model provider.

**Test browser operations before applying this patch.** On the author's current installation, desktop version `26.917.71314` works without this patch. An absent patch marker does not mean your browser is broken.

This is an independent, unofficial project, not affiliated with or endorsed by OpenAI, Google, or Microsoft. It modifies local desktop runtime files, not the installed Chrome extension. No vendor runtime, extension package, credentials, or personal backups are distributed.

## When this may help

The extension is connected and browser discovery succeeds, but tab commands fail with:

```text
Codex auth token is unavailable
```

The related upstream report also describes `unsupported Codex auth method: apikey`. This patch addresses a specific request-identification policy lookup; it is not a general fix for disconnected extensions, network failures, login issues, website access restrictions, or popup preparation failures.

## Compatibility and evidence

| Component | Scope / evidence |
| --- | --- |
| Operating system | macOS and Windows; Windows source matching and CLI tested with Codex Desktop 26.924.22138 |
| Intel Macs | No architecture-specific patch code, but not tested |
| Linux | Not supported by this patcher |
| Node.js | 20 or newer; Windows validation uses 24.19.0; no npm dependencies |
| Desktop 26.915.31945 | Historical local record reports the auth error before patching and successful Chrome tab listing after patching and resetting the browser runtime |
| Chrome extension 1.26.901.11451_0 | Extension version in that historical verification record |
| Desktop 26.917.71314 | On 2026-09-24, discovery found four unpatched user-cache service files. A live Chrome extension test successfully created, listed, read, refreshed, and closed an example.com tab without reapplying the patch |
| Edge | Stable extension ID recognized by the code; no local end-to-end Edge verification |
| Other / future desktop versions | Unverified; directory layout and minified code can change |

The historical record is not a new reproduction on the old desktop version. The newer successful test does not establish whether the vendor fixed the issue or another local condition changed. The release's automated tests exercise synthetic fixtures and policy decisions, not full vendor runtime behavior.

The local desktop app is named `ChatGPT.app`, while its browser integration and this repository refer to Codex Desktop. The optional app-bundle path is specifically `/Applications/ChatGPT.app`; renamed or differently installed applications are not automatically discovered.

## How it works

The bundled service normally asks a cloud-backed feature gate named `codex_browser_use_agent_request_header` whether an extension must attach agent-identification headers. In the affected runtime, resolving that gate depends on caller authentication. API-key/custom-provider sessions can fail at that step before a tab operation is dispatched.

The patcher finds exactly one known browser-client constructor expression and wraps its request-identification callback. The wrapper returns `true` locally only when:

1. The client is an extension with a recognized family and stable extension ID.
2. The extension advertises a boolean `agentRequestHeaderEnabled` capability and a nonempty instance ID.
3. A session ID and turn ID exist, and the same client and session/turn are still current after the asynchronous file read.
4. A small regular JSON control file contains `schema: 1` and `requireIdentification: true`.

Otherwise, it calls the original vendor callback. Returning `true` **requires agent identification**, rather than suppressing it. The original runtime and extension still perform browser operations. Their existing website restrictions, enterprise policies, approvals, and stop handling are not replaced by this code. The patch does not create credentials, change `auth.json` or `config.toml`, or provide cloud authentication.

Before writing a patch, the script requires an unambiguous source match, checks the generated JavaScript syntax, and saves a content-addressed original plus SHA-256 hashes. This is a source-shape check, not a version allowlist or proof of compatibility. File updates are not transactional across all discovered copies; inspect every reported result.

## Installation and use

Install Node.js 20+ from [nodejs.org](https://nodejs.org/) and configure the desktop app and its official browser extension first. This repository does not install either application or the extension.

Clone the repository into any ordinary directory:

```sh
git clone https://github.com/callmewenxi/codex-browser-mac-fix.git
cd codex-browser-mac-fix
node codex-browser-mac-fix.mjs --help
```

Alternatively, download and extract GitHub's source ZIP, then open a terminal in the extracted directory. No `npm install` is needed.

Try listing tabs and opening/reading a harmless page through the extension. If that works, **do not apply the patch**. If the affected authentication error is reproducible, quit the desktop app, then run:

```sh
node codex-browser-mac-fix.mjs
node codex-browser-mac-fix.mjs --check
```

Restart the desktop app and test real browser operations again. Default targets are under the current user's `~/.codex/` (Windows: `%USERPROFILE%\.codex\`) and normally require no elevated permissions.

### Target discovery

The patcher searches the following locations for `scripts/browser-service.mjs`:

- `$CODEX_HOME/plugins/cache/openai-bundled/`
- `$CODEX_HOME/.tmp/bundled-marketplaces/openai-bundled/plugins/`

`CODEX_HOME` defaults to `~/.codex`. Only the known directory depths are searched; newer layouts may need code changes. Advanced users can supply an explicit file with `--file /absolute/path/to/browser-service.mjs`, repeated for multiple targets.

### Local data and directory placement

The repository and script can live anywhere. Runtime data is written to `~/.codex-browser-mac-fix/` on macOS or `%USERPROFILE%\.codex-browser-windows-fix\` on Windows:

```text
~/.codex-browser-mac-fix/
  control.json   # Local policy, created on first apply
  state.json     # Target paths and original/patched hashes
  backups/       # Originals needed for restoration
```

The leading dot makes the directory hidden by the normal macOS/Unix convention, but not on Windows. It is not encryption. The control file's absolute path is embedded in patched service files, so keep this data directory in place while using the patch. Do not share its contents or copy it between machines.

Default control file:

```json
{ "schema": 1, "requireIdentification": true }
```

Setting the flag to `false` hands the decision back to the vendor callback; it does not force identification off. Restart the desktop app after changing it because the service can retain an already-enabled decision. Restoring files also does not guarantee clearing identification state retained by the extension.

### Restore / uninstall

Quit the desktop app, then run from the repository directory:

```sh
node codex-browser-mac-fix.mjs --restore
```

Restart the app afterward. Restore requires a recorded state entry, an unchanged patched-file hash, and an exact original-backup hash. It refuses unknown or modified files instead of guessing another version's backup. Keep the data directory until every intended target has been restored. There is no background daemon or scheduled task to uninstall.

### Optional app-bundle patching

On macOS only, `--include-app-bundle` additionally targets two known browser-service copies inside `/Applications/ChatGPT.app/Contents/Resources/cua_node/`. These are associated with the unified computer-use browser backend in the inspected layout. Windows discovery is limited to the user plugin cache; use `--file` for an explicitly inspected alternative copy.

**This invalidates the app's code signature and can affect Gatekeeper checks or macOS privacy permissions.** It is not the default or recommended first step. The default patch does not edit the app bundle, desktop accessibility backend, or in-app browser implementation. If you deliberately used this option, also include it when checking or restoring:

```sh
node codex-browser-mac-fix.mjs --restore --include-app-bundle
```

Do not disable macOS security protections to accommodate the patch. Restoring the exact original resources can repair a signature seal broken only by those resource edits; unrelated changes are outside this tool's scope.

## Updates, reports, and exit codes

Desktop updates may overwrite the patch. Test browser operations again before deciding to reapply. Do not restore an old runtime over a new version. `--check` examines source markers only; it does not test authentication, control-file contents, the loaded worker, or browser functionality.

```sh
node codex-browser-mac-fix.mjs --check --json
```

| Exit code | Meaning |
| --- | --- |
| `0` | Every discovered target has a successful status for the requested mode |
| `1` | At least one target is unpatched, unsupported, or could not be safely handled |
| `2` | No targets found, invalid arguments/platform, or an execution error |

`unpatched` means a matching source shape without the marker, not proof that patching is necessary. `unsupported`, `no-match`, or `ambiguous` require investigation. `modified-since-patch`, `no-state`, and `no-matching-backup` deliberately prevent unsafe restoration. An error can occur after other targets have already been changed; review the report and retain backups.

## Development

```sh
npm test
```

Tests use temporary files and synthetic JavaScript, never your installed service or real patch state. GitHub Actions runs the suite on macOS and Windows with Node.js 20 and 22.

See [CONTRIBUTING.md](CONTRIBUTING.md) for useful bug-report details. Do not upload authentication files, tokens, browser history, personal state files, or vendor runtime backups.

## Attribution and license

Inspired by the Windows request-identification compatibility approach in [BigPizzaV3/CodexPlusPlus PR #2208](https://github.com/BigPizzaV3/CodexPlusPlus/pull/2208). This implementation does not provide that project's complete fingerprint validation or lifecycle management.

Repository code is released under the [MIT License](LICENSE). Third-party applications and extensions remain subject to their own licenses and terms.
