### Changed

- Bring upstream OpenBot 0.58.0 and mobile 1.4.5 into the private Windows and Android builds. Keep local accounts, saved devices, private HTTPS/WSS, history, and the independent app identities.
- Let the private mobile transport carry agent-import and instance-transfer files up to the upstream 100 MiB limit. Keep the upstream 10 MiB limit for ordinary attachments.
- **Update the existing private installation in place, keep its Windows profile path, and install the Android update without uninstalling or clearing application data.** Existing phone pairings and histories are intended to remain available. A company computer needs its own host identity and a separate phone pairing.
- Keep the private account and connection flow. Upstream desktop and web connection improvements do not establish a fix for phone Tailscale relay throughput.

### Fixed

- Use the upstream Codex diagnostic handling to avoid error notifications for harmless startup records. Keep provider protocol errors and process-exit handling.
