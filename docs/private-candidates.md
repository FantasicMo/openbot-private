# Private candidate checks

These workflows build candidates. They do not publish GitHub Releases, change an update feed, use
the official signing environment, or configure Tailscale. Start them manually on the intended fork
branch after the source is available in GitHub Actions.

## Verification

`Verify private access` (`private-verify.yml`) runs on Ubuntu 24.04 with Node 24.22.2, Bun 1.4.2 and a
frozen lockfile. It checks source lint, shared UI rules, the private package, main/preload, renderer and mobile consumer types,
the three private service E2Es, and the selected IPC, preload, CSP and permission tests. The Windows
candidate calls this same workflow and cannot build if verification fails.

The three reports have different scopes. Gateway E2E uses a fixture authority; host E2E uses real
TeamStore and account-boundary services with fixture HTTP/WS routes; mobile E2E uses real private
mobile transports and TeamStore with fixture native and Team API ports. None proves native Android,
TLS, a tailnet connection or model-provider execution.

## Windows candidate

`Build private Windows candidate` (`private-windows-candidate.yml`) builds Windows x64 on
`windows-2025`. It uses the same pinned toolchain and frozen lock, prepares the existing pinned
voice, remote-desktop and computer-use resources, verifies the preload bundle, and packages with
`OPENBOT_PRIVATE_BUILD=1` and `electron-builder.private.yml`. The private installer is unsigned for
internal testing. Do not describe it as a trusted-publisher release.

`scripts/private-windows-installer-e2e.ts` runs only on a disposable Windows GitHub Actions runner.
It refuses an existing private installation, profile or workspace. It uses the real NSIS installer,
default `OpenBot Private` installation/data paths, hardened Electron fuses and an owned CDP
connection to the installed application. It does not use the official installer cleanup script.

The smoke checks private build metadata, the signed-out account boundary, renderer Node isolation,
real TeamStore pairing through the private gateway, authenticated Team API HTTP, event WebSocket
subprotocols and runtime snapshots. It revokes device A while device B stays active. It then stops
the owned process tree, reinstalls the same candidate, starts it again, checks host/session and
canary-file persistence, and uninstalls only that private application. The official protocol
registration and the prepared official installation/data roots must remain unchanged. Before the
first install, the disposable runner creates one harmless sentinel in each official profile and
workspace root with exclusive file creation. An existing sentinel makes the smoke stop without
overwriting it. After install, reinstall and uninstall, the smoke checks both contents and SHA-256.
The report records the sentinel hashes, whether their roots existed before the test, and each
completed verification phase. This proves preservation of those sentinel files, not an inventory
of all pre-existing official user data. The test does not delete the sentinel files or their roots.

The screenshot records the installed app screen. It is not proof that provider setup or a task ran.
The smoke also opens a new explicit profile whose path contains spaces. It enables the existing
private Windows login item through trusted IPC, reads its exact registry command and approval,
relaunches the owned executable with the stored quoted argument, and checks the same host identity
and enabled setting. It then removes only the CI-created private item and verifies its absence.
An existing private Run or StartupApproved value stops the smoke before any change. An actual
Windows sign-in is a separate check; this smoke does not change this computer's login items.
The report also excludes TLS/Serve, Android, remote desktop/browser streaming, older-release
migration, normal tray shutdown, SmartScreen and Authenticode publisher acceptance. No owner secret,
device credential, pairing offer, profile, raw application log or workspace is uploaded.

## Download and retain accepted bytes

A successful Windows run uploads `private-windows-<commit>-<run-id>-<attempt>` with the installer,
redacted installation report, `candidate.json` and `SHA256SUMS.txt`. The manifest records the exact
commit, lockfile hash, tool versions, run attempt and artifact hashes. Compare the installer against
the checksum file before installation. `private-windows-smoke-*` and `private-verification-*` hold
the limited check evidence, including failure reports when available. Artifacts expire after 30 days.

Record the run URL and installer hash with manual Windows/Android acceptance. Keep those exact
accepted bytes for later publication. A rebuild is a new candidate and needs its own acceptance.
Adding these workflows or passing static checks is not evidence that a cloud build or installed
application passed. The first executed run must produce its own reports.

## Opt-in real Codex task checks

`scripts/private-live-task-smoke.ts` uses the existing private development host and its existing
Codex agent. It requires an exact registry instance, HTTPS origin, agent ID, `--allow-mutations`
and `--run-codex-task`. It verifies registry/CDP ownership, pairs one temporary admin device, and
uses the portable mobile client with the released HTTP codecs over real HTTPS/WSS. Do not put
provider credentials or a real tailnet identity in CI to run it.

```powershell
bun scripts/private-live-task-smoke.ts --instance=<instance-id> --origin=https://<host>.ts.net `
  --agent-id=<agent-id> --allow-mutations --run-codex-task --case=receipt-file
bun scripts/private-live-task-smoke.ts --instance=<instance-id> --origin=https://<host>.ts.net `
  --agent-id=<agent-id> --allow-mutations --run-codex-task --case=queue-cancel
```

Run the cases in order on an idle agent. `receipt-file` submits the same request ID twice, checks
stable message/delivery IDs and a single projected message, then compares the exact output bytes
and SHA-256 through both local storage and authenticated HTTP. Receipt status may change between
the requests. This deliberate retry does not simulate a lost response or every network failure.

`queue-cancel` requires the existing queue setting. It asks one run-marked question, verifies that
the exact turn and question are still pending, then queues and cancels a second owned message.
It checks the queued delivery never gained a turn, interrupts only the first owned turn, and
requires matching delivery, WSS completion and fresh runtime evidence. No fixed sleep proves a
state transition, and a missing question tool fails the check.

The scripts retain their own messages and files for review and remove only their run devices.
Reports under `.openbot-build/private-live-task-smoke/` record the checkout commit, dirty state,
fixed failure stages, receipts, hashes and cleanup result. They contain local host identifiers and
must stay out of public artifacts. The report is not an attestation of the running app's build or
proof of native Android behavior. A failed run can leave its own unfinished task for inspection.
