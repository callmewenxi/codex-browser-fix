# Contributing

Open an issue before proposing support for a new runtime layout. Include:

- macOS version and CPU architecture.
- Desktop app version, installation name/path, and extension version.
- Browser family and whether authentication uses ChatGPT login, an API key, or a custom provider. Never include credentials or provider secrets.
- The exact error, whether it happens without the patch, and minimal reproduction steps.
- Sanitized `--check --json` output; replace your home directory with `~`.

Do not attach proprietary service files, backups, `state.json`, `auth.json`, tokens, or private browsing data. A patch marker alone is not evidence of functional success.

Use Node.js 20+ and run `npm test`. Tests must operate on temporary fixtures, not installed apps. For compatibility claims, distinguish source matching from an actual browser test and document both pre-patch and post-patch behavior. Keep fixes narrowly scoped and preserve vendor fallback behavior.
