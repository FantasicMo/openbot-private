// Uses the real TeamStore, private owner bootstrap and private host service on an isolated profile.
// HTTP/WS routing and resource cleanup are a fixture, not the real HostService/TeamApiServer.
// Run: bun scripts/private-access-host-e2e.ts
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import type { HostStatus, PrivateAccessPairing, PrivateAccessStatus } from "@openbot/contracts/ipc";
import { createOpenBotLogger } from "@openbot/logging";
import { PrivateHostPairingOfferSchema } from "@openbot/private-access/contracts";
import { Effect, Result, Schema } from "effect";
import { WebSocket, WebSocketServer } from "ws";
import { CentralAuthManager } from "../src/main/central-auth-manager";
import { PrivateAccessHostService } from "../src/main/private-access-host";
import { ensurePrivateOwner } from "../src/main/private-access-owner";
import { TeamStore } from "../src/main/team-store";

const logger = createOpenBotLogger("private-access-host-e2e");
const outputDirectory = resolve(import.meta.dirname, "../.openbot-build/private-access-host-e2e");
const profile = join(outputDirectory, `profile-${randomUUID()}`);
const secrets: string[] = [];
const report: {
  passed: boolean;
  scope: string;
  steps: { name: string; passed: boolean }[];
  settingsPreservation: { case: string; beforeSha256: string; afterSha256: string; revocationPersisted: boolean }[];
  unverified: string[];
} = {
  passed: false,
  scope: "real_TeamStore_owner_and_private_host_service_with_HTTP_WS_fixture",
  steps: [],
  settingsPreservation: [],
  unverified: [
    "OS-backed Electron safeStorage: this fixture uses an ephemeral AES-GCM cipher.",
    "Real HostService, TeamApiServer routes, browser and remote-screen cleanup.",
    "Electron startup, renderer IPC, packaging, Serve TLS, Android and provider execution.",
  ],
};
const deadline = () => AbortSignal.timeout(10_000);
const key = randomBytes(32);
const cipher = {
  encrypt(value: string) {
    secrets.push(value);
    const iv = randomBytes(12);
    const encoder = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([encoder.update(value, "utf8"), encoder.final()]);
    return Buffer.concat([iv, encoder.getAuthTag(), encrypted]);
  },
  decrypt(value: Buffer) {
    const decoder = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
    decoder.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decoder.update(value.subarray(28)), decoder.final()]).toString("utf8");
  },
};

async function step(name: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
    report.steps.push({ name, passed: true });
  } catch {
    report.steps.push({ name, passed: false });
    throw new Error(`The ${name} check failed.`);
  }
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening", { signal: deadline() });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "A loopback listener is required.");
  return address.port;
}

async function main(): Promise<void> {
  await mkdir(profile, { recursive: true });
  const storePath = join(profile, "openbot-team-v2.json");
  await step("disabled_account_stays_signed_out_and_refuses_operations_before_io", async () => {
    let requests = 0;
    const account = new CentralAuthManager({
      enabled: false,
      apiUrl: "https://private-account-fixture.invalid",
      storagePath: join(profile, "disabled-account.json"),
      ...cipher,
      fetch: async () => {
        requests += 1;
        throw new Error("No account request is allowed.");
      },
    });
    try {
      assert.equal(account.getState().status, "signed_out");
      for (const operation of [
        account.retry(),
        account.requestEmailCode("fixture@example.invalid"),
        account.logout(),
      ]) {
        assert.ok(Result.isFailure(await Effect.runPromise(Effect.result(operation))));
        assert.equal(account.getState().status, "signed_out");
      }
      assert.equal(requests, 0);
    } finally {
      await Effect.runPromise(account.dispose());
    }
  });
  let store = new TeamStore(storePath);
  await Effect.runPromise(store.initialize());
  await step("owner_bootstrap_creates_local_identity_without_account", async () => {
    await Effect.runPromise(ensurePrivateOwner({ directory: profile, serverName: "Private E2E Host", store, cipher }));
    assert.ok(store.getIdentity() && store.getOwnerMemberId(), "The real local identity and owner must exist.");
    assert.ok(
      store.getOwnerAnalyticsIdentity() === null && store.getOwnerEmail() === null,
      "The owner must have no account identity.",
    );
    const file = await readFile(join(profile, "openbot-private-owner-v1.json"), "utf8");
    assert.ok(
      secrets.every((value) => !file.includes(value)),
      "The owner file must not contain the plaintext secret.",
    );
  });
  const firstIdentity = store.getIdentity();
  assert.ok(firstIdentity, "The identity must exist.");
  const sockets = new Map<WebSocket, string>();
  const upstream = createServer((request, response) => {
    const token = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
    const session = store.authenticateSession(token);
    response.writeHead(session ? 200 : 401, { "Content-Type": "application/json" });
    response.end(JSON.stringify(session ? { memberId: session.member.id } : { code: "authentication_required" }));
  });
  const webSockets = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("openbot-team-v1") ? "openbot-team-v1" : false),
  });
  upstream.on("upgrade", (request, socket, head) => {
    const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim()) ?? [];
    const token = protocols.find((value) => value.startsWith("openbot-token."))?.slice("openbot-token.".length) ?? "";
    if (!store.authenticateSession(token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (peer) => {
      sockets.set(peer, token);
      peer.on("message", (data, binary) => peer.send(data, { binary }));
      peer.on("close", () => sockets.delete(peer));
    });
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const gatewayPort = await listen(reservation);
  await new Promise<void>((done) => reservation.close(() => done()));
  const refreshSockets = () => {
    for (const [socket, token] of sockets) if (!store.authenticateSession(token)) socket.close(1008, "Access ended");
  };
  const host = {
    startLoopbackOnly: () =>
      Effect.sync(
        (): HostStatus => ({
          phase: "online",
          configured: true,
          enabledOnLaunch: false,
          serverId: store.getIdentity()?.serverId ?? null,
          serverName: store.getIdentity()?.serverName ?? null,
          logoUrl: null,
          apiUrl: `http://127.0.0.1:${upstreamPort}`,
          apiOnline: true,
          remoteDesktopReady: false,
          remoteDesktopScreenRecordingDenied: false,
          remoteDesktopUnattended: false,
          remoteDesktopActiveSessions: 0,
          remoteDesktopMaxSessions: 4,
          message: null,
        }),
      ),
    removeMember: (id: string) => store.removeMember(id).pipe(Effect.tap(() => Effect.sync(refreshSockets))),
    revokeSession: (id: string) => store.revokeSession(id).pipe(Effect.tap(() => Effect.sync(refreshSockets))),
  };
  let service = new PrivateAccessHostService({ directory: profile, store, host });
  const clients: WebSocket[] = [];
  try {
    await step("unconfigured_host_stays_local_with_stable_default_port", async () => {
      const status = await Effect.runPromise(service.initialize());
      assert.ok(
        status.phase === "local-only" && status.publicOrigin === null && status.gatewayPort !== null,
        "A Serve origin must not be required for local startup.",
      );
    });
    await Effect.runPromise(service.configure({ publicOrigin: "https://private-host-fixture.test", gatewayPort }));
    const base = `http://127.0.0.1:${gatewayPort}`;
    const pair = async (offer: PrivateAccessPairing, username: string) => {
      const password = randomBytes(32).toString("base64url");
      secrets.push(password, offer.secret);
      Schema.decodeUnknownSync(PrivateHostPairingOfferSchema)(offer);
      const response = await fetch(`${base}/private-access/v1/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerId: offer.offerId, secret: offer.secret, username, password }),
        signal: deadline(),
      });
      assert.ok(response.status === 201, "The real TeamStore must accept the device invite.");
      const decoded = Schema.decodeUnknownSync(
        Schema.Struct({ member: Schema.Struct({ id: Schema.String }), sessionToken: Schema.String }),
      )(await response.json());
      secrets.push(decoded.sessionToken);
      return { memberId: decoded.member.id, token: decoded.sessionToken };
    };
    const a = await pair(
      await Effect.runPromise(service.createPairing({ role: "admin", label: "Phone A" })),
      "device-a",
    );
    const b = await pair(
      await Effect.runPromise(service.createPairing({ role: "member", label: "Phone B" })),
      "device-b",
    );
    await step("real_store_roles_and_device_labels_match_pairing", async () => {
      const devices = service.getStatus().devices;
      assert.ok(
        devices.some(
          (device) => device.memberId === a.memberId && device.label === "Phone A" && device.role === "admin",
        ),
        "The admin device label and role must be separate from the owner.",
      );
      assert.ok(
        devices.some(
          (device) => device.memberId === b.memberId && device.label === "Phone B" && device.role === "member",
        ),
        "The second member must retain its explicit role.",
      );
      assert.ok(
        !devices.some((device) => device.memberId === store.getOwnerMemberId()),
        "The owner must not be exposed as a paired device.",
      );
    });
    await step("restart_preserves_identity_device_sessions_and_local_labels", async () => {
      await Effect.runPromise(service.shutdown());
      store = new TeamStore(storePath);
      await Effect.runPromise(store.initialize());
      await Effect.runPromise(
        ensurePrivateOwner({ directory: profile, serverName: "Ignored on restart", store, cipher }),
      );
      assert.ok(
        store.getIdentity()?.serverId === firstIdentity.serverId &&
          store.getIdentity()?.fingerprint === firstIdentity.fingerprint,
        "The host identity must persist.",
      );
      service = new PrivateAccessHostService({ directory: profile, store, host });
      const status = await Effect.runPromise(service.initialize());
      assert.ok(
        status.phase === "ready" && status.devices.some((device) => device.label === "Phone A"),
        "The gateway configuration and labels must persist.",
      );
      assert.ok(
        store.authenticateSession(a.token) && store.authenticateSession(b.token),
        "Device sessions must remain owned by the real store after reload.",
      );
    });
    const connect = async (token: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/v1/events`, [
        "openbot-team-v1",
        `openbot-token.${token}`,
      ]);
      clients.push(socket);
      await once(socket, "open", { signal: deadline() });
      return socket;
    };
    const socketA = await connect(a.token);
    const socketB = await connect(b.token);
    await step("real_member_revoke_closes_A_and_preserves_B", async () => {
      const closed = once(socketA, "close", { signal: deadline() });
      await Effect.runPromise(service.revokeDevice(a.memberId));
      await closed;
      assert.ok(
        (await fetch(`${base}/v1/me`, { headers: { Authorization: `Bearer ${a.token}` }, signal: deadline() }))
          .status === 401,
        "A must lose HTTP access.",
      );
      assert.ok(
        (await fetch(`${base}/v1/me`, { headers: { Authorization: `Bearer ${b.token}` }, signal: deadline() }))
          .status === 200,
        "B must retain HTTP access.",
      );
      const message = once(socketB, "message", { signal: deadline() });
      socketB.send("B remains active");
      await message;
    });
    await step("real_session_revoke_closes_its_existing_socket", async () => {
      const session = store.authenticateSession(b.token);
      assert.ok(session, "The second session must exist.");
      const closed = once(socketB, "close", { signal: deadline() });
      await Effect.runPromise(service.revokeSession(session.sessionId));
      await closed;
      assert.ok(store.authenticateSession(b.token) === null, "The stored session must be gone.");
    });
    await step("clearing_origin_keeps_local_profile_and_port", async () => {
      const status = await Effect.runPromise(service.configure({ publicOrigin: null, gatewayPort }));
      assert.ok(
        status.phase === "local-only" && status.gatewayPort === gatewayPort && status.hostId === firstIdentity.serverId,
        "Clearing private ingress must keep the local host.",
      );
    });
    await step("unreadable_owner_secret_fails_without_replacing_identity", async () => {
      const result = await Effect.runPromise(
        ensurePrivateOwner({
          directory: profile,
          serverName: "Never replace",
          store,
          cipher: {
            encrypt: cipher.encrypt,
            decrypt: () => {
              throw new Error("Fixture cipher unavailable.");
            },
          },
        }).pipe(Effect.result),
      );
      assert.ok(
        Result.isFailure(result) && result.failure.code === "owner_secret_unavailable",
        "An unreadable owner secret must fail closed.",
      );
      assert.ok(
        store.getIdentity()?.fingerprint === firstIdentity.fingerprint,
        "A cipher error must not replace the host identity.",
      );
    });
    await Effect.runPromise(service.shutdown());
    for (const fixture of [
      {
        name: "unknown_version",
        bytes: Buffer.from('{\n  "version": 2, "labels": {}, "futureSetting": "preserve exactly"\n}\n', "utf8"),
      },
      { name: "corrupt_bytes", bytes: Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x0a]) },
    ]) {
      await step(`revoke_device_preserves_${fixture.name}_settings_bytes`, async () => {
        const invite = await Effect.runPromise(store.createInvite("admin"));
        const password = randomBytes(32).toString("base64url");
        secrets.push(invite.token, password);
        const accepted = await Effect.runPromise(
          store.acceptInvite(invite.token, `readonly-${fixture.name}`, password),
        );
        secrets.push(accepted.sessionToken);
        assert.ok(
          store.authenticateSession(accepted.sessionToken),
          "The real device session must exist before revocation.",
        );
        const settingsPath = join(profile, "openbot-private-access-v1.json");
        await writeFile(settingsPath, fixture.bytes);
        service = new PrivateAccessHostService({ directory: profile, store, host });
        const initial = await Effect.runPromise(service.initialize());
        assert.equal(initial.phase, "error");
        assert.equal(initial.errorCode, "invalid_configuration");
        assert.ok(initial.devices.some((device) => device.memberId === accepted.member.id));
        let notified: PrivateAccessStatus | undefined;
        service.once("changed", (status) => {
          notified = status;
        });
        const revoked = await Effect.runPromise(service.revokeDevice(accepted.member.id));
        assert.equal(revoked.phase, "error");
        assert.equal(revoked.errorCode, "invalid_configuration");
        assert.ok(!revoked.devices.some((device) => device.memberId === accepted.member.id));
        assert.ok(notified && !notified.devices.some((device) => device.memberId === accepted.member.id));
        assert.equal(store.authenticateSession(accepted.sessionToken), null);
        const after = await readFile(settingsPath);
        assert.deepEqual(after, fixture.bytes, "Revocation must preserve every unreadable settings byte.");
        const reloaded = new TeamStore(storePath);
        await Effect.runPromise(reloaded.initialize());
        assert.equal(reloaded.authenticateSession(accepted.sessionToken), null);
        assert.ok(!reloaded.listMembers().some((member) => member.id === accepted.member.id));
        assert.equal(reloaded.getIdentity()?.fingerprint, firstIdentity.fingerprint);
        report.settingsPreservation.push({
          case: fixture.name,
          beforeSha256: createHash("sha256").update(fixture.bytes).digest("hex"),
          afterSha256: createHash("sha256").update(after).digest("hex"),
          revocationPersisted: true,
        });
        await Effect.runPromise(service.shutdown());
      });
    }
    report.passed = true;
  } finally {
    for (const socket of clients) socket.terminate();
    await Effect.runPromise(service.shutdown());
    for (const socket of sockets.keys()) socket.terminate();
    await new Promise<void>((done) => webSockets.close(() => done()));
    await new Promise<void>((done, reject) => upstream.close((error) => (error ? reject(error) : done())));
  }
}

try {
  await main();
} catch {
  report.passed = false;
  logger.error("The private host service check failed. See the redacted report.");
  process.exitCode = 1;
} finally {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  assert.ok(
    secrets.every((secret) => !text.includes(secret)),
    "The report must not contain any generated credential.",
  );
  await mkdir(outputDirectory, { recursive: true });
  const output = join(outputDirectory, "report.json");
  await writeFile(output, text);
  // Machine-readable: report status and path only, with no generated credentials or payloads.
  process.stdout.write(`${JSON.stringify({ passed: report.passed, report: output })}\n`);
}
