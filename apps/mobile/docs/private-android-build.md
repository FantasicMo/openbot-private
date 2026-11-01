# Private Android build candidate

This path builds a signed, standalone APK without EAS, Expo account, Google Play, or FCM project
credentials. It does not publish an app. Private runtime source now selects device pairing, local
host storage, and native HTTPS/WSS for the existing workspace and chat UI. No APK or Android runtime
has been accepted yet. Source and fixture checks do not prove that a candidate works on a device.

## Build selection

Set `OPENBOT_PRIVATE_BUILD=1` when Expo reads the configuration and when Gradle bundles the app.
Without this value, `app.config.js` keeps the upstream configuration, including its optional Firebase
file. The private branch selects:

| Setting | Private value |
| --- | --- |
| Display name | `OpenBot Private` |
| Android application ID | `io.github.fantasicmo.openbot` |
| URL scheme | `openbot-private` |
| Expo slug | `openbot-private` |
| Platforms | Android only |
| Runtime build marker | `extra.privateBuild: true` |
| EAS project and owner | Removed |
| OTA updates | Disabled; no upstream update URL or runtime policy |
| Firebase project file | Not included |

The application ID gives this app a separate Android data directory. It cannot update or replace the
official app. Use the same private signing key for each subsequent APK. Choose an increasing
`OPENBOT_ANDROID_VERSION_CODE` for an installed app upgrade. The allowed range is 1 to 2100000000;
local configuration defaults to 1. The app version still comes from the upstream mobile version.

`EXPO_PUBLIC_APP_ENV=preview` is an existing environment value. The candidate workflow uses it so the
current analytics transports do not select their production path. The explicit private runtime marker
also prevents the official session provider and its refresh/analytics effects from mounting. It
disables analytics transports, official feature/version reads, app OTA UI, hosted wake, and Android
notification registration. Removing the Firebase project file does not remove the Firebase SDK or
the custom FCM service from native dependencies. The APK must still prove startup without Firebase
configuration. Native dependency removal is outside this runtime slice.

## Private runtime scope

Paste the host's pairing JSON or scan its QR code. The offer carries protocol 1, the HTTPS origin,
host ID/name, public key and fingerprint, and an expiring one-use secret. The app checks the TLS
connection and signed identity challenge before it sends new per-device credentials. The host returns
the real TeamStore member and session. Credentials, pins, host metadata and pending pairing recovery
are kept in one serialized SecureStore document. Android data is isolated by the private application ID.

The private workspace receives local directory and identity ports. It has no CentralAuthUser or
official account session. Chat reads, writes, files and foreground events use the released Team API
codecs. WSS uses `/v1/events`, the original auth subprotocol, capability scope and runtime snapshot
request. The transport does not retry mutations. Existing outbox receipts and `clientMessageId` stay
in use. Upload progress reports start and confirmed completion; it does not claim byte progress.
Ordinary attachment selection already uses the upstream mobile 10 MiB limit and its 10 MB error.
Private uploads and downloads use that same limit for chat attachments. The optional `agent-import-v1`
stage and `instance-transfer-v1` stage/export routes use their released 100 MiB ZIP limits instead.
The larger limit applies only to those POST routes, and uses the import/transfer error text.
Oversized uploads fail before network I/O and oversized download streams are cancelled.
Cancel selects the message's transfer ID, so it leaves another chat's upload to the same host running.
Downloads preserve the released host's RFC 5987 UTF-8 filename, including Chinese text and extensions;
malformed encoding uses a fallback name.

Background closes the event socket and cancels reads. Reopen reconnects and reads the host's current
state; no push service or persistent Android VPN service is required. An explicit retry can recover
a committed pairing from its exact saved pending credentials after the one-use offer expires; it
logs in and does not redeem the expired offer again. Fresh expired offers remain invalid. An expired device session
currently requires pairing again. Forget host removes local credentials; revoke the device on the
host to end its authority. Browser view, official invitations/account memberships, marketplace links
and share extension entry are outside this first private flow. Unsupported operations fail explicitly.
There is no custom CA, cleartext production exception or public tunnel.

`bun scripts/private-mobile-transport-e2e.ts` exercises the real mobile store/transport, private
service/gateway and TeamStore with isolated native network/storage and Team API route fixtures. It
covers pairing restore, protocol/auth/events, message IDs, lost write responses, binary files, cancel,
reopen, redirects, identity mismatch, storage failure and revocation. It does not exercise Expo native
modules, the real TeamApiServer, provider execution, TLS, emulator or phone. Its report is under
`.openbot-build/private-mobile-transport-e2e/report.json`. Windows sandbox loopback restrictions can
require this one fixture check to run outside the sandbox.

## Signing configuration

Android requires signed APKs. This path uses our own stable key, not the upstream or Expo signing
service. The generated Expo template normally signs its release build with a debug key. The private
config plugin replaces that selection with `openbotPrivateRelease` and stops a release task graph
when a required value or the keystore file is missing. It does not make a temporary key or fall back
to the debug signer. Debug tasks can still run without the release key.

Gradle reads these values from its environment:

| Environment variable | Value |
| --- | --- |
| `OPENBOT_ANDROID_KEYSTORE_PATH` | Absolute path to our private keystore |
| `OPENBOT_ANDROID_STORE_PASSWORD` | Keystore password |
| `OPENBOT_ANDROID_KEY_ALIAS` | Signing key alias |
| `OPENBOT_ANDROID_KEY_PASSWORD` | Key password |

Do not put these values in `app.json`, Expo `extra`, Gradle source or properties, logs, source
control, or this document. Keep the key and its controlled backup outside the vault. Do not change
the signer to work around a failed upgrade. An uninstall removes app data and is not an upgrade test.

For the manual GitHub workflow, configure these repository secrets:

- `PRIVATE_ANDROID_KEYSTORE_BASE64`
- `PRIVATE_ANDROID_STORE_PASSWORD`
- `PRIVATE_ANDROID_KEY_ALIAS`
- `PRIVATE_ANDROID_KEY_PASSWORD`

Set the repository variable `PRIVATE_ANDROID_CERT_SHA256` to the public SHA-256 fingerprint of that
signing certificate. Colons and either letter case are accepted. The workflow compares the built
APK certificate against it. No new GitHub environment or reviewer gate is required by the workflow.
Do not use official signing credentials, a model-provider credential, or a production tailnet key.

The workflow decodes the keystore into the runner temporary directory only for the Gradle step and
removes it when that step exits. Credentials remain process environment values; they are not written
into generated Gradle source. Do not enable Gradle configuration caching or upload runner caches,
heap dumps, local app data, or the signing file as evidence.

## Manual candidate workflow

Run **Build private Android candidate** from GitHub Actions on the reviewed private branch. Supply
the intended positive `version_code`. Reusable source verification runs first on the same commit.
If signing secrets or the certificate fingerprint are absent, the candidate build job stops before
its own dependency installation. It has only `contents: read`
permission and has no release, store submission, EAS, or tailnet step.

It pins Node 24.22.2 and Bun 1.4.2, uses Java 17, installs the frozen lockfile with repository patches,
then runs Android CNG prebuild and vanilla Gradle. It skips the unrelated Electron binary download.
The SDK/NDK versions come from the locked native packages and generated project; the workflow
records actual installed versions rather than claiming that a runner image is fixed. It accepts
Android SDK licenses on the disposable runner so Gradle can install the required SDK components.
Before dependency installation, it requires at least 25 GiB free on the workspace and temporary
filesystems. First it uses the upstream Android release workflow's explicit cleanup list on a
disposable GitHub-hosted Linux runner only: `/usr/share/dotnet`, `/opt/ghc`, `/usr/local/.ghcup`,
`/usr/local/share/boost`, and `/opt/hostedtoolcache/CodeQL`. Android SDK, Java, Node and Bun remain.
Before/after disk reports are saved. The 25 GiB budget is an initial capacity gate, not a measured
maximum. If bounded cleanup is insufficient, the job stops before dependency installation or build.
Review actual disk use after the first native build and adjust the capacity budget if necessary.

The native build has two workers and builds `arm64-v8a,x86_64` into one APK. It keeps R8/resource
shrinking and the repository's native dependency patches. The release task embeds the JavaScript
bundle and assets. It does not need Metro after installation. Generated `android/` stays ignored;
change native settings through config plugins, not hand edits.

Source inspection after the frozen install at upstream commit
`59b2052f22534b86d32ebc23f7660ab40669473c` found these native defaults. The workflow records the
actual build tools again, since a later upstream update can change them:

| Component | Locked source value |
| --- | --- |
| Expo / React Native / React | 58.0.17 / 0.88.0 / 19.3.0 |
| Gradle wrapper in `expo/template.tgz` | 9.4.1 |
| Android Gradle Plugin | 9.2.1 |
| Android min / compile / target SDK | 24 / 37 / 36 |
| Android Build Tools | 37.0.0 |
| Android NDK | 27.1.12297006 |

The Android SDK values are in the installed `react-native/gradle/libs.versions.toml`; the Expo
root-project plugin supplies the same fallback values. Kotlin resolution also depends on the loaded
Gradle plugin, so use the native build's reported value. No native build has run for this change.

The intermediate artifact `private-android-build-<run>-<attempt>` contains:

- `openbot-private.apk` and `SHA256SUMS`.
- Certificate verification, application/version details, and native ABI list.
- The APK file list and source/tool version record, including the `bun.lock` SHA-256 and run attempt.
- `ACCEPTANCE.txt`, which states that packaging passed and emulator startup is still pending.

The build job checks package ID, versionCode, certificate fingerprint, both requested ABIs, and the
embedded bundle. A successful build is packaging evidence only. The independent emulator job downloads
this artifact and never installs repository dependencies, runs CNG/Gradle, or rebuilds the APK.

## Candidate emulator smoke

The second job creates a fresh API 36 Google APIs `x86_64` emulator on its own Ubuntu 24.04 runner.
It reuses the repository's pinned checkout, download/upload artifact and Java actions, and the runner's
Android SDK command-line tools. It records actual SDK, emulator, Python and Java versions. The AVD
and its state stay in the job's temporary directory. Only this job's emulator process is stopped.

`scripts/private-android-emulator-smoke.py` first rechecks the downloaded APK hash, release certificate
and embedded JavaScript. It installs the signed release APK without Metro, confirms it is not
debuggable, and starts its resolved private launcher. UI Automator must find the private first-run
title and pairing input. The script enters a harmless invalid offer and checks the local error. It
saves screenshots, UI trees, launcher output, app/crash logcat, device details and a JSON report.

Before first launch, the fresh root-capable image installs app-UID IPv4 and IPv6 OUTPUT reject/count
rules. The app must reach the private screen with IP egress blocked and show zero counted packets
during at least 30 seconds. Missing root/counter support fails the smoke. This evidence covers only
app-UID IP packet attempts in that window. It cannot prove the absence of every JavaScript/native
API call, DNS delegated to netd, requests by Google Play services or isolated UIDs, or later behavior.
It therefore supports a scoped startup claim, not a blanket assertion that every official endpoint
attempt has been captured. No host, provider, production tailnet, Google account or pairing credential
enters this job. Full host pairing and task execution are a separate acceptance stage.

The final artifact `private-android-<run>-<attempt>` includes the unchanged APK and build evidence,
the emulator evidence directory, and updated `ACCEPTANCE.json`/`ACCEPTANCE.txt`. Hashes before and
after smoke must agree. Its state is `startup_smoke_passed` only when the emulator step and hash
check pass; otherwise it records `startup_smoke_not_accepted`. An emulator or setup failure keeps
failure evidence available and keeps the job failed. A passing first-run smoke still does not prove
private-host pairing, provider execution, phone compatibility or Clash Mi coexistence. Promote
only the exact accepted artifact and hash in a separate release step; do not rebuild it after acceptance.

## Authorized local reproduction

Use a fresh generated Android project when you switch between upstream and private build modes.
Removing `OPENBOT_PRIVATE_BUILD` alone does not undo the signing block appended to an existing
`android/app/build.gradle`. After checking that the generated directory has no hand changes to
preserve, run the prebuild with `--clean --platform android --no-install` under the selected mode.
This replaces the generated Android directory. Do not remove or regenerate a directory that holds
unreviewed hand changes. CI starts from a fresh checkout and does not reuse a generated Android tree.

Do not run a local build as a routine source check. When a local build is explicitly requested,
install the locked dependencies once at the repository root with the pinned Node and Bun. Set the
build variables and signing environment through the local controlled credential path. In
`apps/mobile`, run:

```sh
bunx expo prebuild --platform android --no-install
```

Then, in the generated `apps/mobile/android` directory, run:

```sh
./gradlew app:assembleRelease --no-daemon --no-configuration-cache --max-workers=2 \
  -PreactNativeArchitectures=arm64-v8a,x86_64
```

On Windows PowerShell, use `./gradlew.bat` and PowerShell line continuation or one line. The APK is
`app/build/outputs/apk/release/app-release.apk`. The existing `bun run android` command also launches
or installs an app; it is not the candidate packaging command. The existing EAS/Play commands remain
the upstream path and must not be used for this candidate.

## Android acceptance

The existing-artifact workflow has an optional `native_pairing_fixture` input. It uses the same
signed APK after the startup packet-count window. A runner-local Python HTTPS fixture signs a
fresh identity challenge with an ephemeral Ed25519 key. Its CA is trusted only in the disposable
API 36 emulator's Conscrypt system store, including the zygote mount namespaces. The APK's trust
configuration and bytes stay unchanged. All other app-UID IP egress stays blocked; only the
fixture's `10.0.2.2` TCP port is allowed.

This check must reject an invalid signature before redemption, accept the valid identity and
one-use fixture offer, and restore the saved native session after a process stop and reopen.
It records stage/counters in `emulator/native-pairing.json`. It keeps keys, offers and credentials
out of artifacts and does not capture a populated pairing form. This limited HTTP fixture does
not implement a real host, provider or accepted WSS session. Passing it does not establish
Tailscale DNS readiness, Clash Mi app routing, ARM64 phone TLS, tasks or files.

Pairing failures in the app show a fixed diagnostic stage and, when available, an HTTP status.
The first-host screen has a Support entry to view or save the local support log before a host
is paired. The private pairing diagnostic path records no raw cause, URL, offer, credentials or
response body. It does not add retries or change identity, TLS, expiry or redemption rules.

Test the exact candidate APK on an x86_64 Android emulator first. Keep the host, provider and files
isolated. Use a deterministic fake provider. Record the APK hash and these results:

1. Fresh installation and cold start without Metro or an official OpenBot account.
2. Pair one test host; reject an invalid host identity and revoked device credential.
3. Negotiate the protocol, load agents, send a task with a stable client message ID, and read events
   and the final result. Verify one file by its content hash.
4. Cancel an upload, queued message, and running task through their separate actions.
5. Lose the response after host acceptance, reconnect, and prove no duplicate task was created.
6. Background and force-stop the app. Complete the task on the host, reopen, and read its saved result.
7. Block official account, Signal, TURN, OTA and analytics destinations, then repeat the core flow.
8. Install the next candidate over this one with the same signer and a larger versionCode. Preserve
   paired-host state and task history. Do not uninstall to make the check pass.

After emulator acceptance, deliver that APK and its hash for manual installation on the actual
Android phone. USB debugging is not required. Phone acceptance must include camera/file selection,
Wi-Fi/cellular transitions, lock/reopen behavior and concurrent Clash Mi proxy/private access.
The x86_64 emulator does not prove the exact ARM Clash Mi build or a vendor's background behavior.
No mandatory background service or push notification is required to view saved results after reopen.

## References

- [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/)
- [Expo local production builds](https://docs.expo.dev/guides/local-app-production/)
- [Expo Updates configuration](https://docs.expo.dev/versions/v58.0.0/sdk/updates/)
- [Android command-line builds](https://developer.android.com/build/building-cmdline)
- [Android signing](https://developer.android.com/studio/publish/app-signing)
- [Android emulator command line](https://developer.android.com/studio/run/emulator-commandline)
- [Android SDK manager](https://developer.android.com/tools/sdkmanager)
- [Android virtual device manager](https://developer.android.com/tools/avdmanager)
- [GitHub Ubuntu 24.04 runner image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
