// Real mobile transport/store -> real private service/gateway -> real TeamStore.
// The Team API HTTP/WS routes and native network/storage ports are isolated fixtures.
// No Expo runtime, TLS trust, Android, tailnet or model provider is exercised.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import {
  type AgentEvent,
  type AgentStatus,
  type HostStatus,
  isAgentStatus,
  type TeamRealtimeEvent,
} from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { AGENT_IMPORT_ROUTES, AGENT_IMPORT_UPLOAD_BYTES } from "@openbot/contracts/team-protocol/agent-import-v1";
import { teamCapabilitiesForProtocol } from "@openbot/contracts/team-protocol/current";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import {
  INSTANCE_TRANSFER_REMOTE_BYTES,
  INSTANCE_TRANSFER_ROUTES,
} from "@openbot/contracts/team-protocol/instance-transfer-v1";
import { encodeTeamProtocolV8BaseCurrentEvent } from "@openbot/contracts/team-protocol/v8-base-adapter";
import { sourceText } from "@openbot/i18n/source";
import { PRIVATE_PAIRING_PATH } from "@openbot/private-access/contracts";
import { agentEventCanNotify } from "@openbot/team-client/agent-notifications";
import { MOBILE_ATTACHMENT_BYTES } from "@openbot/team-client/remote-peer";
import { Effect } from "effect";
import { type WebSocket, WebSocketServer } from "ws";
import {
  MAX_PRIVATE_HOSTS,
  PrivateMobileError,
  privatePairingDiagnosticCode,
} from "../apps/mobile/src/features/private-access/private-contracts";
import { PrivateHostStore } from "../apps/mobile/src/features/private-access/private-host-store";
import {
  PrivateHttpTransport,
  verifyPrivateHost,
} from "../apps/mobile/src/features/private-access/private-http-transport";
import type { PrivateNetworkPort } from "../apps/mobile/src/features/private-access/private-ports";
import {
  type MobileAgentActivities,
  reduceAgentActivity,
} from "../apps/mobile/src/features/workspace/model/agent-activity";
import { contentDispositionFileName } from "../src/main/content-disposition";
import { PrivateAccessHostService } from "../src/main/private-access-host";
import { TeamStore } from "../src/main/team-store";

const output = resolve(import.meta.dirname, "../.openbot-build/private-mobile-transport-e2e");
const origin = "https://private-mobile-fixture.test";
const mobileAppVersion = "1.4.5";
const upstream058Capabilities = [
  "agent-new-chat-v1",
  "browser-profiles-events-v1",
  "agent-plan-card-v1",
  "ui-block-auto-answer-v1",
  "agent-folders-v1",
  "host-key-rotation-v1",
  "agent-thread-branches-v1",
  "custom-agents-v1",
  "channel-task-cancel-v1",
  "workflows-github-v1",
];
const report: { passed: boolean; scope: string; steps: { name: string; passed: boolean }[]; unverified: string[] } = {
  passed: false,
  scope: "real_mobile_adapters_private_service_and_TeamStore_with_native_and_Team_API_fixture_ports",
  steps: [],
  unverified: [
    "Expo native fetch/WebSocket/SecureStore and Android UI.",
    "Real TeamApiServer and provider execution.",
    "TLS, Tailscale Serve, Clash Mi and physical phone coexistence.",
  ],
};
const secretValues: string[] = [];
async function step(name: string, action: () => Promise<void>) {
  try {
    await action();
    report.steps.push({ name, passed: true });
  } catch (error) {
    report.steps.push({ name, passed: false });
    let message = error instanceof Error ? error.message : "Fixture operation failed";
    for (const secret of secretValues) message = message.replaceAll(secret, "[redacted]");
    process.stderr.write(`${JSON.stringify({ step: name, error: message.slice(0, 500) })}\n`);
    throw new Error(`The ${name} check failed.`);
  }
}
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening", { signal: AbortSignal.timeout(10_000) });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function until(condition: () => boolean) {
  const end = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < end, "The fixture event must arrive before its deadline.");
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function main() {
  const profile = join(output, `profile-${randomUUID()}`);
  await mkdir(profile, { recursive: true });
  const store = new TeamStore(join(profile, "openbot-team-v2.json"));
  await Effect.runPromise(store.initialize());
  const ownerSecret = randomBytes(32).toString("base64url");
  secretValues.push(ownerSecret);
  await Effect.runPromise(store.configure("Private mobile fixture", "fixture-owner", ownerSecret));
  const identity = store.getIdentity();
  assert.ok(identity);
  const codec = teamHttpCodec(9);
  const diagnosticMessage = "Fixture provider diagnostic";
  const providerStatus: AgentStatus = {
    phase: "ready",
    cliVersion: "fixture",
    auth: { kind: "chatgpt", email: null },
    providers: [
      {
        id: "codex",
        state: "available",
        version: "fixture",
        message: "Fixture provider message",
        checkError: "Fixture sign-in check",
        lastError: diagnosticMessage,
        lastErrorAt: 1,
      },
    ],
    capabilities: { chat: "ready", browser: "unavailable", computerUse: "unavailable" },
    message: null,
    fullAccess: true,
  };
  const frames: string[] = [];
  const requests: { method: string; path: string }[] = [];
  const messages: unknown[] = [];
  const sessions = new Map<WebSocket, string>();
  const uploadStarted = new Set<string>();
  const finishUploads = new Map<string, () => void>();
  const networkPaths: string[] = [];
  let loseNextMessage = false;
  let failStorage = false;
  let failCommittedSave = false;
  let losePairResponse = false;
  let mobileNow = Date.now();
  let persisted: string | null = null;
  const file = Uint8Array.from([0, 255, 128, 13, 10, 42]);
  let transferFile: Buffer | null = null;
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    requests.push({ method, path: url.pathname });
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      if (url.pathname === TEAM_API_ROUTES.identity) {
        json(200, store.getIdentityProof(url.searchParams.get("challenge") ?? ""));
        return;
      }
      if (url.pathname === TEAM_API_ROUTES.compatibility) {
        json(200, {
          appVersion: "0.58.0",
          protocol: { minimum: 3, maximum: 9 },
          capabilities: teamCapabilitiesForProtocol(9),
        });
        return;
      }
      if (url.pathname === "/v1/auth/login" && method === "POST") {
        if (!request.headers["openbot-protocol-version"] || !request.headers["openbot-app-version"]) {
          json(426, { code: "client_update_required" });
          return;
        }
        assert.equal(request.headers["openbot-protocol-version"], "9");
        assert.equal(request.headers["openbot-app-version"], mobileAppVersion);
        assert.ok(String(request.headers["openbot-capabilities"]).includes("long-capability-lists-v1"));
        for (const capability of upstream058Capabilities)
          assert.ok(String(request.headers["openbot-capabilities"]).split(",").includes(capability));
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.equal(typeof body.username, "string");
        assert.equal(typeof body.password, "string");
        try {
          json(200, await Effect.runPromise(store.login(body.username, body.password)));
        } catch {
          json(401, { code: "authentication_required" });
        }
        return;
      }
      const token = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
      if (!store.authenticateSession(token)) {
        json(401, { code: "authentication_required" });
        return;
      }
      assert.equal(request.headers["openbot-protocol-version"], "9");
      if (
        method === "POST" &&
        (url.pathname === AGENT_IMPORT_ROUTES.stage || url.pathname === INSTANCE_TRANSFER_ROUTES.stage)
      ) {
        assert.ok(transferFile);
        assert.equal(request.headers["content-type"], "application/zip");
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of request) {
          hash.update(chunk);
          size += chunk.length;
        }
        assert.equal(size, transferFile.byteLength);
        assert.equal(hash.digest("hex"), createHash("sha256").update(transferFile).digest("hex"));
        json(
          200,
          url.pathname === AGENT_IMPORT_ROUTES.stage
            ? {
                token: "fixture-import",
                sourceApp: "Grok Bot",
                exportedAt: null,
                agents: [],
                channels: [],
                warnings: [],
              }
            : {
                token: "fixture-transfer",
                appVersion: "0.58.0",
                exportedAt: null,
                agents: [],
                hasSettings: true,
                warnings: [],
              },
        );
        return;
      }
      if (url.pathname === INSTANCE_TRANSFER_ROUTES.export && method === "POST") {
        assert.ok(transferFile);
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
          agentIds: ["fixture-agent"],
          includeFiles: true,
          includeSettings: true,
        });
        response.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("主机导出.zip")}`,
          ...(url.searchParams.has("oversized")
            ? { "Content-Length": String(INSTANCE_TRANSFER_REMOTE_BYTES + 1) }
            : {}),
        });
        response.end(transferFile);
        return;
      }
      if (url.pathname === TEAM_API_ROUTES.agents.status && method === "GET") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(codec.encodeResponse(method, url.pathname, 200, providerStatus, {}));
        return;
      }
      if (url.pathname === TEAM_API_ROUTES.attachment("fixture-file")) {
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": url.searchParams.get("disposition") ?? "attachment; filename*=UTF-8''fixture.bin",
          ...(url.searchParams.has("oversized") ? { "Content-Length": String(MOBILE_ATTACHMENT_BYTES + 1) } : {}),
        });
        response.end(file);
        return;
      }
      if (url.pathname === TEAM_API_ROUTES.attachments && method === "POST") {
        const transfer = url.searchParams.get("slow");
        if (transfer) {
          uploadStarted.add(transfer);
          finishUploads.set(transfer, () =>
            json(200, {
              id: `draft-${transfer}`,
              name: "fixture.bin",
              mimeType: "application/octet-stream",
              size: file.length,
              kind: "file",
              previewKind: "none",
              previewUrl: null,
            }),
          );
          request.resume();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        assert.deepEqual(Buffer.concat(chunks), Buffer.from(file));
        json(200, {
          id: "draft-fixture",
          name: "fixture.bin",
          mimeType: "application/octet-stream",
          size: file.length,
          kind: "file",
          previewKind: "none",
          previewUrl: null,
        });
        return;
      }
      if (url.pathname === TEAM_API_ROUTES.agent.messages("fixture-agent") && method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        messages.push(codec.decodeRequest(method, url.pathname, body, { preserveSemanticTags: true }));
        if (loseNextMessage) {
          loseNextMessage = false;
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          codec.encodeResponse(method, url.pathname, 200, { messageId: "fixture-message", deliveries: [] }, {}),
        );
        return;
      }
      if (url.pathname === TEAM_API_ROUTES.sharedFiles) {
        response.writeHead(302, { Location: "https://must-not-be-contacted.invalid/" });
        response.end();
        return;
      }
      json(404, { code: "fixture_route_missing" });
    } catch {
      if (!response.headersSent) json(500, { code: "fixture_failure" });
      else response.destroy();
    }
  });
  const ws = new WebSocketServer({
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
    ws.handleUpgrade(request, socket, head, (peer) => {
      sessions.set(peer, token);
      peer.on("close", () => sessions.delete(peer));
      peer.on("message", (data) => {
        const text = data.toString();
        frames.push(text);
        if (JSON.parse(text).type === "runtime-snapshot-request") {
          const snapshot = encodeTeamProtocolV8BaseCurrentEvent({
            type: "runtime-snapshot",
            snapshot: {
              agents: [],
              activeTurns: [],
              work: [],
              latestMessages: [],
              attentionComplete: true,
              pendingPrompts: [],
              pendingApprovals: [],
              pendingBrowserTakeovers: [],
              failedTurns: [],
            },
          });
          if (snapshot) peer.send(snapshot);
        }
      });
    });
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const gatewayPort = await listen(reservation);
  await new Promise<void>((done) => reservation.close(() => done()));
  const closeRevoked = () => {
    for (const [socket, token] of sessions) if (!store.authenticateSession(token)) socket.close(1008, "Access ended");
  };
  const service = new PrivateAccessHostService({
    directory: profile,
    store,
    host: {
      startLoopbackOnly: () =>
        Effect.sync(
          (): HostStatus => ({
            phase: "online",
            configured: true,
            enabledOnLaunch: false,
            serverId: identity.serverId,
            serverName: identity.serverName,
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
      removeMember: (id) => store.removeMember(id).pipe(Effect.tap(() => Effect.sync(closeRevoked))),
      revokeSession: (id) => store.revokeSession(id).pipe(Effect.tap(() => Effect.sync(closeRevoked))),
    },
  });
  const network: PrivateNetworkPort = {
    // Only the injected test port maps a fixed HTTPS identity to the isolated loopback fixture.
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, origin);
      assert.equal(init?.redirect, "error");
      networkPaths.push(url.pathname);
      url.protocol = "http:";
      url.hostname = "127.0.0.1";
      url.port = String(gatewayPort);
      const response = await fetch(`http://127.0.0.1:${gatewayPort}${url.pathname}${url.search}`, init).catch(
        (error) => {
          throw new Error(
            `Fixture network failure: ${url.origin}${url.pathname}, ${error.code ?? error.name}, upstream requests: ${requests.length}`,
          );
        },
      );
      if (losePairResponse && url.pathname === PRIVATE_PAIRING_PATH && response.ok) {
        losePairResponse = false;
        await response.body?.cancel();
        throw new Error("Fixture lost pairing response");
      }
      return response;
    },
    socket: (input, protocols) => {
      const url = new URL(input);
      assert.equal(url.origin, origin.replace("https:", "wss:"));
      url.protocol = "ws:";
      url.hostname = "127.0.0.1";
      url.port = String(gatewayPort);
      return new globalThis.WebSocket(`ws://127.0.0.1:${gatewayPort}${url.pathname}${url.search}`, protocols);
    },
    randomBytes: (size) => new Uint8Array(randomBytes(size)),
  };
  const storage = {
    read: async () => persisted,
    write: async (value: string) => {
      if (failStorage) throw new Error("Fixture storage failure");
      if (failCommittedSave && !JSON.parse(value).pending) {
        failCommittedSave = false;
        throw new Error("Fixture committed credential save failure");
      }
      persisted = value;
    },
  };
  let hosts = new PrivateHostStore(
    storage,
    network,
    () => undefined,
    () => mobileNow,
    mobileAppVersion,
  );
  const updates: string[] = [];
  const events: string[] = [];
  const receivedEvents: (AgentEvent | TeamRealtimeEvent)[] = [];
  const transport = new PrivateHttpTransport(
    network,
    () => hosts.host(identity.serverId),
    {
      connection: (update) => updates.push(update.state),
      event: (_id, event) => {
        events.push(event.type);
        receivedEvents.push(event);
      },
    },
    mobileAppVersion,
  );
  let capacityPersisted: string | null = null;
  let capacityWrites = 0;
  let recoveryFixtureMemberId: string | null = null;
  const capacityStorage = {
    read: async () => capacityPersisted,
    write: async (value: string) => {
      capacityWrites += 1;
      capacityPersisted = value;
    },
  };
  const capacityHosts = new PrivateHostStore(
    capacityStorage,
    network,
    () => undefined,
    () => mobileNow,
    mobileAppVersion,
  );
  try {
    await Effect.runPromise(service.initialize());
    const status = await Effect.runPromise(service.configure({ publicOrigin: origin, gatewayPort }));
    assert.equal(status.phase, "ready");
    assert.equal((await fetch(`http://127.0.0.1:${gatewayPort}/v1/compatibility`)).status, 200);
    await hosts.restore();
    await step("pair_real_device_member_and_restore_secure_state", async () => {
      const offer = await Effect.runPromise(service.createPairing({ role: "member", label: "Android fixture" }));
      secretValues.push(offer.secret);
      const paired = await hosts.pair(JSON.stringify(offer));
      secretValues.push(paired.username, paired.password, paired.sessionToken);
      assert.equal(paired.member.role, "member");
      assert.ok(store.authenticateSession(paired.sessionToken));
      hosts = new PrivateHostStore(
        storage,
        network,
        () => undefined,
        () => mobileNow,
        mobileAppVersion,
      );
      await hosts.restore();
      assert.equal(hosts.host(identity.serverId).member.id, paired.member.id);
    });
    await step("expired_offer_recovers_only_exact_committed_pending_credentials", async () => {
      const previousMemberId = hosts.host(identity.serverId).member.id;
      const expired = await Effect.runPromise(service.createPairing({ role: "member", label: "Expired unused offer" }));
      secretValues.push(expired.secret);
      mobileNow = Date.parse(expired.expiresAt) + 1;
      const initialPosts = networkPaths.filter((path) => path === PRIVATE_PAIRING_PATH).length;
      await assert.rejects(
        hosts.pair(JSON.stringify(expired)),
        (error) => error instanceof PrivateMobileError && error.code === "expiredOffer",
      );
      assert.equal(networkPaths.filter((path) => path === PRIVATE_PAIRING_PATH).length, initialPosts);
      mobileNow = Date.now();
      const offer = await Effect.runPromise(service.createPairing({ role: "member", label: "Recovered Android" }));
      secretValues.push(offer.secret);
      failCommittedSave = true;
      await assert.rejects(
        hosts.pair(JSON.stringify(offer)),
        (error) => error instanceof PrivateMobileError && error.code === "storage",
      );
      const committedMembers = store.listMembers().length;
      const posted = networkPaths.filter((path) => path === PRIVATE_PAIRING_PATH).length;
      hosts = new PrivateHostStore(
        storage,
        network,
        () => undefined,
        () => mobileNow,
        mobileAppVersion,
      );
      await hosts.restore();
      mobileNow = Date.parse(offer.expiresAt) + 1;
      await assert.rejects(
        hosts.pair(JSON.stringify({ ...offer, hostName: "Changed host" })),
        (error) => error instanceof PrivateMobileError && error.code === "expiredOffer",
      );
      const recovered = await hosts.pair(JSON.stringify(offer));
      secretValues.push(recovered.username, recovered.password, recovered.sessionToken);
      recoveryFixtureMemberId = recovered.member.id;
      assert.ok(store.authenticateSession(recovered.sessionToken));
      assert.equal(store.listMembers().length, committedMembers);
      assert.equal(networkPaths.filter((path) => path === PRIVATE_PAIRING_PATH).length, posted);
      await Effect.runPromise(service.revokeDevice(previousMemberId));
      mobileNow = Date.now();
    });
    await step("expired_offer_recovers_lost_pair_response_without_new_member", async () => {
      mobileNow = Date.now();
      const offer = await Effect.runPromise(service.createPairing({ role: "member", label: "Lost response Android" }));
      secretValues.push(offer.secret);
      losePairResponse = true;
      await assert.rejects(
        hosts.pair(JSON.stringify(offer)),
        (error) =>
          error instanceof PrivateMobileError &&
          error.code === "network" &&
          privatePairingDiagnosticCode(error) === "redemption-request" &&
          !error.message.includes("Fixture lost pairing response"),
      );
      assert.ok(
        store.listMembers().some((member) => member.username === hosts.state().pending?.username.toLowerCase()),
        "The lost response must follow an actual member commit.",
      );
      const committedMembers = store.listMembers().length;
      const posted = networkPaths.filter((path) => path === PRIVATE_PAIRING_PATH).length;
      mobileNow = Date.parse(offer.expiresAt) + 1;
      hosts = new PrivateHostStore(
        storage,
        network,
        () => undefined,
        () => mobileNow,
        mobileAppVersion,
      );
      await hosts.restore();
      await step("host_login_rejects_missing_protocol_headers_before_authentication", async () => {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "fixture-missing", password: "fixture-missing-password" }),
        });
        assert.equal(response.status, 426);
      });
      const recovered = await hosts.pair(JSON.stringify(offer));
      secretValues.push(recovered.username, recovered.password, recovered.sessionToken);
      assert.ok(store.authenticateSession(recovered.sessionToken));
      assert.equal(store.listMembers().length, committedMembers);
      assert.equal(networkPaths.filter((path) => path === PRIVATE_PAIRING_PATH).length, posted);
      mobileNow = Date.now();
    });
    await step("full_private_profile_rejects_new_host_without_network_or_write", async () => {
      const base = hosts.host(identity.serverId);
      capacityPersisted = JSON.stringify({
        deviceId: hosts.state().deviceId,
        hosts: Array.from({ length: MAX_PRIVATE_HOSTS }, (_, index) => ({
          ...base,
          hostId: index === 0 ? base.hostId : `capacity-fixture-host-${index}`,
        })),
      });
      const saved = capacityPersisted;
      await capacityHosts.restore();
      assert.equal(capacityHosts.state().hosts.length, MAX_PRIVATE_HOSTS);
      const offer = await Effect.runPromise(service.createPairing({ role: "member", label: "Capacity fixture" }));
      secretValues.push(offer.secret);
      const beforeNetwork = networkPaths.length;
      const beforeMembers = store.listMembers().length;
      await assert.rejects(
        capacityHosts.pair(JSON.stringify({ ...offer, hostId: "capacity-overflow-host" })),
        (error) => error instanceof PrivateMobileError && error.code === "pair",
      );
      assert.equal(networkPaths.length, beforeNetwork);
      assert.equal(capacityWrites, 0);
      assert.equal(capacityPersisted, saved);
      assert.equal(store.listMembers().length, beforeMembers);
      const reloaded = new PrivateHostStore(
        capacityStorage,
        network,
        () => undefined,
        () => mobileNow,
        mobileAppVersion,
      );
      await reloaded.restore();
      assert.equal(reloaded.state().hosts.length, MAX_PRIVATE_HOSTS);
    });
    await step("full_private_profile_repairs_existing_host_and_reloads_all_32", async () => {
      const beforeMember = capacityHosts.host(identity.serverId).member.id;
      // This exact member was created by the earlier recovery fixture in this new TeamStore.
      // Free its seat while retaining the released three-member limit and the current member.
      assert.ok(recoveryFixtureMemberId && recoveryFixtureMemberId !== beforeMember);
      await Effect.runPromise(service.revokeDevice(recoveryFixtureMemberId));
      const offer = await Effect.runPromise(service.createPairing({ role: "member", label: "Capacity repair" }));
      secretValues.push(offer.secret);
      const repaired = await capacityHosts.pair(JSON.stringify(offer));
      secretValues.push(repaired.username, repaired.password, repaired.sessionToken);
      assert.notEqual(repaired.member.id, beforeMember);
      assert.ok(store.authenticateSession(repaired.sessionToken));
      assert.equal(capacityHosts.state().hosts.length, MAX_PRIVATE_HOSTS);
      assert.equal(capacityHosts.state().hosts.filter((host) => host.hostId === identity.serverId).length, 1);
      const reloaded = new PrivateHostStore(
        capacityStorage,
        network,
        () => undefined,
        () => mobileNow,
        mobileAppVersion,
      );
      await reloaded.restore();
      assert.equal(reloaded.state().hosts.length, MAX_PRIVATE_HOSTS);
      assert.equal(reloaded.host(identity.serverId).member.id, repaired.member.id);
      await Effect.runPromise(service.revokeDevice(repaired.member.id));
    });
    await step("invalid_private_state_change_never_reaches_storage", async () => {
      const saved = capacityPersisted;
      const beforeWrites = capacityWrites;
      const beforeNetwork = networkPaths.length;
      const previous = capacityHosts.host(identity.serverId);
      await assert.rejects(
        capacityHosts.replace({ ...previous, hostName: "" }),
        (error) => error instanceof PrivateMobileError && error.code === "storage",
      );
      assert.equal(capacityPersisted, saved);
      assert.equal(capacityWrites, beforeWrites);
      assert.equal(networkPaths.length, beforeNetwork);
      assert.equal(capacityHosts.host(identity.serverId).hostName, previous.hostName);
    });
    await step("pairing_diagnostics_keep_fixed_stage_status_without_raw_failure", async () => {
      const sensitive = "fixture-cause-with-offer-and-credential-must-not-escape";
      const check = (stage: string, code: string) => (cause: unknown) => {
        assert.ok(cause instanceof PrivateMobileError);
        assert.equal(cause.code, code);
        assert.equal(privatePairingDiagnosticCode(cause), stage);
        assert.equal(JSON.stringify(cause).includes(sensitive), false);
        assert.equal(cause.message.includes(sensitive), false);
        assert.equal(Object.hasOwn(cause, "cause"), false);
        return true;
      };
      const host = hosts.host(identity.serverId);
      await assert.rejects(
        verifyPrivateHost(
          {
            ...network,
            fetch: async () => {
              throw new Error(sensitive);
            },
          },
          host,
        ),
        check("identity-request", "network"),
      );
      await assert.rejects(
        verifyPrivateHost({ ...network, fetch: async () => new Response(sensitive, { status: 503 }) }, host),
        check("identity-request/503", "identity"),
      );
      await assert.rejects(
        verifyPrivateHost({ ...network, fetch: async () => new Response(sensitive, { status: 200 }) }, host),
        check("identity-body/200", "pair"),
      );
    });
    await step("connect_auth_protocol_capabilities_and_runtime_snapshot", async () => {
      await transport.connect(identity.serverId, identity.publicKey);
      await until(() => events.includes("runtime-snapshot"));
      const scope = JSON.parse(frames[0] ?? "{}");
      assert.equal(scope.type, "agent-event-scope");
      assert.equal(scope.includeConversations, true);
      assert.ok(scope.capabilities.includes("long-capability-lists-v1"));
      for (const capability of upstream058Capabilities) assert.ok(scope.capabilities.includes(capability));
    });
    await step("diagnostic_replay_preserves_mobile_activity_and_released_status_projection", async () => {
      // Replay through the released codec and real transport; no provider or native UI runs here.
      const replay = async (event: AgentEvent | TeamRealtimeEvent) => {
        const frame = encodeTeamProtocolV8BaseCurrentEvent(event);
        assert.ok(frame, "The released codec must accept the fixture event.");
        assert.equal(sessions.size, 1);
        const count = receivedEvents.length;
        for (const peer of sessions.keys()) peer.send(frame);
        await until(() => receivedEvents.length > count);
        assert.equal(receivedEvents.length, count + 1);
        const received = receivedEvents[count];
        assert.ok(received);
        assert.equal(received.type, event.type);
        return received;
      };
      const assertProjectedStatus = (status: AgentStatus) => {
        const provider = status.providers?.find((row) => row.id === "codex");
        assert.ok(provider);
        assert.equal(provider.state, "available");
        assert.equal(provider.message, "Fixture provider message");
        assert.equal(provider.checkError, "Fixture sign-in check");
        assert.equal(Object.hasOwn(provider, "lastError"), false);
        assert.equal(Object.hasOwn(provider, "lastErrorAt"), false);
        assert.equal(JSON.stringify(status).includes(diagnosticMessage), false);
      };
      const status = await transport.request("GET", TEAM_API_ROUTES.agents.status, (value) => {
        assert.ok(isAgentStatus(value));
        return value;
      });
      assertProjectedStatus(status);
      const statusEvent = await replay({ type: "status", status: providerStatus });
      assert.equal(statusEvent.type, "status");
      if (statusEvent.type !== "status") throw new Error("The fixture must receive a status event.");
      assertProjectedStatus(statusEvent.status);
      const initial: MobileAgentActivities = {
        "fixture-agent": { turnId: "fixture-turn", phase: "working", detail: "Fixture work" },
      };
      assert.strictEqual(reduceAgentActivity(initial, statusEvent), initial);
      assert.equal(agentEventCanNotify(statusEvent), false);
      for (const agentId of [undefined, "fixture-agent"]) {
        const diagnostic = await replay({
          type: "error",
          ...(agentId ? { agentId } : {}),
          code: "codex_diagnostic",
          message: diagnosticMessage,
        });
        assert.equal(diagnostic.type, "error");
        if (diagnostic.type !== "error") throw new Error("The fixture must receive an error event.");
        assert.equal(diagnostic.code, "codex_diagnostic");
        assert.equal(diagnostic.message, diagnosticMessage);
        assert.equal(diagnostic.agentId, agentId);
        assert.strictEqual(reduceAgentActivity(initial, diagnostic), initial);
        assert.equal(agentEventCanNotify(diagnostic), false);
      }
      const failedTurn = await replay({
        type: "turn-completed",
        agentId: "fixture-agent",
        threadId: "fixture-thread",
        turnId: "fixture-turn",
        status: "failed",
      });
      assert.equal(agentEventCanNotify(failedTurn), true);
      assert.deepEqual(reduceAgentActivity(initial, failedTurn), {});
      const failedDelivery = await replay({
        type: "error",
        agentId: "fixture-agent",
        code: "delivery_start_failed",
        message: "Fixture delivery refused",
      });
      assert.equal(agentEventCanNotify(failedDelivery), true);
      assert.strictEqual(reduceAgentActivity(initial, failedDelivery), initial);
    });
    const message = {
      text: "Fixture message",
      clientMessageId: randomUUID(),
      attachmentDraftIds: [],
      replyToMessageId: null,
    };
    await step("message_preserves_client_id_without_automatic_retry", async () => {
      await transport.request("POST", TEAM_API_ROUTES.agent.messages("fixture-agent"), (value) => value, message);
      assert.ok(JSON.stringify(messages[0]).includes(message.clientMessageId));
      loseNextMessage = true;
      await assert.rejects(
        transport.request("POST", TEAM_API_ROUTES.agent.messages("fixture-agent"), (value) => value, message),
      );
      assert.equal(messages.length, 2);
    });
    await step("binary_file_round_trip_and_cancel", async () => {
      const upload = {
        name: "fixture.bin",
        mimeType: "application/octet-stream",
        base64: Buffer.from(file).toString("base64"),
      };
      await transport.request(
        "POST",
        `${TEAM_API_ROUTES.attachments}?name=fixture.bin&mime=application/octet-stream`,
        (value) => value,
        undefined,
        upload,
      );
      const downloaded = await transport.request("GET", TEAM_API_ROUTES.attachment("fixture-file"), (value) => value);
      assert.equal(
        JSON.stringify(downloaded),
        JSON.stringify({ name: upload.name, mimeType: upload.mimeType, base64: upload.base64 }),
      );
      const pending = transport.request(
        "POST",
        `${TEAM_API_ROUTES.attachments}?slow=1`,
        (value) => value,
        undefined,
        upload,
        undefined,
        "cancel-one",
      );
      const rejected = assert.rejects(pending);
      await until(() => uploadStarted.has("1"));
      transport.cancelUpload("cancel-one");
      await rejected;
    });
    await step("cancel_one_parallel_chat_upload_preserves_the_other", async () => {
      const upload = {
        name: "fixture.bin",
        mimeType: "application/octet-stream",
        base64: Buffer.from(file).toString("base64"),
      };
      const first = transport.request(
        "POST",
        `${TEAM_API_ROUTES.attachments}?slow=A`,
        (value) => value,
        undefined,
        upload,
        undefined,
        "chat-A-message",
      );
      const rejected = assert.rejects(first);
      let secondCompleted = false;
      const second = transport.request(
        "POST",
        `${TEAM_API_ROUTES.attachments}?slow=B`,
        (value) => value,
        undefined,
        upload,
        undefined,
        "chat-B-message",
      );
      const observedSecond = second.then((value) => {
        secondCompleted = true;
        return value;
      });
      await until(() => uploadStarted.has("A") && uploadStarted.has("B"));
      transport.cancelUpload("chat-A-message");
      await rejected;
      assert.equal(secondCompleted, false);
      const finish = finishUploads.get("B");
      assert.ok(finish);
      finish();
      assert.ok(JSON.stringify(await observedSecond).includes("draft-B"));
    });
    await step("released_utf8_file_names_and_malformed_fallback", async () => {
      for (const disposition of [
        `attachment; filename*=UTF-8''${encodeURIComponent("设计方案 v2.xlsx")}`,
        `attachment; filename*=UTF-8''${encodeURIComponent("results final.tar.gz")}`,
        "attachment; filename*=UTF-8''%E0%A4%A",
      ]) {
        const query = new URLSearchParams({ disposition });
        const downloaded = await transport.request(
          "GET",
          `${TEAM_API_ROUTES.attachment("fixture-file")}?${query}`,
          (value) => value,
        );
        assert.ok(
          JSON.stringify(downloaded).includes(JSON.stringify(contentDispositionFileName(disposition, "download"))),
        );
      }
    });
    await step("mobile_file_limit_rejects_upload_before_network_and_bounds_download", async () => {
      const before = networkPaths.length;
      const upload = {
        name: "too-large.bin",
        mimeType: "application/octet-stream",
        base64: Buffer.alloc(MOBILE_ATTACHMENT_BYTES + 1).toString("base64"),
      };
      const tooLarge = (error: unknown) =>
        error instanceof Error && error.message === sourceText("error.remote.attachmentTooLarge");
      await assert.rejects(
        transport.request("POST", TEAM_API_ROUTES.attachments, (value) => value, undefined, upload),
        tooLarge,
      );
      assert.equal(networkPaths.length, before);
      await assert.rejects(
        transport.request("GET", `${TEAM_API_ROUTES.attachment("fixture-file")}?oversized=1`, (value) => value),
        tooLarge,
      );
    });
    await step("import_and_transfer_route_binary_limits_preserve_attachment_limit", async () => {
      transferFile = Buffer.alloc(MOBILE_ATTACHMENT_BYTES + 1, 173);
      const upload = { name: "fixture.zip", mimeType: "application/zip", base64: transferFile.toString("base64") };
      const exportInput = { agentIds: ["fixture-agent"], includeFiles: true, includeSettings: true };
      try {
        for (const [path, token] of [
          [AGENT_IMPORT_ROUTES.stage, "fixture-import"],
          [INSTANCE_TRANSFER_ROUTES.stage, "fixture-transfer"],
        ] as const) {
          const progress: number[] = [];
          const preview = await transport.request(
            "POST",
            path,
            (value) => value,
            undefined,
            upload,
            (fraction) => progress.push(fraction),
          );
          assert.ok(JSON.stringify(preview).includes(token));
          assert.deepEqual(progress, [0, 1]);
        }
        const download = await transport.request(
          "POST",
          INSTANCE_TRANSFER_ROUTES.export,
          (value) => value,
          exportInput,
        );
        assert.deepEqual(download, { name: "主机导出.zip", mimeType: upload.mimeType, base64: upload.base64 });
        const ordinaryTooLarge = (error: unknown) =>
          error instanceof Error && error.message === sourceText("error.remote.attachmentTooLarge");
        const before = networkPaths.length;
        for (const [method, path] of [
          ["POST", TEAM_API_ROUTES.attachments],
          ["POST", `${AGENT_IMPORT_ROUTES.stage}/other`],
          ["PUT", INSTANCE_TRANSFER_ROUTES.stage],
        ] as const)
          await assert.rejects(
            transport.request(method, path, (value) => value, undefined, upload),
            ordinaryTooLarge,
          );
        assert.equal(networkPaths.length, before);
        // The length guard rejects these strings before base64 decoding or a network request.
        for (const [path, limit, message] of [
          [AGENT_IMPORT_ROUTES.stage, AGENT_IMPORT_UPLOAD_BYTES, sourceText("error.import.remoteZipTooLarge")],
          [
            INSTANCE_TRANSFER_ROUTES.stage,
            INSTANCE_TRANSFER_REMOTE_BYTES,
            sourceText("error.import.transferRemoteTooLarge"),
          ],
        ] as const)
          await assert.rejects(
            transport.request("POST", path, (value) => value, undefined, {
              ...upload,
              base64: "A".repeat(Math.ceil(limit / 3) * 4 + 4),
            }),
            (error) => error instanceof Error && error.message === message,
          );
        assert.equal(networkPaths.length, before);
        await assert.rejects(
          transport.request("POST", `${INSTANCE_TRANSFER_ROUTES.export}?oversized=1`, (value) => value, exportInput),
          (error) => error instanceof Error && error.message === sourceText("error.import.transferRemoteTooLarge"),
        );
      } finally {
        transferFile = null;
      }
    });
    await step("background_reopen_and_reconnect_snapshot", async () => {
      transport.setActive(false);
      const count = events.length;
      transport.setActive(true);
      await transport.connect(identity.serverId, identity.publicKey);
      await until(() => events.length > count);
      assert.equal(updates.at(-1), "online");
    });
    await step("redirect_and_wrong_identity_are_rejected", async () => {
      await assert.rejects(transport.request("GET", TEAM_API_ROUTES.sharedFiles, (value) => value));
      await assert.rejects(transport.connect(identity.serverId, "wrong-key"));
    });
    await step("failed_credential_save_keeps_previous_state", async () => {
      const before = hosts.state().hosts.length;
      failStorage = true;
      await assert.rejects(hosts.forget(identity.serverId));
      failStorage = false;
      assert.equal(hosts.state().hosts.length, before);
    });
    await step("revoked_member_cannot_reconnect_or_read", async () => {
      await transport.connect(identity.serverId, identity.publicKey);
      await Effect.runPromise(service.revokeDevice(hosts.host(identity.serverId).member.id));
      await until(() => updates.at(-1) === "offline");
      await assert.rejects(transport.request("GET", TEAM_API_ROUTES.attachment("fixture-file"), (value) => value));
    });
    report.passed = true;
  } finally {
    await transport.disconnect();
    await Effect.runPromise(service.shutdown());
    for (const socket of ws.clients) socket.terminate();
    ws.close();
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
}
try {
  await main();
} catch (error) {
  process.exitCode = 1;
  let message = error instanceof Error ? error.message : "Fixture failed";
  for (const secret of secretValues) message = message.replaceAll(secret, "[redacted]");
  process.stderr.write(`${JSON.stringify({ error: message.slice(0, 500) })}\n`);
} finally {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  assert.ok(secretValues.every((secret) => !text.includes(secret)));
  await mkdir(output, { recursive: true });
  const path = join(output, "report.json");
  await writeFile(path, text);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, report: path })}\n`);
}
