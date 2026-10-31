### Fixed

- Preserve an explicit private Windows profile when the user enables launch at login. Read the
current profile's exact command and Windows startup approval. Keep the existing private login item
name, and do not enable startup automatically.

### Added

- Extend the disposable Windows installer smoke with a profile path that contains spaces, real
login-item readback, relaunch from its stored argument, and removal of the CI-owned login item.
