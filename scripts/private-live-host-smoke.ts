// Opt-in local smoke: portable mobile adapters -> real HTTPS/WSS Serve -> running Electron host.
// No model turn, owner bootstrap, token-file read, fixture server, or Android runtime is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type AgentSummary,
  isAgentSummary,
  isAttachmentSummary,
  isConversationSnapshot,
  isTeamPresenceSnapshot,
} from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { createOpenBotLogger } from "@openbot/logging";
import { PrivateHostPairingOfferSchema } from "@openbot/private-access/contracts";
import { Schema } from "effect";
import {
  PrivateMobileError,
  type PrivatePairedHost,
  privateOrigin,
} from "../apps/mobile/src/features/private-access/private-contracts";
import { PrivateHostStore } from "../apps/mobile/src/features/private-access/private-host-store";
import {
  PrivateHttpTransport,
  verifyPrivateHost,
} from "../apps/mobile/src/features/private-access/private-http-transport";
import type { PrivateNetworkPort } from "../apps/mobile/src/features/private-access/private-ports";
import {
  type AutomationSession,
  assertMutationAllowed,
  connectToDevApp,
  verifyBrowserOwnership,
} from "./dev-automation/cdp-client";
import { readDevInstanceRecords } from "./dev-automation/instance-registry";

const projectRoot = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
    instance: { type: "string" },
    origin: { type: "string" },
    "allow-mutations": { type: "boolean", default: false },
    "agent-id": { type: "string" },
    "fixture-path": { type: "string" },
    "fixture-sha256": { type: "string" },
    "fixture-bytes": { type: "string", default: "33" },
  },
  strict: true,
  allowPositionals: false,
});
assert.ok(
  values.instance && values.origin && values["fixture-path"] && values["fixture-sha256"],
  "Pass --instance, --origin, --fixture-path and --fixture-sha256.",
);
assertMutationAllowed({
  command: "private-live-host-smoke",
  allowMutations: values["allow-mutations"],
  instanceNamed: true,
  target: values.instance,
});
assert.equal(process.env.GITHUB_ACTIONS, undefined, "This script is for an explicit local host, not CI.");
const origin = privateOrigin(values.origin);
const fixturePath = values["fixture-path"];
assert.ok(!fixturePath.startsWith("/") && !fixturePath.includes("\\") && !fixturePath.includes(":"));
assert.ok(fixturePath.split("/").every((part) => part !== ".." && part !== ""));
const fixtureHash = values["fixture-sha256"].toLowerCase();
assert.match(fixtureHash, /^[a-f0-9]{64}$/u, "Pass a SHA256 hex digest.");
const fixtureBytes = Number(values["fixture-bytes"]);
assert.ok(Number.isSafeInteger(fixtureBytes) && fixtureBytes > 0 && fixtureBytes <= 10 * 1024 * 1024);
const runId = randomUUID();
const labels = [`Live smoke ${runId} A`, `Live smoke ${runId} B`];
const output = resolve(projectRoot, ".openbot-build/private-live-host-smoke", runId);
// The registry and all output contain local identifiers. Keep every output under an ignored path.
execFileSync("git", ["check-ignore", "--quiet", "--no-index", output], { cwd: projectRoot, stdio: "ignore" });
const report: {
  passed: boolean;
  scope: string;
  commit: string;
  dirtyWorktree: boolean;
  target: { instance: string; origin: string; agentId: string | null };
  steps: { name: string; passed: boolean }[];
  files: { kind: string; bytes: number; sha256: string }[];
  cleanup: { passed: boolean; remainingDevices: number; draftDiscarded: boolean };
  unverified: string[];
} = {
  passed: false,
  scope: "Node_portable_mobile_store_and_transport_over_real_Serve_to_running_Electron_host",
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(),
  dirtyWorktree:
    execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim().length > 0,
  target: { instance: values.instance, origin, agentId: null },
  steps: [],
  files: [],
  cleanup: { passed: false, remainingDevices: 0, draftDiscarded: true },
  unverified: [
    "Android native fetch, WebSocket, SecureStore, UI, background and physical phone Clash Mi coexistence.",
    "Model execution, message queue, cancellation, push and long-duration reconnect.",
    "This checks one explicit HTTPS origin; it does not audit Serve configuration or tailnet ACLs.",
    "Agent history is read only; no message, attachment record or user workspace file is changed.",
  ],
};
const logger = createOpenBotLogger("private-live-host-smoke", () => undefined);
const statusSchema = Schema.Struct({
  enabled: Schema.Boolean,
  phase: Schema.String,
  hostId: Schema.NullOr(Schema.String),
  publicOrigin: Schema.NullOr(Schema.String),
  devices: Schema.Array(Schema.Struct({ memberId: Schema.String, label: Schema.String, disabled: Schema.Boolean })),
});
const meSchema = Schema.Struct({ id: Schema.String, role: Schema.String });
const fileSchema = Schema.Struct({ name: Schema.String, mimeType: Schema.String, base64: Schema.String });
const ownedMembers = new Set<string>();
const transports: PrivateHttpTransport[] = [];
const sockets = new Set<WebSocket>();
let session: AutomationSession | null = null;
let initialMembers = new Set<string>();
let draftId: string | null = null;
let draftTransport: PrivateHttpTransport | null = null;
let mutationsStarted = false;

async function step<A>(name: string, action: () => Promise<A>): Promise<A> {
  try {
    const result = await action();
    report.steps.push({ name, passed: true });
    return result;
  } catch {
    report.steps.push({ name, passed: false });
    // Never copy upstream errors, offers, credentials, bodies, history or renderer logs.
    throw new Error(`The ${name} step failed.`);
  }
}

function boundary<A>(guard: (value: unknown) => value is A): (value: unknown) => A {
  return (value) => {
    assert.ok(guard(value), "The released response must decode.");
    return value;
  };
}

function empty(value: unknown): void {
  assert.equal(value, undefined, "Draft discard must return an empty response.");
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "The required connection state must arrive before its deadline.");
    await new Promise((done) => setTimeout(done, 20));
  }
}

function connectedSession(): AutomationSession {
  assert.ok(session, "The verified dev session must be connected.");
  return session;
}

async function status() {
  return Schema.decodeUnknownSync(statusSchema)(
    await connectedSession().page.evaluate("window.openbot.privateAccess.status()"),
  );
}

async function revoke(memberId: string): Promise<void> {
  assert.ok(ownedMembers.has(memberId) && !initialMembers.has(memberId));
  await connectedSession().page.evaluate(`window.openbot.privateAccess.revokeDevice(${JSON.stringify({ memberId })})`);
}

const network: PrivateNetworkPort = {
  fetch(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, origin, "All HTTP traffic must use the explicit HTTPS origin.");
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    assert.ok(
      method === "GET" ||
        (method === "POST" &&
          ["/private-access/v1/pair", "/v1/auth/login", TEAM_API_ROUTES.attachments].includes(url.pathname)) ||
        (method === "DELETE" && draftId !== null && url.pathname === TEAM_API_ROUTES.attachment(draftId)),
      "Only pairing, read requests and this run's attachment draft can use HTTP.",
    );
    return globalThis.fetch(input, { ...init, redirect: "error" });
  },
  socket(url, protocols) {
    const target = new URL(url);
    assert.equal(target.protocol, "wss:");
    target.protocol = "https:";
    assert.equal(target.origin, origin);
    assert.equal(target.pathname, TEAM_API_ROUTES.events);
    const socket = new globalThis.WebSocket(url, protocols);
    sockets.add(socket);
    return socket;
  },
  randomBytes(size) {
    return new Uint8Array(randomBytes(size));
  },
};

async function pair(label: string): Promise<PrivatePairedHost> {
  mutationsStarted = true;
  const offer = Schema.decodeUnknownSync(PrivateHostPairingOfferSchema)(
    await connectedSession().page.evaluate(
      `window.openbot.privateAccess.createPairing(${JSON.stringify({ role: "admin", label })})`,
    ),
  );
  assert.equal(offer.publicOrigin, origin);
  const before = await status();
  assert.equal(offer.hostId, before.hostId);
  let saved: string | null = null;
  const store = new PrivateHostStore(
    {
      async read() {
        return saved;
      },
      async write(value) {
        saved = value;
      },
    },
    network,
    () => undefined,
    Date.now,
    "private-live-smoke",
  );
  await store.restore();
  const host = await store.pair(JSON.stringify(offer));
  assert.ok(!initialMembers.has(host.member.id));
  assert.equal(host.member.role, "admin");
  const created = (await status()).devices.find((device) => device.memberId === host.member.id);
  assert.ok(created && created.label === label && !created.disabled);
  ownedMembers.add(host.member.id);
  return host;
}

function transport(host: PrivatePairedHost) {
  const state = { snapshots: 0, online: false };
  const client = new PrivateHttpTransport(
    network,
    () => host,
    {
      connection(update) {
        state.online = update.state === "online";
      },
      event(hostId, event) {
        assert.equal(hostId, host.hostId);
        if (event.type === "runtime-snapshot") state.snapshots += 1;
      },
    },
    "private-live-smoke",
  );
  transports.push(client);
  return { client, state };
}

function fileHash(kind: string, file: { base64: string }, expectedHash: string, expectedBytes: number) {
  const bytes = Buffer.from(file.base64, "base64");
  assert.equal(bytes.byteLength, expectedBytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256, expectedHash);
  report.files.push({ kind, bytes: bytes.byteLength, sha256 });
}

async function main(): Promise<void> {
  await mkdir(output, { recursive: true });
  try {
    await step("verify_worktree_registry_and_owned_Electron_CDP", async () => {
      const matches = readDevInstanceRecords().filter(
        (item) => item.service === "app" && item.instanceId === values.instance,
      );
      assert.equal(matches.length, 1, "The explicit running instance must be unique.");
      const instance = matches[0];
      assert.ok(instance);
      const canonical = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
      assert.equal(canonical(instance.projectRoot), canonical(projectRoot));
      session = await connectToDevApp(instance.remoteDebuggingPort, logger, {
        expectedRendererPort: instance.rendererPort,
        ownerPid: instance.pid,
      });
      assert.ok(
        await verifyBrowserOwnership(session.browser, instance.pid),
        "CDP must belong to the recorded process.",
      );
      const app = Schema.decodeUnknownSync(Schema.Struct({ privateBuild: Schema.Boolean }))(
        await connectedSession().page.evaluate("window.openbot.getAppInfo()"),
      );
      assert.equal(app.privateBuild, true, "The selected app must be a private build.");
      const before = await status();
      assert.ok(before.enabled && before.phase === "ready" && before.hostId);
      assert.equal(before.publicOrigin, origin);
      initialMembers = new Set(before.devices.map((device) => device.memberId));
    });
    const hostA = await step("pair_device_A_through_real_HTTPS", () => pair(labels[0] ?? ""));
    const hostB = await step("pair_device_B_through_real_HTTPS", () => pair(labels[1] ?? ""));
    await step("distinct_devices_and_pinned_identity", async () => {
      assert.notEqual(hostA.member.id, hostB.member.id);
      assert.notEqual(hostA.username, hostB.username);
      assert.notEqual(hostA.sessionToken, hostB.sessionToken);
      assert.equal(hostA.hostPublicKey, hostB.hostPublicKey);
      await verifyPrivateHost(network, hostA, "private-live-smoke");
      await verifyPrivateHost(network, hostB, "private-live-smoke");
    });
    const a = transport(hostA);
    const b = transport(hostB);
    await step("real_WSS_runtime_snapshots_for_both_devices", async () => {
      await a.client.connect(hostA.hostId, hostA.hostPublicKey);
      await b.client.connect(hostB.hostId, hostB.hostPublicKey);
      await until(() => a.state.snapshots > 0 && b.state.snapshots > 0 && a.state.online && b.state.online);
    });
    await step("real_HTTP_me_and_presence", async () => {
      for (const { host, client } of [
        { host: hostA, client: a.client },
        { host: hostB, client: b.client },
      ]) {
        const me = await client.request("GET", TEAM_API_ROUTES.me, Schema.decodeUnknownSync(meSchema));
        assert.equal(me.id, host.member.id);
        assert.equal(me.role, "admin");
      }
      const presence = await b.client.request("GET", TEAM_API_ROUTES.team.presence, boundary(isTeamPresenceSnapshot));
      assert.equal(presence.serverId, hostB.hostId);
      assert.ok(presence.members.some((member) => member.id === hostA.member.id));
      assert.ok(presence.members.some((member) => member.id === hostB.member.id));
    });
    const agentId = await step("read_existing_agent_history_without_starting_a_turn", async () => {
      const agents = await b.client.request(
        "GET",
        TEAM_API_ROUTES.agents.all,
        boundary((value): value is AgentSummary[] => Array.isArray(value) && value.every(isAgentSummary)),
      );
      const agent = values["agent-id"]
        ? agents.find((item) => item.id === values["agent-id"])
        : agents.length === 1
          ? agents[0]
          : undefined;
      assert.ok(agent, "Name an existing agent with --agent-id when the list is not unique.");
      const history = await b.client.request(
        "GET",
        TEAM_API_ROUTES.agent.conversation(agent.id),
        boundary(isConversationSnapshot),
      );
      assert.equal(history.agentId, agent.id);
      assert.ok(history.messages.length > 0, "The selected existing agent must have history.");
      return agent.id;
    });
    report.target.agentId = agentId;
    await step("download_existing_workspace_file_and_verify_supplied_hash", async () => {
      const query = new URLSearchParams({ botId: agentId, path: fixturePath });
      const file = await b.client.request(
        "GET",
        `${TEAM_API_ROUTES.workspaceFiles}?${query}`,
        Schema.decodeUnknownSync(fileSchema),
      );
      assert.equal(file.name, basename(fixturePath));
      fileHash("existing_workspace_file", file, fixtureHash, fixtureBytes);
    });
    await step("upload_Chinese_named_draft_and_verify_download_hash", async () => {
      const name = `私有链路验收-${runId}.txt`;
      const bytes = Buffer.from("私有连接文件校验\n", "utf8");
      const query = new URLSearchParams({ name, mime: "text/plain" });
      // An interrupted POST can commit a draft without returning its ID. Never claim cleanup
      // succeeded in that case, and never search for or discard another user's drafts.
      report.cleanup.draftDiscarded = false;
      const draft = await b.client.request(
        "POST",
        `${TEAM_API_ROUTES.attachments}?${query}`,
        boundary(isAttachmentSummary),
        undefined,
        { name, mimeType: "text/plain", base64: bytes.toString("base64") },
        undefined,
        runId,
      );
      draftId = draft.id;
      draftTransport = b.client;
      assert.equal(draft.name, name);
      assert.equal(draft.size, bytes.byteLength);
      const file = await b.client.request(
        "GET",
        TEAM_API_ROUTES.attachment(draftId),
        Schema.decodeUnknownSync(fileSchema),
      );
      // The real mailbox stores a draft as <draft-id>/<sanitized-name>. This name needs no
      // sanitization, so the released UTF-8 Content-Disposition must decode to the full name.
      assert.equal(file.name, name);
      fileHash("own_Chinese_named_draft", file, createHash("sha256").update(bytes).digest("hex"), bytes.byteLength);
      await b.client.request("DELETE", TEAM_API_ROUTES.attachment(draftId), empty);
      draftId = null;
      report.cleanup.draftDiscarded = true;
    });
    await step("foreground_reconnect_receives_a_new_real_snapshot", async () => {
      const previous = b.state.snapshots;
      b.client.setActive(false);
      b.client.setActive(true);
      await b.client.connect(hostB.hostId, hostB.hostPublicKey);
      await until(() => b.state.snapshots > previous && b.state.online);
    });
    await step("revoke_A_closes_its_socket_and_preserves_B", async () => {
      await revoke(hostA.member.id);
      await until(() => !a.state.online);
      await assert.rejects(
        () => a.client.request("GET", TEAM_API_ROUTES.me, Schema.decodeUnknownSync(meSchema)),
        (error: unknown) => error instanceof PrivateMobileError && error.code === "session",
      );
      const me = await b.client.request("GET", TEAM_API_ROUTES.me, Schema.decodeUnknownSync(meSchema));
      assert.equal(me.id, hostB.member.id);
      const previous = b.state.snapshots;
      await b.client.connect(hostB.hostId, hostB.hostPublicKey);
      await until(() => b.state.snapshots > previous && b.state.online);
    });
    report.passed = true;
  } finally {
    let cleanupFailed = !report.cleanup.draftDiscarded;
    try {
      if (draftId && draftTransport) {
        await draftTransport.request("DELETE", TEAM_API_ROUTES.attachment(draftId), empty);
        draftId = null;
        report.cleanup.draftDiscarded = true;
        cleanupFailed = false;
      }
    } catch {
      cleanupFailed = true;
    }
    if (session && mutationsStarted) {
      let current: Awaited<ReturnType<typeof status>> | null = null;
      try {
        // A lost pair response can still create a member. Recover only this run's exact labels.
        current = await status();
        for (const device of current.devices) {
          if (!initialMembers.has(device.memberId) && labels.includes(device.label)) ownedMembers.add(device.memberId);
        }
      } catch {
        cleanupFailed = true;
      }
      for (const memberId of ownedMembers) {
        if (current && !current.devices.some((device) => device.memberId === memberId && !device.disabled)) continue;
        try {
          await revoke(memberId);
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        const after = await status();
        report.cleanup.remainingDevices = after.devices.filter(
          (device) => ownedMembers.has(device.memberId) && !device.disabled,
        ).length;
        assert.equal(report.cleanup.remainingDevices, 0);
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      report.cleanup.passed = !cleanupFailed;
      if (cleanupFailed) report.passed = false;
      for (const client of transports) await client.disconnect().catch(() => undefined);
      for (const socket of sockets) socket.close();
    } finally {
      await session?.close().catch(() => undefined);
      await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
  }
}

main().then(
  () => {
    if (!report.passed) {
      process.stderr.write("Live host smoke cleanup failed. Review the local report and this run's device labels.\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      "Live host smoke passed. Local report: .openbot-build/private-live-host-smoke/<run>/report.json\n",
    );
  },
  () => {
    process.stderr.write("Live host smoke failed. Review the local report. No upstream error or body is printed.\n");
    process.exitCode = 1;
  },
);
