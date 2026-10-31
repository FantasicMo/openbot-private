### Added

- Private builds now open the local workspace without an OpenBot account and keep the existing
language, provider setup and chat flows. The local reader uses the real TeamStore owner identity.
Account-only settings and hosted offers do not start in private mode; provider usage remains active.

- Private access settings can save the HTTPS host address, display or copy an expiring pairing offer,
and revoke a paired phone. The phone gets an explicit admin role. The owner credential stays on the
host. Official protocol registration, account retry and release discovery remain disabled.
