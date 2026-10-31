# Android: keep Clash Mi and add private OpenBot access

Verified against tagged source on 2026-10-31. Reported phone versions: Clash Mi **1.0.31.1703**,
Mihomo **1.19.32**. No phone configuration or login was performed for this guide.

Clash Mi remains the phone's VPN. A Mihomo `tailscale` outbound adds a userspace tailnet node inside
that same client. Only the selected private host goes to this outbound. Other traffic keeps the
existing proxy groups and rules. Do not start the separate Android Tailscale VPN alongside it:
Android permits one active VPN service per user/profile. [Android VPN service](https://developer.android.com/develop/connectivity/vpn#service)

## Evidence and the phone gate

| Item | Confirmed scope |
| --- | --- |
| Feature in Mihomo v1.19.32 | Present in tagged source, including Android interface handling. |
| The installed APK includes the outbound | Unverified. Source requires `with_gvisor` and excludes `no_tailscale`; a version string does not expose those build choices. |
| Interactive login without a configured auth key | Supported by the pinned tsnet implementation and Mihomo logging path; the actual phone log/UI still needs a check. |
| Persistent device state and private DNS | Present in source; this client's directory retention, DNS interception and merged profile still need a phone check. |
| HTTPS/WSS pairing and normal proxy use together | Acceptance pending on the actual phone. An emulator or source review does not establish it. |

The relevant code is in tagged [tailscale.go](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/adapter/outbound/tailscale.go#L1),
the disabled-feature [stub](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/adapter/outbound/tailscale_stub.go#L1),
and the [build command](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/Makefile#L13).
There is no version-upgrade prerequisite. If this binary rejects the outbound, stop this trial and
keep the working VPN profile; record the error before considering a separate build change.

## Host information needed before the phone test

The Windows desktop is already signed in to its official Tailscale client. Serve has been enabled
with Funnel off, but the first local HTTPS check had an SSL error. Existing proxy fake-IP/routing
is being checked; the cause and a healthy HTTPS result are not yet established. Obtain the following
from the host when that gate passes:

- Its complete Serve name, for example `openbot-host.YOUR-TAILNET.ts.net`, and HTTPS origin on port 443.
- Its Tailscale IPv4 address, and IPv6 address only if it is used. The examples below are placeholders.
- Confirmation that Serve forwards to the private OpenBot loopback gateway and that tailnet access
  policy permits this phone node to reach the host on TCP 443.
- A fresh OpenBot private pairing offer, created after the private network works.

Use the complete certificate hostname for both `https://` and `wss://`; do not replace it with a
bare hostname or Tailscale IP in the app URL. DNS maps the name to an address; it does not change
TLS identity. Serve is the private tailnet service, not public Funnel. Public CA certificate issuance
can publish the host name in Certificate Transparency, so use a non-sensitive machine name.
[Serve](https://tailscale.com/docs/features/tailscale-serve),
[MagicDNS names](https://tailscale.com/docs/features/magicdns#fully-qualified-domain-names-vs-machine-names),
[HTTPS and certificate names](https://tailscale.com/docs/how-to/set-up-https-certificates)

## Minimal merge fragment

This is a **merge fragment**, not a replacement subscription. Save a local copy of the current
working profile first. Add the outbound to its existing `proxies` list, merge the DNS map, and
prepend the host rules to the existing `rules` list. Keep the other proxies, ordinary DNS servers,
DNS bootstrap, proxy groups, final `MATCH`, and TUN settings. Do not concatenate duplicate top-level
YAML keys. If this Clash Mi build has no local merge/override facility, edit a local profile copy;
the exact menu names have not been verified on this version.

These are Mihomo `proxies` fields. Do not use sing-box endpoint configuration in this client.

Replace the example hostname and IPv4 address before activation. The current profile must already
use Mihomo DNS for this policy to take effect. Do not replace working DNS defaults with this partial
DNS block. Make sure OpenBot Private (`io.github.fantasicmo.openbot`) and the test browser are included
if the existing VPN uses per-app selection.

```yaml
proxies:
  - name: OPENBOT-TAILNET
    type: tailscale
    hostname: openbot-phone
    state-dir: ./tailscale/openbot-private
    ephemeral: false
    accept-routes: false
    dialer-proxy: DIRECT

dns:
  nameserver-policy:
    "openbot-host.YOUR-TAILNET.ts.net": "ts://OPENBOT-TAILNET"

rules:
  - DOMAIN,openbot-host.YOUR-TAILNET.ts.net,OPENBOT-TAILNET
  # Replace this example with this host's actual Tailscale IPv4 address.
  - IP-CIDR,100.64.0.10/32,OPENBOT-TAILNET,no-resolve
  # Keep the current rules below these entries, including the current final MATCH.
```

If the host is reached by IPv6, add one exact `/128` rule for its actual Tailscale IPv6 address.
Do not send `0.0.0.0/0`, all `ts.net` names, all public traffic, or the existing final `MATCH` to
`OPENBOT-TAILNET`. No exit node is selected and subnet routes are not accepted. Application UDP is
not needed for HTTPS/WSS; this fragment does not turn off Tailscale's own transport mechanisms.
[Mihomo outbound settings](https://wiki.metacubex.one/config/proxies/tailscale/),
[rule syntax](https://wiki.metacubex.one/config/rules/)

`dialer-proxy: DIRECT` chooses the initial underlay for Tailscale control/peer/relay connections.
It does not change ordinary web rules. If that underlay cannot reach Tailscale, a later local edit
can select an existing working proxy by its exact name. That proxy must not be this Tailscale node,
or a group that can select it: that would create a dependency loop. UDP support of the selected
underlay can affect connectivity and must be checked separately.
[Tagged dialer selection](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/adapter/outbound/base.go#L196)

## DNS and HTTPS/WSS path

The policy sends only the configured host's DNS queries to `ts://OPENBOT-TAILNET`, which uses the
embedded node's Tailscale DNS. Keep existing resolvers for ordinary domains and Tailscale's public
login/control services. Both `ts://` parsing and the named outbound DNS client exist in v1.19.32.
[Tagged parser](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/config/config.go#L1182),
[named DNS client](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/dns/tailscale.go#L44),
[DNS policy](https://wiki.metacubex.one/config/dns/#nameserver-policy)

Keep the current fake-IP mode. The exact domain rule and exact IP fallback rule must precede broad
private-network bypass or final proxy rules. A VPN exclusion can bypass the core before those rules
run; if the connection never appears in Clash Mi, check app inclusion and private-IP exclusions.
Browser Secure DNS or Android Private DNS can also avoid the intended query path. Check that path
before changing resolver settings. Do not globally replace the existing fake-IP filter or DNS mode.

The intended application path is:

| Stage | Path |
| --- | --- |
| Private API | `https://openbot-host.YOUR-TAILNET.ts.net/private-access/v1/pair`, then authenticated `/v1/...` |
| Events | `wss://openbot-host.YOUR-TAILNET.ts.net/v1/events` |
| Transport | Clash Mi VPN → named Mihomo Tailscale outbound → host Tailscale Serve TCP 443 → loopback gateway |
| Ordinary internet | Current Clash Mi proxy/rule path |

No OpenBot account login, custom CA, disabled certificate check, HTTP production exception, router
port forward, or public tunnel is part of this setup. TLS remains checked by the browser/app.

## Phone test: feature, login, persistence, application

1. Apply only the local merged copy and keep rule mode. Confirm ordinary proxy browsing still works.
2. Set the local core log level to `info` temporarily if needed. Open the configured private host's
   `https://.../v1/compatibility` URL to trigger the outbound. The first request can time out while
   the embedded node starts; this alone does not establish a fault.
3. In Clash Mi's core logs, look for `[Tailscale](OPENBOT-TAILNET)` and the interactive browser URL.
   Open that URL yourself, use the same tailnet as the desktop, and complete any device approval.
   This is Tailscale enrollment, separate from OpenBot pairing. Do not put an auth key in a
   subscription, profile export, repository, issue, or this guide. Do not share the complete login URL.
4. Retry the private HTTPS compatibility URL. It must return host JSON with a valid certificate.
   A public-site latency probe can fail because this outbound has no exit node; use the private URL
   for acceptance. Seeing a login URL proves more than config syntax, but does not yet prove reachability.
5. Restart Clash Mi, then repeat the private check. Confirm that the same embedded device remains in
   the tailnet and that a new login is not requested. Keep `state-dir` stable across profile updates.
   Its relative path resolves under the core's configured home directory; do not guess an Android
   absolute path. State contains node credentials: do not export or copy it between phones.
6. Install the accepted private APK when supplied. Pair with a fresh offer, then test HTTPS reads,
   WSS updates, a task, file selection and normal proxy browsing together. Repeat on Wi-Fi and mobile
   data, and after lock/reopen. No USB connection is required for manual APK installation.

The source starts the node on first use and routes its user log to Mihomo at `info` level.
The pinned tsnet dependency emits an interactive URL when it needs login.
[Tagged startup/logging](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/adapter/outbound/tailscale.go#L164),
[pinned dependency](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/go.mod#L46),
[tsnet login loop](https://github.com/MetaCubeX/tailscale/blob/ff0ecd818181/tsnet/tsnet.go#L1117)

## Record the result

| Observation | Next check |
| --- | --- |
| `tailscale support is disabled` or rejected proxy type | Record the exact core error. The bundled feature is not established; keep the existing working profile. |
| No login URL and no matching connection | Check merged profile, rule mode, app inclusion, DNS interception and rule order. |
| Login URL, but no authorized device | Finish the browser enrollment and any tailnet device approval yourself. |
| DNS error after enrollment | Check the exact FQDN, MagicDNS, DNS policy and browser/private-DNS bypass. |
| HTTPS certificate error | Check full hostname, phone clock and Serve certificate. Do not bypass verification. |
| HTTPS works but app events fail | Inspect the same-host WSS `/v1/events` path, Serve forwarding and OpenBot device/session state. |
| A new login after every restart | Check retained core home/state directory and client cleanup behavior before re-enrolling repeatedly. |

Record the two installed version strings, feature acceptance, retained node identity, valid HTTPS,
app event/result behavior, and concurrent proxy behavior. Share only redacted errors and results.
These steps are a pending acceptance procedure, not a claim that the installed binary or phone has
already passed.
