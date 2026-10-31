### Added

- Add a separable private-access foundation with portable pairing contracts, a fixed loopback
HTTP/WS gateway for a trusted Tailscale Serve HTTPS origin, and short-lived single-use pairing over
injected host authority operations. The gateway preserves host authentication and released wire
payloads; it does not expose owner credentials or create a second role/session database.

- Add a service E2E check with redacted output for transport boundaries, pairing expiry/reuse and
device/session revocation. Desktop, Serve and Android integration remain separate work.
