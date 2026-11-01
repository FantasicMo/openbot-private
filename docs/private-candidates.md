# Private candidate checks

These workflows build candidates. They do not publish GitHub Releases, change an update feed, use
the official signing environment, or configure Tailscale. Start them manually on the intended fork
branch after the source is available in GitHub Actions.

## Verification

`Verify private access` (`private-verify.yml`) runs on Ubuntu 24.04 with Node 24.22.2, Bun 1.4.2 and a
frozen lockfile. It checks source lint, shared UI rules, the private package, main/preload, renderer and mobile consumer types,
the three private service E2Es, and the selected IPC, preload, CSP and permission tests. The Windows
candidate calls this same workflow and cannot build if verification fails.
It also runs the protected backend migration fixtures and the real database tests with one worker.

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
subprotocols and runtime snapshots. It revokes device A while device B stays active. It then requests
normal quit through verified CDP and waits for the exact owned process to exit. A bounded forced
cleanup makes that lifecycle step fail. After quit, it checks that Windows `Local State` holds an
encrypted key, and records only that file's hash and the encrypted owner file's hash. It reinstalls
the candidate and compares those files before the next launch. Chromium can change `Local State`
during a normal launch, so the test does not require its hash to stay fixed across launches.
The smoke then starts the app again, checks host/session and
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
The report also excludes TLS/Serve, Android, remote desktop/browser streaming, tray interaction,
hard-crash/power-loss durability, SmartScreen and Authenticode publisher acceptance. No owner secret,
device credential, pairing offer, profile, raw application log or workspace is uploaded.

The early forced-stop failure was reproduced without an installer using cached Electron 44.9.3 and
new isolated Windows profiles: immediate process termination left the new encryption key absent
from disk and the ciphertext could not be read on restart; normal `app.quit()` persisted the key
and the same ciphertext decrypted. The installer smoke checks normal restart and update behavior.
It does not claim that a new profile survives termination before Chromium commits its first key.

## Upgrade checks for 0.58.0

The Windows and Android candidate workflows select `verify_upgrade=true` by default. The helper
`scripts/private-upgrade-baseline.py` downloads one pinned package from this private repository.
It checks the run, commit, successful build job, immutable artifact ID and package SHA-256. It
extracts only the expected package basename. It does not accept arbitrary artifact paths. These
baselines were accepted before this upgrade; they contain no live profile or credentials.

| Platform | Baseline source | Immutable artifact | Expected package SHA-256 |
| --- | --- | --- | --- |
| Windows 0.56.0 | `fe73b8506af784873219e41e6758e78f8905de29`, run `41188467812` | `13037872319` | `51e55bb3182b2c43c954589983245813da2202b2680122cd1964c86972be1e4e` |
| Android 1.4.4, versionCode 1003 | `ade0c7cb71c37101f65f0906b64fe701c1153b3f`, run `41185911155` | `13038201558` | `ba6a54d92cfbf75c1a4c91aa54ef32c981ebd97605c23781ca0ce83cb5fbbc87` |

Windows installs the old package into the empty disposable runner first. It creates two test
devices, revokes one, and writes two direct messages with the real IPC and authenticated Team API.
It then quits normally and installs the new candidate in place. It checks the saved encryption
state before launch, new application version, host identity, gateway configuration, retained
device session, and both messages' exact IDs, text and order from desktop and phone-facing APIs.
It also reinstalls the same candidate and repeats the session/history read. The default paths,
canary files, official sentinels and uninstall checks remain in scope. This proves preservation
of the test data, not every historical user database or a provider conversation.

Android first runs the unchanged candidate's clean-start and egress checks. It then removes only
that CI-created test data and installs the old signed APK in the disposable emulator. The native
HTTPS fixture pairs the old app. After force-stop, `adb install -r` applies the exact new APK with
no data clear. The signer, package and increasing versionCode must match. The app UID must stay
the same. A new fixture listener generation requires authenticated use of the saved session and
a WebSocket upgrade attempt from the new app, with one member and one total pairing redemption.
The fixture cannot establish an accepted WSS session or display real chat history. Chat history
is held on the desktop; the Windows test checks a bounded real message history through the
retained phone session. A physical phone's own existing pairing and history still need an
in-place device check. Do not uninstall the phone app or ask the user to pair it again.

Baseline bytes stay outside the candidate artifact. Only their provenance and redacted check
results are retained. Artifact expiry makes the baseline check fail before installation; do not
substitute a rebuild or silently omit the upgrade check.

After the root integration snapshot is published, dispatch the two candidate workflows on that
same branch. Use Android versionCode 1004 only if it is still unused for the retained signer:

```powershell
gh workflow run private-windows-candidate.yml --repo FantasicMo/openbot-private --ref private/upgrade-0.58.0-20261102 -f verify_upgrade=true
gh workflow run private-android-candidate.yml --repo FantasicMo/openbot-private --ref private/upgrade-0.58.0-20261102 -f version_code=1004 -f verify_upgrade=true
```

Record each run's source SHA before download. Accept only the exact installer/APK hashes in the
successful reports. Keep those bytes for company delivery. A later validator fix can use the
existing Android artifact acceptance workflow with `native_pairing_fixture=true` and
`verify_upgrade=true`; supply that build's run ID, immutable build artifact ID, source SHA,
APK SHA-256 and versionCode. This rerun does not build or sign an APK.

## Recheck an existing Android APK

`Validate existing private Android APK` (`private-android-artifact-acceptance.yml`) can rerun the
emulator acceptance after a test-environment fix without compiling or signing another APK. Supply
the original build run ID, immutable `private-android-build-*` artifact ID, full build commit,
APK SHA-256 and versionCode. The artifact archive digest is not the APK hash.

The workflow checks that the run and successful signed-build job belong to this repository and
source commit, downloads that exact artifact, and checks the expected APK hash, fixed signer,
private package, version and two native ABIs before emulator startup. Its evidence records the
build and validator commits/runs separately and verifies that the APK hash is unchanged afterward.
The Ubuntu runner installs `libpulse0`, which QEMU needs even with audio disabled.

One explicit recovery option is limited to build run `41328430796`, diagnostic artifact
`13093056405`, source commit `ca1bf715eb4699753661b65ac654f4ef4e673d73` and the pinned versionCode1004
APK hash. Native compilation and APK signature verification completed before a Python sibling-module
import failed in the validator. Recovery requires that exact failed step and its original log witness,
keeps `BUILD-FAILED.txt` and the original failure conclusion, and requires native pairing and the
1003-to-1004 update checks. It does not rebuild or sign the APK. Generated checksums are marked as
recovery evidence; absent original tool-version records are not fabricated. The option is off by
default and does not admit other failed build artifacts.

This is the same scoped startup smoke used by the candidate workflow. Select `verify_upgrade` to
run the pinned old-to-new native pairing check above. It does not establish real-host pairing,
provider execution or physical-phone/Clash Mi acceptance. A failed
smoke keeps an explicitly unaccepted report. Successful startup evidence does not itself publish a
release or replace the required physical-device checks.

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
