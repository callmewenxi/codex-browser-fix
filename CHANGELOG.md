# Changelog

## Unreleased

- Discover the extracted Windows computer-use runtime, including its browser-desktop and CUA browser-service copies.
- Support Windows user-cache browser service discovery, patching, checking, and restoration.
- Keep Windows patch state in `%USERPROFILE%\.codex-browser-windows-fix\` and run CLI coverage on Windows CI.

## 0.1.0 - 2026-09-24

Initial public experimental release.

- Add a local request-identification callback for recognized Chrome/Edge extensions on macOS.
- Provide apply, check, JSON reporting, and restore commands with content-addressed backups.
- Require exact original and patched hashes for restoration; refuse missing state, mismatched backups, and later edits.
- Return a failing status for missing targets or any unsuccessful target, and validate CLI arguments.
- Document historical desktop 26.915.31945 verification and the successful unpatched Chrome test on 26.917.71314.
- Include temporary-fixture regression tests and macOS CI for Node.js 20 and 22.

The release is not a blanket compatibility claim. Test the unmodified browser integration first. Optional app-bundle edits invalidate its signature.
