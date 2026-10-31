// Runs the real private gateway and pairing service against an injected authority fixture and a
// loopback HTTP/WS host. No desktop, real TeamStore, Serve TLS, phone or provider is exercised.
// Run: bun scripts/private-access-gateway-e2e.ts
// Writes a redacted .openbot-build/private-access-gateway-e2e/report.json.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { resolve } from "node:path";
import type { TeamMemberSummary } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Result, Schema } from "effect";
import { WebSocket, WebSocketServer } from "ws";
import {
  PRIVATE_PAIRING_PATH,
  type PrivateAuthenticatedMember,
  type PrivatePairingAuthority,
  type PrivatePairingOffer,
  type PrivatePairingRequest,
  type PrivatePairingRole,
  type PrivateSession,
} from "../packages/private-access/src/contracts";
import { PrivateAccessGateway, PrivatePairingService } from "../packages/private-access/src/node";

const logger = createOpenBotLogger("private-access-gateway-e2e");
const output = resolve(import.meta.dirname, "../.openbot-build/private-access-gateway-e2e/report.json");
const publicOrigin = "https://private-access-fixture.test";
const deadline = () => AbortSignal.timeout(10_000);
const secrets: string[] = [];
const report: {
  scope: string;
  passed: boolean;
  steps: { name: string; passed: boolean; error?: string }[];
  unverified: string[];
} = {
  scope: "real_private_module_with_fixture_authority_and_loopback_host",
  passed: false,
  steps: [],
  unverified: [
    "Real TeamStore and TeamApiServer adapter integration and persistence.",
    "Electron startup, sandbox, IPC, private onboarding and packaging.",
    "Tailscale Serve HTTPS/WSS, network ACLs and certificate trust.",
    "Android emulator or phone, provider execution, viewer/media routes and remote desktop.",
  ],
};

class FixtureAuthorityError extends Schema.TaggedError<FixtureAuthorityError>()("FixtureAuthorityError", {
  code: Schema.String,
}) {}

function secret(): string {
  const value = randomBytes(32).toString("base64url");
  secrets.push(value);
  return value;
}

async function step(name: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
    report.steps.push({ name, passed: true });
  } catch (error) {
    let message = error instanceof Error ? error.message : "The service check failed.";
    for (const value of secrets) message = message.replaceAll(value, "[redacted]");
    report.steps.push({ name, passed: false, error: message.slice(0, 500) });
    throw new Error(`The ${name} check failed.`);
  }
}

function fixture() {
  let now = Date.now();
  let failRevoke = false;
  let accepted = 0;
  const invites = new Map<string, { id: string; role: PrivatePairingRole }>();
  const members = new Map<string, TeamMemberSummary>();
  const sessions = new Map<string, PrivateSession>();
  const sockets = new Map<WebSocket, { memberId: string; sessionId: string }>();
  const issueSession = (member: TeamMemberSummary): PrivateAuthenticatedMember => {
    const sessionToken = secret();
    const sessionExpiresAt = new Date(now + 86_400_000).toISOString();
    sessions.set(sessionToken, { member, sessionId: randomUUID(), sessionExpiresAt });
    return { member, sessionToken, sessionExpiresAt };
  };
  const attempt = <A>(operation: () => A) =>
    Effect.try({
      try: operation,
      catch: () => new FixtureAuthorityError({ code: "fixture_refused" }),
    });
  const authority: PrivatePairingAuthority<FixtureAuthorityError> = {
    createInvite: (role) =>
      attempt(() => {
        const token = secret();
        const id = randomUUID();
        invites.set(token, { id, role });
        return { id, token, role, expiresAt: new Date(now + 86_400_000).toISOString(), email: null, permanent: false };
      }),
    acceptInvite: (token, username, _password) =>
      attempt(() => {
        const invite = invites.get(token);
        assert.ok(invite, "The fixture invite must exist.");
        invites.delete(token);
        accepted++;
        const member: TeamMemberSummary = {
          id: randomUUID(),
          username,
          email: null,
          name: null,
          role: invite.role,
          createdAt: new Date(now).toISOString(),
          disabled: false,
        };
        members.set(member.id, member);
        return issueSession(member);
      }),
    revokeInvite: (inviteId) =>
      attempt(() => {
        if (failRevoke) {
          failRevoke = false;
          throw new Error("Fixture revoke failure.");
        }
        for (const [token, invite] of invites) if (invite.id === inviteId) invites.delete(token);
      }),
    authenticateSession: (token) => sessions.get(token) ?? null,
    revokeSession: (sessionId) =>
      attempt(() => {
        for (const [token, session] of sessions) {
          if (session.sessionId !== sessionId) continue;
          sessions.delete(token);
          for (const [socket, binding] of sockets)
            if (binding.sessionId === sessionId) socket.close(1008, "Access ended");
        }
      }),
    removeMember: (memberId) =>
      attempt(() => {
        assert.ok(members.has(memberId), "The fixture member must exist.");
        members.delete(memberId);
        for (const [token, session] of sessions) if (session.member.id === memberId) sessions.delete(token);
        for (const [socket, binding] of sockets) if (binding.memberId === memberId) socket.close(1008, "Access ended");
      }),
  };
  return {
    authority,
    sockets,
    now: () => now,
    expire: () => {
      now += 1000;
    },
    failNextRevoke: () => {
      failRevoke = true;
    },
    accepted: () => accepted,
    additionalSession: (memberId: string) => {
      const member = members.get(memberId);
      assert.ok(member, "The fixture member must exist.");
      return issueSession(member);
    },
  };
}

function requestSession(request: IncomingMessage, authority: PrivatePairingAuthority<FixtureAuthorityError>) {
  const token = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
  return authority.authenticateSession(token);
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening", { signal: deadline() });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "The fixture must listen on loopback.");
  return address.port;
}

function requestRaw(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, headers, signal: deadline() }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

function pairingRequest(offer: PrivatePairingOffer, username: string): PrivatePairingRequest {
  secrets.push(offer.secret);
  return { offerId: offer.offerId, secret: offer.secret, username, password: secret() };
}

async function send(socket: WebSocket, data: string | Buffer): Promise<{ binary: boolean; data: Buffer }> {
  const message = once(socket, "message", { signal: deadline() });
  socket.send(data);
  const [received, binary] = await message;
  assert.ok(Buffer.isBuffer(received), "The fixture must return byte data.");
  return { binary, data: received };
}

async function main(): Promise<void> {
  const host = fixture();
  const seen: { headers: IncomingMessage["headers"]; path: string }[] = [];
  const delayed = new EventEmitter();
  const upstream = createServer((request, response) => {
    seen.push({ headers: request.headers, path: request.url ?? "" });
    const session = requestSession(request, host.authority);
    if (!session) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.url === "/v1/delayed") {
      response.on("close", () => delayed.emit("closed"));
      delayed.emit("received");
      return;
    }
    if (request.url?.startsWith("/v1/binary")) {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Set-Cookie": ["fixture=value; HttpOnly"],
      });
      request.pipe(response);
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ memberId: session.member.id }));
  });
  const webSockets = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("openbot-team-v1") ? "openbot-team-v1" : false),
  });
  upstream.on("upgrade", (request, socket, head) => {
    const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim()) ?? [];
    const token = protocols.find((value) => value.startsWith("openbot-token."))?.slice("openbot-token.".length) ?? "";
    const session = host.authority.authenticateSession(token);
    if (!session) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (peer) => {
      host.sockets.set(peer, { memberId: session.member.id, sessionId: session.sessionId });
      peer.on("message", (data, isBinary) => peer.send(data, { binary: isBinary }));
      peer.on("close", () => host.sockets.delete(peer));
    });
  });
  const upstreamPort = await listen(upstream);
  const pairing = new PrivatePairingService({ authority: host.authority, now: host.now });
  const gateway = new PrivateAccessGateway({
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    publicOrigin,
    port: 0,
    pairing,
  });
  const clients: WebSocket[] = [];
  try {
    await step("non_loopback_upstream_is_refused", async () => {
      const invalidPairing = new PrivatePairingService({ authority: host.authority });
      const invalid = new PrivateAccessGateway({
        upstreamOrigin: "http://192.0.2.1:8080",
        publicOrigin,
        port: 0,
        pairing: invalidPairing,
      });
      const result = await Effect.runPromise(invalid.start().pipe(Effect.result));
      assert.ok(
        Result.isFailure(result) && result.failure.code === "invalid_configuration",
        "A non-loopback upstream must be refused before listening.",
      );
      await Effect.runPromise(invalid.stop());
    });
    const address = await Effect.runPromise(gateway.start());
    const base = `http://127.0.0.1:${address.port}`;
    const redeem = (input: PrivatePairingRequest) =>
      fetch(`${base}${PRIVATE_PAIRING_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: deadline(),
      });
    let deviceA: PrivateAuthenticatedMember | null = null;
    let deviceB: PrivateAuthenticatedMember | null = null;
    await step("concurrent_pairing_is_single_use", async () => {
      const offer = await Effect.runPromise(pairing.createOffer("admin"));
      const input = pairingRequest(offer, "device-a");
      const acceptedBefore = host.accepted();
      const responses = await Promise.all([redeem(input), redeem(input)]);
      assert.ok(
        responses.filter((response) => response.status === 201).length === 1,
        `Exactly one redemption must succeed. Statuses: ${responses.map((response) => response.status).join(",")}.`,
      );
      assert.ok(
        responses.filter((response) => response.status === 401).length === 1,
        "The second redemption must be refused.",
      );
      assert.ok(host.accepted() === acceptedBefore + 1, "The authority must accept the invite once.");
      const accepted = responses.find((response) => response.status === 201);
      assert.ok(accepted, "One response must contain the device session.");
      deviceA = await accepted.json();
    });
    await step("expired_pairing_is_refused", async () => {
      const offer = await Effect.runPromise(pairing.createOffer("member", 1));
      const input = pairingRequest(offer, "expired-device");
      host.expire();
      assert.ok((await redeem(input)).status === 401, "An expired offer must fail.");
      assert.ok((await redeem(input)).status === 401, "An expired offer must stay invalid.");
    });
    await step("failed_expiry_cleanup_does_not_reopen_offer", async () => {
      const offer = await Effect.runPromise(pairing.createOffer("member", 1));
      const input = pairingRequest(offer, "failed-cleanup-device");
      host.expire();
      host.failNextRevoke();
      assert.ok((await redeem(input)).status === 503, "An authority failure must fail closed.");
      assert.ok((await redeem(input)).status === 401, "Cleanup failure must not restore the handle.");
    });
    await step("committed_pairing_returns_credential_when_invite_cleanup_fails", async () => {
      const offer = await Effect.runPromise(pairing.createOffer("member"));
      const input = pairingRequest(offer, "committed-device");
      host.failNextRevoke();
      const response = await redeem(input);
      assert.ok(response.status === 201, "A committed join must return its active credential.");
      const value: PrivateAuthenticatedMember = await response.json();
      secrets.push(value.sessionToken);
      assert.ok(
        host.authority.authenticateSession(value.sessionToken) !== null,
        "The returned credential must be usable.",
      );
      assert.ok((await redeem(input)).status === 401, "Cleanup failure must not restore the consumed offer.");
      await Effect.runPromise(pairing.revokeDevice(value.member.id));
    });
    const secondOffer = await Effect.runPromise(pairing.createOffer("member"));
    const second = await redeem(pairingRequest(secondOffer, "device-b"));
    assert.ok(second.status === 201, "The second device must pair.");
    deviceB = await second.json();
    assert.ok(deviceA && deviceB, "Both device credentials must be available.");
    const a: PrivateAuthenticatedMember = deviceA;
    const b: PrivateAuthenticatedMember = deviceB;
    secrets.push(a.sessionToken, b.sessionToken);
    await step("client_disconnect_before_headers_closes_upstream_transport", async () => {
      const received = once(delayed, "received", { signal: deadline() });
      const closed = once(delayed, "closed", { signal: deadline() });
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/v1/delayed",
        headers: { Authorization: `Bearer ${a.sessionToken}` },
      });
      request.on("error", () => undefined);
      request.end();
      await received;
      request.destroy();
      await closed;
    });
    await step("http_auth_protocol_and_trusted_forwarding_are_preserved", async () => {
      assert.ok(
        (await fetch(`${base}/v1/echo`, { signal: deadline() })).status === 401,
        "The gateway must not add authorization.",
      );
      const response = await fetch(`${base}/v1/echo?target=https://untrusted.invalid`, {
        headers: {
          Authorization: `Bearer ${a.sessionToken}`,
          "OpenBot-Protocol-Version": "9",
          "OpenBot-App-Version": "0.56.0",
          "OpenBot-Capabilities": "long-capability-lists-v1",
          Cookie: "viewer=fixture",
          Forwarded: "host=untrusted.invalid;proto=http",
          "X-Forwarded-Host": "untrusted.invalid",
          "X-Forwarded-Proto": "http",
          "X-Forwarded-For": "192.0.2.50",
          "Tailscale-User-Login": "untrusted@example.invalid",
        },
        signal: deadline(),
      });
      assert.ok(response.status === 200, "An authorized request must pass.");
      const received = seen.at(-1);
      assert.ok(received, "The fixed upstream must receive the request.");
      assert.ok(received.headers.authorization === `Bearer ${a.sessionToken}`, "Authorization must pass unchanged.");
      assert.ok(received.headers["openbot-protocol-version"] === "9", "The negotiated protocol must pass unchanged.");
      assert.ok(
        received.headers["openbot-capabilities"] === "long-capability-lists-v1",
        "Capabilities must pass unchanged.",
      );
      assert.ok(received.headers.cookie === "viewer=fixture", "A host cookie must pass unchanged.");
      assert.ok(
        received.headers["x-forwarded-host"] === "private-access-fixture.test",
        "The configured public host must replace spoofed headers.",
      );
      assert.ok(
        received.headers["x-forwarded-proto"] === "https",
        "The configured HTTPS protocol must replace spoofed headers.",
      );
      assert.ok(
        received.headers.forwarded === undefined &&
          received.headers["x-forwarded-for"] === undefined &&
          received.headers["tailscale-user-login"] === undefined,
        "Caller identity forwarding must not be trusted.",
      );
    });
    await step("binary_http_and_response_cookie_are_preserved", async () => {
      const bytes = randomBytes(65_537);
      const response = await fetch(`${base}/v1/binary`, {
        method: "POST",
        headers: { Authorization: `Bearer ${a.sessionToken}`, "Content-Type": "application/octet-stream" },
        body: bytes,
        signal: deadline(),
      });
      const received = Buffer.from(await response.arrayBuffer());
      const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
      assert.ok(
        response.status === 200 && digest(bytes) === digest(received),
        "Binary bytes must arrive without a change.",
      );
      assert.ok(
        response.headers.get("set-cookie")?.includes("fixture=value"),
        "The host's viewer cookie must pass unchanged.",
      );
    });
    await step("absolute_target_traversal_and_spoofed_host_are_refused", async () => {
      const before = seen.length;
      assert.ok(
        (await requestRaw(address.port, "http://untrusted.invalid/v1/echo")) === 400,
        "An absolute request target must be refused.",
      );
      assert.ok(
        (await requestRaw(address.port, "/v1/%2e%2e/private-access/v1/pair")) === 400,
        "Encoded traversal must be refused.",
      );
      assert.ok(
        (await requestRaw(address.port, "/v1/echo", { Host: "untrusted.invalid" })) === 400,
        "An unrelated Host header must be refused.",
      );
      assert.ok(seen.length === before, "Refused paths must not reach the upstream.");
    });
    const connect = async (token: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/events`, [
        "openbot-team-v1",
        `openbot-token.${token}`,
      ]);
      clients.push(socket);
      await once(socket, "open", { signal: deadline() });
      return socket;
    };
    const socketA = await connect(a.sessionToken);
    const socketB = await connect(b.sessionToken);
    await step("websocket_subprotocol_text_and_binary_are_preserved", async () => {
      assert.ok(socketA.protocol === "openbot-team-v1", "The upstream's selected subprotocol must reach the client.");
      const text = await send(socketA, "fixture-event");
      assert.ok(!text.binary && text.data.toString() === "fixture-event", "A text frame must stay text.");
      const bytes = Buffer.from([0, 255, 128, 1, 13, 10]);
      const binary = await send(socketB, bytes);
      assert.ok(binary.binary && binary.data.equals(bytes), "A binary frame must stay binary.");
    });
    await step("authority_revokes_A_and_its_socket_while_B_stays_active", async () => {
      const closed = once(socketA, "close", { signal: deadline() });
      await Effect.runPromise(pairing.revokeDevice(a.member.id));
      await closed;
      assert.ok(
        (await fetch(`${base}/v1/echo`, { headers: { Authorization: `Bearer ${a.sessionToken}` }, signal: deadline() }))
          .status === 401,
        "The revoked device must lose HTTP access.",
      );
      assert.ok(
        (await fetch(`${base}/v1/echo`, { headers: { Authorization: `Bearer ${b.sessionToken}` }, signal: deadline() }))
          .status === 200,
        "The other device must keep HTTP access.",
      );
      assert.ok(
        (await send(socketB, "B remains active")).data.toString() === "B remains active",
        "The other device must keep its existing socket.",
      );
    });
    await step("authority_revokes_one_session_and_its_socket", async () => {
      const replacement = host.additionalSession(b.member.id);
      const otherSocket = await connect(replacement.sessionToken);
      const session = host.authority.authenticateSession(b.sessionToken);
      assert.ok(session, "The second session must exist before revocation.");
      const closed = once(socketB, "close", { signal: deadline() });
      await Effect.runPromise(pairing.revokeSession(session.sessionId));
      await closed;
      assert.ok(
        (await fetch(`${base}/v1/echo`, { headers: { Authorization: `Bearer ${b.sessionToken}` }, signal: deadline() }))
          .status === 401,
        "A revoked session must lose access.",
      );
      assert.ok(
        host.authority.authenticateSession(replacement.sessionToken) !== null,
        "The member's other session must stay valid.",
      );
      assert.ok(
        (await send(otherSocket, "Other session remains active")).data.toString() === "Other session remains active",
        "The member's other socket must stay open.",
      );
    });
    report.passed = true;
  } finally {
    for (const client of clients) client.terminate();
    await Effect.runPromise(gateway.stop());
    for (const peer of host.sockets.keys()) peer.terminate();
    await new Promise<void>((done) => webSockets.close(() => done()));
    await new Promise<void>((done, reject) => upstream.close((error) => (error ? reject(error) : done())));
  }
}

try {
  await main();
} catch {
  report.passed = false;
  logger.error("The private gateway service check failed. See the redacted report for the failed step.");
  process.exitCode = 1;
} finally {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  assert.ok(
    secrets.every((value) => !serialized.includes(value)),
    "The report must not contain a fixture credential.",
  );
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, serialized);
  // Machine-readable: no request, response, pairing secret, token or credential is printed.
  process.stdout.write(`${JSON.stringify({ passed: report.passed, report: output })}\n`);
}
