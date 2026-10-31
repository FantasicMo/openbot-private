### Added

- Add an opt-in Android private build with a separate application ID and URL scheme, disabled OTA updates, and explicit release signing. A manual workflow builds an APK candidate without EAS or Google Play credentials.
- Add private host pairing and secure device sessions with native HTTPS/WSS access to the existing workspace, chat and file flow. Private mode does not mount the official account session provider or start account, analytics, push, hosted-wake or update requests. Android emulator and phone acceptance are still required.
- Add a separate cloud emulator job that tests the same signed APK for private first-run startup without Metro and records app-UID IP packet counters, screenshots and scoped acceptance status. Real-host and phone acceptance remain separate.
- Add a manual emulator acceptance workflow for an existing signed build artifact, with separate build/validator provenance and exact APK hash checks. Test-environment repairs no longer require another APK build.

### Fixed

- Refuse a new private host when the saved list reaches 32 hosts, before network requests or credential writes. Existing hosts can still be paired again. Validate saved changes so the app cannot write a host list that it cannot restore.
