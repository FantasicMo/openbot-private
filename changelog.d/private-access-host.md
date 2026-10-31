### Added

- Private fork builds now create an isolated local host identity before the host service starts, keep
its owner secret in OS-backed secret storage, and select local TeamStore membership without a fake
account. They can run a local workspace before a Tailscale Serve origin is configured. Account
startup, official host publishing, telemetry tracking and official updates stay off in private mode.

- Private packaged launches with an explicit `--user-data-dir` keep new workspaces under that profile,
as development does. Default packaged paths remain separate. This does not move existing workspaces
or rewrite stored agent paths.

- Add trusted private pairing/configuration/revocation IPC, independent preload decoding, safe device
status and a shared Android pairing-offer schema. Added a focused real-TeamStore persistence and
revocation E2E; packaged desktop, Serve and Android acceptance remain separate checks.

### Fixed

- Preserve unreadable private connection settings when revoking devices. The device and its
sessions are still revoked, while unknown-version or damaged settings keep their original bytes.
