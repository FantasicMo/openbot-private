"""Disposable HTTPS fixture for the unchanged release APK. No real host or provider."""

import base64
from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, quote, urlparse
import uuid
import xml.etree.ElementTree as ET


def base64url(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def native_pairing_fixture(device, shell, package, activity, uid, chain, tables, output, sensitive):
    """Trust an ephemeral test CA in the emulator system, never in the APK or phone."""
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted" or sys.platform != "linux" or shell("getprop", "ro.kernel.qemu") != "1":
        raise RuntimeError("Native fixture trust changes require a disposable GitHub-hosted emulator.")
    stage = "create-fixture"
    evidence = {"passed": False, "scope": "isolated_HTTPS_fixture_native_crypto_fetch_and_SecureStore", "steps": []}
    server = None
    thread = None
    state = None
    state_lock = threading.Lock()
    try:
        with tempfile.TemporaryDirectory(prefix="openbot-native-pairing-") as scratch:
            root = Path(scratch)

            def openssl(*args):
                return subprocess.run(["openssl", *map(str, args)], capture_output=True, check=True, timeout=20).stdout

            ca_key, ca_cert = root / "ca-key.pem", root / "ca.pem"
            server_key, csr, server_cert = root / "server-key.pem", root / "server.csr", root / "server.pem"
            openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=OpenBot disposable emulator CA", "-keyout", ca_key, "-out", ca_cert)
            openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=OpenBot disposable fixture", "-keyout", server_key, "-out", csr)
            extension = root / "server.ext"
            extension.write_text("subjectAltName=IP:10.0.2.2\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n")
            openssl("x509", "-req", "-in", csr, "-CA", ca_cert, "-CAkey", ca_key, "-CAcreateserial", "-days", "1", "-extfile", extension, "-out", server_cert)
            host_key, host_public = root / "host-key.pem", root / "host-public.pem"
            openssl("genpkey", "-algorithm", "ED25519", "-out", host_key)
            openssl("pkey", "-in", host_key, "-pubout", "-out", host_public)
            public_key = host_public.read_text()
            host_id = str(uuid.uuid4())
            fingerprint = base64url(hashlib.sha256(public_key.encode()).digest())
            secret, token, offer_id = base64url(secrets.token_bytes(32)), base64url(secrets.token_bytes(32)), str(uuid.uuid4())
            sensitive.extend([secret, token])
            state = {"badSignature": True, "identity": 0, "pair": 0, "authenticated": 0, "reopenedAuthenticated": 0, "reopenedWebsocket": 0, "members": [], "routes": {}}

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def reply(self, status, body):
                    encoded = json.dumps(body).encode()
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(encoded)

                def do_GET(self):
                    parsed = urlparse(self.path)
                    path = parsed.path
                    with state_lock:
                        state["routes"][path] = state["routes"].get(path, 0) + 1
                    if path == "/v1/identity":
                        challenge = parse_qs(parsed.query).get("challenge", [""])[0]
                        if not re.fullmatch(r"[A-Za-z0-9_-]{32}", challenge):
                            return self.reply(400, {"code": "invalid_fixture_challenge"})
                        with state_lock:
                            state["identity"] += 1
                            bad = state["badSignature"]
                        if bad:
                            signature = bytes(64)
                        else:
                            with tempfile.NamedTemporaryFile(dir=root) as message:
                                message.write(challenge.encode())
                                message.flush()
                                signature = openssl("pkeyutl", "-sign", "-rawin", "-inkey", host_key, "-in", message.name)
                        return self.reply(200, {"serverId": host_id, "serverName": "Native fixture", "publicKey": public_key, "fingerprint": fingerprint, "challenge": challenge, "signature": base64url(signature)})
                    if path == "/v1/compatibility":
                        # decodeTeamProtocolSupportV9 -> provider-aware decoder accepts this bounded
                        # appVersion, ordered positive protocol range and empty capability list.
                        return self.reply(200, {"appVersion": "0.56.0", "protocol": {"minimum": 3, "maximum": 9}, "capabilities": []})
                    websocket_protocols = self.headers.get("Sec-WebSocket-Protocol", "").split(",")
                    websocket_protocols = [part.strip() for part in websocket_protocols]
                    # PrivateHttpTransport sends the released v1 base protocol and token protocol.
                    # Counting this upgrade attempt proves the native compatibility decode completed;
                    # this limited fixture deliberately does not claim an accepted WSS session.
                    websocket_token = path == "/v1/events" and self.headers.get("Upgrade", "").lower() == "websocket" and "openbot-team-v1" in websocket_protocols and f"openbot-token.{token}" in websocket_protocols
                    if self.headers.get("Authorization") != f"Bearer {token}" and not websocket_token:
                        return self.reply(401, {"code": "authentication_required"})
                    with state_lock:
                        state["authenticated"] += 1
                        if self.server.generation == 1:
                            state["reopenedAuthenticated"] += 1
                            if websocket_token:
                                state["reopenedWebsocket"] += 1
                    # Deliberately limited: enough to prove native saved-session use. No provider runs.
                    return self.reply(404, {"code": "native_fixture_route_out_of_scope"})

                def do_POST(self):
                    if self.path != "/private-access/v1/pair":
                        return self.reply(404, {"code": "native_fixture_route_out_of_scope"})
                    size = int(self.headers.get("Content-Length", "0"))
                    if size < 1 or size > 16_384:
                        return self.reply(400, {"code": "invalid_fixture_pair"})
                    body = json.loads(self.rfile.read(size))
                    if body.get("offerId") != offer_id or body.get("secret") != secret:
                        return self.reply(401, {"code": "pairing_refused"})
                    username, password = body.get("username"), body.get("password")
                    if not isinstance(username, str) or not isinstance(password, str) or not username.startswith("mobile-") or len(password) != 43:
                        return self.reply(400, {"code": "invalid_fixture_credentials"})
                    if self.headers.get("OpenBot-Protocol-Version") != "9" or not self.headers.get("OpenBot-App-Version"):
                        return self.reply(426, {"code": "client_update_required"})
                    with state_lock:
                        state["pair"] += 1
                        if state["members"]:
                            return self.reply(401, {"code": "pairing_refused"})
                        sensitive.extend([username, password])
                        member = {"id": str(uuid.uuid4()), "username": username, "role": "member", "disabled": False, "email": None, "name": None, "createdAt": datetime.now(timezone.utc).isoformat()}
                        state["members"].append(member)
                    self.reply(201, {"member": member, "sessionToken": token, "sessionExpiresAt": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()})

            class FixtureServer(ThreadingHTTPServer):
                # server_close joins every request handler before a fresh generation can listen.
                daemon_threads = False
                block_on_close = True
                allow_reuse_address = True

                def get_request(self):
                    connection, address = super().get_request()
                    connection.settimeout(10)
                    try:
                        return context.wrap_socket(connection, server_side=True), address
                    except BaseException:
                        connection.close()
                        raise

                def handle_error(self, _request, _address):
                    # The report contains stage/counters only, never request or exception text.
                    pass

            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(server_cert, server_key)

            def start_server(port, generation):
                instance = FixtureServer(("127.0.0.1", port), Handler)
                instance.generation = generation
                worker = threading.Thread(target=instance.serve_forever, daemon=True)
                worker.start()
                return instance, worker

            server, thread = start_server(0, 0)
            port = server.server_address[1]

            stage = "system-test-ca"
            shell("am", "force-stop", package)
            ca_hash = openssl("x509", "-in", ca_cert, "-subject_hash_old", "-noout").decode().strip()
            if not re.fullmatch(r"[a-f0-9]{8}", ca_hash):
                raise RuntimeError("The test CA filename is invalid.")
            directory = "/data/local/tmp/openbot-native-fixture-cacerts"
            apex = "/apex/com.android.conscrypt/cacerts"
            # Android 14+ selects this APEX store. Copy all existing roots before the isolated bind.
            # https://android.googlesource.com/platform/external/conscrypt/+/master/platform/src/main/java/org/conscrypt/TrustedCertificateStore.java
            shell("mkdir", "-p", directory)
            shell("sh", "-c", shlex.quote(f"cp {apex}/* {directory}/"))
            device("push", str(ca_cert), f"{directory}/{ca_hash}.0")
            shell("sh", "-c", shlex.quote(f"chmod 755 {directory}; chmod 644 {directory}/*; chcon -R u:object_r:system_file:s0 {directory}"))
            zygotes = shell("pidof", "zygote64", "zygote").split()
            if not zygotes or any(not pid.isdecimal() for pid in zygotes):
                raise RuntimeError("The disposable zygote processes were not found.")
            for pid in zygotes:
                shell("nsenter", "-t", pid, "-m", "--", "mount", "--bind", directory, apex)
                shell("nsenter", "-t", pid, "-m", "--", "test", "-r", f"{apex}/{ca_hash}.0")
            evidence["trust"] = {"store": apex, "zygoteNamespaces": len(zygotes), "scope": "disposable_emulator_system_only", "apkTrustConfigurationChanged": False}
            evidence["steps"].append({"name": "test_CA_visible_in_disposable_zygote_system_store", "passed": True})
            # Keep all other app-UID egress blocked. No external DNS or public service is needed.
            shell("iptables", "-w", "5", "-I", chain, "1", "-p", "tcp", "-d", "10.0.2.2", "--dport", str(port), "-j", "ACCEPT")
            # Android's documented alias for the runner loopback, not a public endpoint:
            # https://developer.android.com/studio/run/emulator-networking
            offer = {"protocol": 1, "offerId": offer_id, "secret": secret, "expiresAt": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(), "publicOrigin": f"https://10.0.2.2:{port}", "hostId": host_id, "hostName": "Native fixture", "fingerprint": fingerprint, "publicKey": public_key}
            link = "openbot-private://pair?offer=" + quote(json.dumps(offer, separators=(",", ":")), safe="")
            sensitive.extend([link, json.dumps(offer, separators=(",", ":"))])

            def tree():
                shell("uiautomator", "dump", "--compressed", "/sdcard/openbot-private-fixture.xml")
                current = ET.fromstring(device("exec-out", "cat", "/sdcard/openbot-private-fixture.xml").stdout)
                values = text_values(current)
                # Keep only fixed flags. Never save a populated field, arbitrary text or screenshot.
                evidence["lastUi"] = {
                    "pairingInputPresent": any(node.get("class", "").endswith("EditText") for node in current.iter("node")),
                    "fixtureOfferPresent": any(node.get("class", "").endswith("EditText") and node.get("text", "") == link for node in current.iter("node")),
                    "pairButtonPresent": "Pair host" in values,
                    "identityRejected": "The host identity could not be verified." in values,
                    "offerRejected": "This private pairing offer is invalid." in values,
                    "pairingFailed": "The host could not be paired. Check the offer and connection." in values,
                    "networkFailed": "The private host could not be reached." in values,
                }
                return current

            def text_values(value):
                return [node.get(key, "") for node in value.iter("node") for key in ("text", "content-desc", "hint")]

            def wait_for(predicate, timeout=45):
                end = time.monotonic() + timeout
                while time.monotonic() < end:
                    current = tree()
                    if predicate(current):
                        return current
                    time.sleep(1)
                raise RuntimeError("The native fixture UI did not reach its fixed acceptance condition.")

            def launch_offer(phase):
                nonlocal stage
                stage = f"{phase}-launch-input"
                shell("am", "force-stop", package)
                shell("am", "start", "-W", "-n", activity, timeout=90)
                current = wait_for(lambda value: any(node.get("class", "").endswith("EditText") for node in value.iter("node")))
                field = next(node for node in current.iter("node") if node.get("class", "").endswith("EditText"))

                def bounds(node):
                    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
                    if match is None:
                        raise RuntimeError("The fixture UI target has no bounds.")
                    return tuple(map(int, match.groups()))

                left, top, right, bottom = bounds(field)
                shell("input", "tap", str((left + right) // 2), str((top + bottom) // 2))
                stage = f"{phase}-fill-input"
                # Use the same text-input path as startup smoke. Pairing acceptance does not need
                # a cold deep-link route to consume and prefill this long fixture offer.
                # Android input replaces only the special %s escape; JSON URL encoding has none.
                if "%s" in link:
                    raise RuntimeError("The fixture input contains an unsupported text escape.")
                shell("input", "text", shlex.quote(link), timeout=120)
                shell("input", "keyevent", "111")
                current = wait_for(lambda value: any(node.get("class", "").endswith("EditText") and node.get("text", "") == link for node in value.iter("node")))
                stage = f"{phase}-find-submit"
                size = re.findall(r"(\d+)x(\d+)", shell("wm", "size"))
                if not size:
                    raise RuntimeError("The disposable display size is missing.")
                width, height = map(int, size[-1])
                for _attempt in range(8):
                    button = next((node for node in current.iter("node") if node.get("text") == "Pair host" or node.get("content-desc") == "Pair host"), None)
                    if button is not None:
                        left, top, right, bottom = bounds(button)
                        if left < right and top < bottom and 0 <= top < bottom <= height:
                            shell("input", "tap", str((left + right) // 2), str((top + bottom) // 2))
                            return
                    # The multiline input grows for a long offer. Scroll from the outer padding,
                    # not from inside the text field, so the parent scroll view reveals the button.
                    shell("input", "swipe", str(width - 12), str(height * 4 // 5), str(width - 12), str(height // 4), "400")
                    current = tree()
                raise RuntimeError("The fixture submit button did not become visible.")

            stage = "reject-invalid-signature"
            launch_offer("invalid-proof")
            stage = "reject-invalid-signature"
            wait_for(lambda value: "The host identity could not be verified." in text_values(value))
            with state_lock:
                if state["identity"] != 1 or state["pair"] != 0:
                    raise RuntimeError("An invalid host proof must stop before redemption.")
                state["badSignature"] = False
            evidence["steps"].append({"name": "native_TLS_fetch_body_and_invalid_Ed25519_proof_rejected", "passed": True})

            stage = "pair-valid-proof"
            launch_offer("valid-proof")
            stage = "pair-valid-proof"
            wait_for(lambda value: state["pair"] == 1 and not any(node.get("class", "").endswith("EditText") for node in value.iter("node")))
            evidence["steps"].append({"name": "valid_Ed25519_proof_pair_POST_and_saved_native_session", "passed": True})
            stage = "reopen-saved-session"
            shell("am", "force-stop", package)
            if shell("pidof", package, check=False):
                raise RuntimeError("The old app process must stop before the reopen generation.")
            # Close the old listener and join all non-daemon handlers. This also discards pending
            # old TCP connections. Only a new listener generation can count reopen authentication.
            server.shutdown()
            server.server_close()
            thread.join(timeout=10)
            if thread.is_alive():
                raise RuntimeError("The old fixture server did not drain before relaunch.")
            server, thread = start_server(port, 1)
            shell("am", "start", "-W", "-n", activity, timeout=90)
            wait_for(lambda value: state["reopenedWebsocket"] > 0 and "Paste the pairing offer from your computer" not in text_values(value))
            with state_lock:
                if len(state["members"]) != 1 or state["pair"] != 1:
                    raise RuntimeError("Reopen must use the saved session without a second redemption.")
                evidence["requests"] = {"identity": state["identity"], "redemptions": state["pair"], "authenticated": state["authenticated"], "reopenedAuthenticated": state["reopenedAuthenticated"], "reopenedWebsocketAttempts": state["reopenedWebsocket"], "members": len(state["members"])}
            evidence["steps"].append({"name": "process_reopen_restores_SecureStore_session_without_repair", "passed": True})
            evidence["passed"] = True
    except Exception:
        evidence["failedStage"] = stage
        raise RuntimeError(f"The isolated native pairing fixture failed at {stage}.") from None
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=5)
        if state is not None:
            with state_lock:
                evidence["requests"] = {"identity": state["identity"], "redemptions": state["pair"], "authenticated": state["authenticated"], "reopenedAuthenticated": state["reopenedAuthenticated"], "reopenedWebsocketAttempts": state["reopenedWebsocket"], "members": len(state["members"])}
        (output / "native-pairing.json").write_text(json.dumps(evidence, indent=2) + "\n")
    return evidence
