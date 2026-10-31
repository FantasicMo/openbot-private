### Added

- Add manual private verification and Windows x64 candidate workflows with pinned Node/Bun,
frozen dependencies and no Release publication. Accepted installer artifacts include source,
lockfile, run-attempt and SHA-256 provenance.

- Add a CI-only private installer smoke that drives the installed app's real account boundary,
Team API, pairing gateway, WebSockets and revocation, then checks reinstall persistence and data
preservation on uninstall. Harmless official profile/workspace sentinels are created without
overwriting existing files and checked by content and SHA-256 after each installer phase.
Tailscale TLS, providers, Android and streaming remain separate checks.
