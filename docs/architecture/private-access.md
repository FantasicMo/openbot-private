# Private access foundation

This package is the first private transport slice for the Windows and Android fork. The main-process
adapter now connects local identity, optional ingress and trusted IPC; packaged Electron and Android
acceptance remain separate. It uses the source at upstream v0.56.0 as its
integration baseline. No official Account, Signal, TURN, email or new user account is needed by the
package itself.

## Boundaries

```text
Android client
  -> Tailscale Serve HTTPS/WSS origin
  -> private gateway, 127.0.0.1:<fixed port>
  -> existing Team API, 127.0.0.1:<host port>
  -> TeamStore authentication and existing host operations
```

Serve owns TLS and tailnet ingress. The module never configures Serve or Funnel, opens a public or
LAN listener, makes a certificate authority, or reads Tailscale identity headers as authorization.
The first integration uses Serve on both local and remote networks. A standalone offline LAN-IP
endpoint is outside this slice.

`@openbot/private-access` and `@openbot/private-access/contracts` are portable entry points. They
export the pairing schema, DTOs and authority port, with no Node or Electron imports. Only
`@openbot/private-access/node` exports the Node gateway and pairing service. A mobile or renderer
bundle must not import that entry point.

The package imports the catalog-pinned Effect 4.0.6. Asynchronous service methods return Effects;
native HTTP callbacks run them through the gateway-owned managed runtime. Shutdown closes owned
sockets and in-flight proxy requests, drains pairing operations, closes unused offers and disposes
that runtime. There are no retries of mutating requests.

## Gateway

`PrivateAccessGateway` takes one immutable `upstreamOrigin`, one trusted HTTPS `publicOrigin`, a
loopback port and a `PrivatePairingService`. `start()` returns the bound port and public origin.
`stop()` closes it permanently. Port zero is available for isolated service checks; application
integration must select a stable port for Serve.

The upstream must be exactly an HTTP origin on literal `127.0.0.1`, with an explicit port and no
credentials, path, query or fragment. Request URLs cannot select another target. The listener binds
only `127.0.0.1`; it accepts the configured public Host or its own loopback Host. It rejects absolute
request targets, encoded path traversal, backslashes, fragments and unrelated Host headers.

The public surface is:

- `POST /private-access/v1/pair`: redeem an offer with JSON containing `offerId`, `secret`,
  `username` and `password`. The password is a random device credential supplied by the client.
- `/v1/*`: forward HTTP requests and WebSocket upgrades to the fixed Team API. Authorization,
  negotiated protocol/capability headers, cookies and selected WS subprotocols remain the host's.

The proxy adds no bearer token and never uses an owner credential. It removes hop-by-hop headers,
caller-supplied `Forwarded`, `X-Forwarded-*` and `Tailscale-*` headers. It sets forwarded host and
protocol only from the configured public HTTPS origin. The existing Team API can then construct
public URLs without trusting a caller's forwarded host. The proxy does not follow redirects.

HTTP request/response bodies are streamed with native backpressure and a 100 MiB byte limit. The
pairing body limit is 4 KiB. Header size is at most 16 KiB, header count at most 64, and concurrent
connections at most 32. Header timeout is 10 seconds, HTTP request timeout 10 minutes, and inactive
connections close after 60 seconds. WS bytes remain opaque; the fixed host must retain its frame,
message, authentication and event limits. The gateway does not decode or change released Team API
wire payloads.

Viewer/media paths outside `/v1/*`, remote desktop capture/input, browser-view behavior, push and
background recovery are not accepted by this foundation check. Generic WS forwarding is not proof
that these features work. Electron sandboxing, context isolation, trusted IPC and frozen Team API
adapters remain unchanged.

## Pairing and authority

`PrivatePairingAuthority<E>` is a structural port over existing host operations:

| Port operation | Host adapter |
| --- | --- |
| `createInvite(role)` | `TeamStore.createInvite`, with no email and no permanent invitation |
| `acceptInvite(token, username, password)` | `TeamStore.acceptInvite` |
| `revokeInvite(id)` | `TeamStore.revokeInvite` |
| `authenticateSession(token)` | `TeamStore.authenticateSession` |
| `revokeSession(id)` | Host session revocation and browser/remote-screen cleanup |
| `removeMember(id)` | Host member revocation and browser/remote-screen cleanup |

The host chooses an explicit `admin` or `member` role when it calls `createOffer`. The network
redemption body contains no role. An IP address never grants owner access. An owner password or
owner session is absent from the port and all responses.

Each offer has a random ID and 256-bit secret. The service returns only that temporary handle; it
keeps the underlying TeamStore invitation token private. It stores a hash of the handle secret,
not the secret itself. It holds at most eight offers. Default lifetime is two minutes and maximum
lifetime ten minutes, capped by the underlying invite's expiry.

A semaphore serializes create, redeem, expiry cleanup and close. Redemption removes its handle
before awaiting the authority. Success, rejection and cleanup failure cannot restore that handle.
The service attempts to revoke the underlying invitation after every accepted redemption attempt.
Once the authority commits a member/session, the response returns that credential even if invite
cleanup fails. Failed invitation IDs stay in a bounded cleanup backlog and are retried on the next
operation or close; a cleanup failure never restores an offer or hides a committed credential.
It checks expiry before redemption and revokes expired invitations at the next operation or close.
No background timer or persistent pairing database is created. Restart loses all handles; raw
underlying tokens were never exposed and can no longer be used through this module. An orphaned
upstream invite record retains the TeamStore expiry; integration must not expose those private
invitation tokens through another route.

Successful redemption returns the existing member/session result. TeamStore remains the only owner
of member roles, disabled state, password hashes, session hashes and session expiry. The module does
not keep a second ACL, device role table or session cache. The client must keep only its device
credential/session in platform secure storage. Pairing material belongs in a QR fragment or an
equivalent local display and JSON body, never in a network query string or log.

The gateway provides no network endpoint to create an offer, choose a role, remove a device or
revoke a session. These remain local host operations behind its trusted UI/IPC. A revocation
adapter must close existing event, browser and remote-screen access, as well as reject later HTTP
requests. The module does not assume that deleting a bearer token from storage closes a socket.

Network failures return a stable machine code only. Authority causes, request bodies, URLs with
queries, headers, offers and credentials are not logged or serialized by this module. UI integration
must map those codes to catalog text before showing an error.

## Main-process integration order

1. Choose an isolated private profile. Initialize TeamStore, then configure its local password owner
   with a generated secret from the existing OS-backed secret store. Do this before constructing
   HostService, so its initial identity/status is correct. Do not adopt an account-owned profile or
   create a fake `CentralAuthUser`.
2. Construct HostService with explicit local directory/identity authority. Its member/invite
   callbacks, ticket redemption, account push and `endRemoteSession` must not call central auth.
   Local member/session changes must retain existing browser and remote-screen cleanup.
3. Exclude this host from account sign-out unbinding and official launch publishing. Resolve local
   reader/sender identity to its local owner for the Windows workspace. Preserve the account path's
   checks and behavior.
4. Start the real loopback Team API. Inject that exact port into the gateway. Keep the public Serve
   origin separate from HostService's internal API URL.
5. Start the gateway, then point an authorized Serve configuration at its loopback port. Register
   gateway teardown immediately before host teardown ordinal 90.
6. Add trusted local pairing/revoke IPC with declared endpoints, argument decoding, preload and
   preview mirrors. Android imports only the portable contract and implements normal HTTPS/WSS
   using the existing HTTP codecs and event capability declaration.

The existing local-server child bootstrap is a reusable model, not completed integration: its
directory callbacks can still point to central auth, and its lifetime follows its parent desktop.

## Verification scope

`src/main/private-access-owner.ts` creates the local password owner before HostService construction.
Its generated secret is sealed through the existing Electron secret-storage cipher in the private
profile. An unreadable secret fails without replacing host identity. The build selects isolated
`OpenBot Private` userData, session data, application ID and agent root before normal startup. An
explicit `--user-data-dir` remains an operator-selected profile override.

`src/main/private-access-host.ts` keeps only the configured public origin, stable port and display
labels in `openbot-private-access-v1.json`. The default port is the single contract constant
`DEFAULT_PRIVATE_GATEWAY_PORT` (43187). Without an origin, the real local host starts and ingress
stays disabled. Pairing requires a configured, running gateway. Status includes real member/session
IDs and labels, with no credentials. HostService uses explicit local identity/directory authority;
the official account branch retains its checks. Private builds do not initialize account/profile
refresh, official host publishing, telemetry tracking or the official updater.

The disabled account boundary starts in `signed_out` and refuses account operations before file or
network I/O, including an IPC retry. Private builds also skip official `openbot://` registration and
official release discovery. Removing a local device closes its browser, screen and session resources
before the TeamStore forgets its session IDs; owner removal keeps the existing store rejection.

The desktop renderer selects the private build before account bootstrap. It uses the existing
language, provider setup and workspace views with a nullable account. Local presence identifies the
real TeamStore owner only on this computer's private workspace. Provider sign-in, provider traffic,
usage, chat, agents, notifications and computer controls keep their existing paths. Official account,
hosted-plan, profile, billing and mobile-account stores do not mount in private mode. Product
analytics and error-report clients do not initialize.

Settings > Private access saves the explicit HTTPS origin, creates an admin-device offer, shows its
JSON as a QR code, copies the same JSON and revokes paired devices. An offer stays only in component
memory and disappears at expiry or when the panel closes. The address setting does not start Serve.
`private-access-port.ts` is the only renderer adapter that reads the private preload group.

The `privateAccess` IPC group has status, configure, createPairing, revokeDevice, revokeSession and
changed operations. Mutations accept only the trusted main application window, with argument
decoding after sender validation. The preload independently decodes all results. The portable
`PrivateHostPairingOfferSchema` is the enriched QR contract shared with Android. Its fields are
`protocol`, `offerId`, `secret`, `expiresAt`, `publicOrigin`, `hostId`, `hostName`, `fingerprint` and
`publicKey`. The existing `GET /v1/identity?challenge=...` path signs the challenge with the host key;
clients can verify that proof against the paired public key before using the host.

Run `bun scripts/private-access-host-e2e.ts` for real TeamStore owner and session persistence, labels,
restart, revoke A while B stays active, session revocation and failure of owner-secret decryption.
It also verifies that the disabled real account service stays signed out and rejects retry, sign-in
and sign-out without a request.
Its report states that the HTTP/WS host and ephemeral cipher are fixtures. It does not prove real
HostService/TeamApiServer routing, OS safeStorage, Electron startup or any remote-device behavior.

Run `bun scripts/private-access-gateway-e2e.ts`. The check starts this real gateway and pairing
service, a fixture authority, and a loopback HTTP/WS host. It checks fixed target enforcement,
forwarded-header sanitization, bearer/protocol headers, binary HTTP, response cookies, text/binary
WS and selected subprotocols, concurrent single-use redemption, expiry, cleanup failure and revoke
A while B stays active. It also checks committed pairing through an invite-cleanup failure, client
disconnect before upstream headers, and revoking one of two sessions of the same member. Fixture
revocation closes only the existing upstream sockets owned by the revoked session or member.

The redacted report is `.openbot-build/private-access-gateway-e2e/report.json`. It records named
pass/fail steps and exclusions, with no request/response body, token, offer, password or identity
header. It is module-boundary evidence only. It does not establish real TeamStore persistence,
TeamApiServer integration, Electron security, Serve TLS, a tailnet ACL, Android operation, provider
execution or remote desktop. Those require separate integration artifacts.

The manual Windows candidate adds an installed-app check through the real HostService, TeamApiServer,
TeamStore and gateway. Its CI-only installer script verifies HTTP, event snapshots, revoke A while B
stays, and reinstall persistence. It keeps the module reports separate and does not establish TLS,
Android, provider or streaming acceptance. See [private candidate checks](../private-candidates.md).
The workflow source is not a passing run; its own artifact must record an executed result.

## P5: required module extraction

Keep the module in this monorepo while desktop, Android and their shared contracts change together.
After the interfaces are stable and two upstream update regressions pass, move `packages/private-access`
to an independently versioned repository with its own tests and releases. This is a required milestone,
not an optional cleanup, and it does not wait for Mac hardware or an upstream extension proposal.
The fork retains thin platform adapters, UI, signing, release workflows and whole-app acceptance.
The extracted module is still compiled into our applications; the official app cannot load it as a plugin.
