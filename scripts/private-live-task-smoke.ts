// Explicit local opt-in: one run-owned device -> real HTTPS/WSS -> an existing Codex agent.
// No provider credential is read. Model messages/files stay for review; cleanup revokes only this device.
// Pass --instance=... --origin=https://... --agent-id=... --allow-mutations --run-codex-task.
// --case=receipt-file is the default. --case=queue-cancel separately asks Codex for a blocking question.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type AgentRuntimeSnapshot,
  type AgentSummary,
  type ConversationSnapshot,
  isAgentSummary,
  isConversationSnapshot,
  isQueuedMessageReceipt,
  isQueueSnapshot,
  type QueueDelivery,
  type QueuedMessageReceipt,
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
import { type DevInstanceRecord, readDevInstanceRecords } from "./dev-automation/instance-registry";
import { resolveDevelopmentAppDataRoot } from "./development-state-paths";

const projectRoot = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
  strict: true,
  allowPositionals: false,
  options: {
    instance: { type: "string" },
    origin: { type: "string" },
    "agent-id": { type: "string" },
    "allow-mutations": { type: "boolean", default: false },
    "run-codex-task": { type: "boolean", default: false },
    case: { type: "string", default: "receipt-file" },
  },
});
assert.ok(values.instance && values.origin && values["agent-id"], "Pass --instance, --origin and --agent-id.");
assertMutationAllowed({
  command: "private-live-task-smoke",
  allowMutations: values["allow-mutations"],
  instanceNamed: true,
  target: values.instance,
});
assert.equal(values["run-codex-task"], true, "A model request requires the explicit --run-codex-task flag.");
assert.equal(process.env.GITHUB_ACTIONS, undefined, "Only an explicitly named local test host is supported.");
assert.ok(
  values.case === "receipt-file" || values.case === "queue-cancel",
  "Choose --case=receipt-file or --case=queue-cancel.",
);
const testCase = values.case;
const origin = privateOrigin(values.origin);
const agentId = values["agent-id"];
const runId = randomUUID();
const deviceLabel = `Task smoke ${testCase} ${runId}`;
const relativeDirectory = `private-task-smoke-${runId}`;
const outputFile = `${relativeDirectory}/result.txt`;
const expectedContent = `OPENBOT_PRIVATE_TASK_${runId}`;
const expectedHash = createHash("sha256").update(expectedContent).digest("hex");
const output = resolve(projectRoot, ".openbot-build/private-live-task-smoke", runId);
execFileSync("git", ["check-ignore", "--quiet", "--no-index", output], { cwd: projectRoot, stdio: "ignore" });
const report: {
  passed: boolean;
  scope: string;
  case: string;
  runId: string;
  sourceCommit: string;
  dirtyWorktree: boolean;
  target: { instance: string; origin: string; agentId: string; ownerPid: number | null };
  steps: { name: string; passed: boolean; errorCode?: string }[];
  receipts: {
    clientMessageId: string;
    messageId: string;
    deliveryId: string;
    initialStatus: string;
    retryStatus?: string;
  }[];
  evidence: {
    kind: string;
    turnId?: string;
    status?: string;
    count?: number;
    bytes?: number;
    sha256?: string;
    relativePath?: string;
  }[];
  cleanup: {
    passed: boolean;
    remainingRunDevices: number;
    unresolvedPairing: boolean;
    messagesRetained: true;
    filesRetained: true;
  };
  unverified: string[];
} = {
  passed: false,
  scope: "opt_in_existing_Codex_agent_over_real_private_HTTPS_WSS_frozen_mobile_codec",
  case: testCase,
  runId,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(),
  dirtyWorktree:
    execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim().length > 0,
  target: { instance: values.instance, origin, agentId, ownerPid: null },
  steps: [],
  receipts: [],
  evidence: [],
  cleanup: {
    passed: false,
    remainingRunDevices: 0,
    unresolvedPairing: false,
    messagesRetained: true,
    filesRetained: true,
  },
  unverified: [
    "Android native runtime, UI, Clash Mi, background recovery and physical devices.",
    "The source commit is this script's checkout; it is not a build attestation for the already running app.",
    "One visible message/delivery/file is checked. This does not count internal filesystem write syscalls or all provider operations.",
    "The duplicate request is deliberate; no lost HTTP response or network partition is injected.",
    testCase === "receipt-file"
      ? "Queue cancellation and current-turn interruption require the separate queue-cancel case."
      : "File-output idempotency requires the separate receipt-file case.",
    "No user history, messages, files or provider configuration is deleted. A failed run can leave its own unfinished task for manual review.",
  ],
};
const logger = createOpenBotLogger("private-live-task-smoke", () => undefined);
const statusSchema = Schema.Struct({
  enabled: Schema.Boolean,
  phase: Schema.String,
  hostId: Schema.NullOr(Schema.String),
  publicOrigin: Schema.NullOr(Schema.String),
  devices: Schema.Array(Schema.Struct({ memberId: Schema.String, label: Schema.String, disabled: Schema.Boolean })),
});
const fileSchema = Schema.Struct({ name: Schema.String, mimeType: Schema.String, base64: Schema.String });
const bodySchema = Schema.Struct({ clientMessageId: Schema.String, text: Schema.String });
const ownedMembers = new Set<string>();
const ownedDeliveries = new Set<string>();
const ownedTurns = new Set<string>();
const allowedMessages = new Map<string, string>();
const startedTurns = new Set<string>();
const completedTurns = new Map<string, string>();
const promptTurns = new Set<string>();
const sockets = new Set<WebSocket>();
let session: AutomationSession | null = null;
let instance: DevInstanceRecord | null = null;
let initialMembers = new Set<string>();
let client: PrivateHttpTransport | null = null;
let pairedHost: PrivatePairedHost | null = null;
let runtime: AgentRuntimeSnapshot | null = null;
let mutationsStarted = false;
let pairingRequested = false;
let runDirectory: string | null = null;
let online = false;
let eventRevision = 0;
const listeners = new Set<() => void>();

function boundary<A>(guard: (value: unknown) => value is A): (value: unknown) => A {
  return (value) => {
    assert.ok(guard(value), "The released response must decode.");
    return value;
  };
}
function empty(value: unknown): void {
  assert.equal(value, undefined);
}
function connected(): AutomationSession {
  assert.ok(session);
  return session;
}
function transport(): PrivateHttpTransport {
  assert.ok(client);
  return client;
}
function host(): PrivatePairedHost {
  assert.ok(pairedHost);
  return pairedHost;
}
const canonical = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
async function ipc<A>(expression: string, schema: Schema.Decoder<A>): Promise<A> {
  return Schema.decodeUnknownSync(schema)(await connected().page.evaluate(expression));
}
const status = () => ipc("window.openbot.privateAccess.status()", statusSchema);

async function verifyOwner(): Promise<void> {
  const owner = instance;
  assert.ok(owner);
  const records = readDevInstanceRecords().filter(
    (record) => record.service === "app" && record.instanceId === values.instance,
  );
  assert.equal(records.length, 1);
  assert.ok(
    records.some(
      (record) =>
        record.pid === owner.pid &&
        record.startedAt === owner.startedAt &&
        record.remoteDebuggingPort === owner.remoteDebuggingPort,
    ),
  );
  assert.ok(
    await verifyBrowserOwnership(connected().browser, owner.pid),
    "The exact registry owner must still own CDP.",
  );
}

function pulse(): void {
  eventRevision += 1;
  for (const wake of [...listeners]) wake();
}
async function proof<A>(probe: () => Promise<A | null>): Promise<A> {
  const deadline = Date.now() + 240_000;
  for (;;) {
    const revision = eventRevision;
    const result = await probe();
    if (result !== null) return result;
    assert.ok(Date.now() < deadline, "The required receipt/event/state proof did not arrive before its deadline.");
    if (eventRevision !== revision) continue;
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(wake);
        reject(new Error("The required event did not arrive."));
      }, deadline - Date.now());
      function wake() {
        clearTimeout(timer);
        listeners.delete(wake);
        done();
      }
      listeners.add(wake);
      if (eventRevision !== revision) wake();
    });
  }
}
async function step<A>(name: string, action: () => Promise<A>): Promise<A> {
  try {
    const result = await action();
    report.steps.push({ name, passed: true });
    return result;
  } catch (error) {
    const errorCode =
      error instanceof PrivateMobileError
        ? `private_${error.code}`
        : error instanceof Error && error.name === "AssertionError"
          ? "guard_assertion"
          : "operation_failed";
    report.steps.push({ name, passed: false, errorCode });
    throw new Error(`The ${name} step failed.`);
  }
}

const network: PrivateNetworkPort = {
  async fetch(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, origin);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "GET") {
      assert.ok(
        [
          TEAM_API_ROUTES.identity,
          TEAM_API_ROUTES.compatibility,
          TEAM_API_ROUTES.me,
          TEAM_API_ROUTES.agents.all,
          TEAM_API_ROUTES.agent.queue(agentId),
          TEAM_API_ROUTES.agent.conversation(agentId),
          TEAM_API_ROUTES.workspaceFiles,
        ].includes(url.pathname),
        "Only this case's read routes are allowed.",
      );
      if (url.pathname === TEAM_API_ROUTES.workspaceFiles) {
        assert.equal(url.searchParams.get("botId"), agentId);
        assert.equal(url.searchParams.get("path"), outputFile);
      }
    } else {
      assert.equal(method, "POST");
      await verifyOwner();
      if (url.pathname === TEAM_API_ROUTES.agent.messages(agentId)) {
        assert.equal(values["run-codex-task"], true);
        assert.equal(typeof init?.body, "string");
        const body = Schema.decodeUnknownSync(bodySchema)(JSON.parse(String(init?.body)));
        assert.equal(
          allowedMessages.get(body.clientMessageId),
          body.text,
          "Only this run's exact bounded prompt may be submitted.",
        );
      } else if (url.pathname === TEAM_API_ROUTES.agent.queueCancel(agentId)) {
        const body = Schema.decodeUnknownSync(Schema.Struct({ deliveryId: Schema.String }))(
          JSON.parse(String(init?.body)),
        );
        assert.ok(testCase === "queue-cancel" && ownedDeliveries.has(body.deliveryId));
      } else if (url.pathname === TEAM_API_ROUTES.agent.interrupt(agentId)) {
        const body = Schema.decodeUnknownSync(Schema.Struct({ turnId: Schema.String }))(JSON.parse(String(init?.body)));
        assert.ok(testCase === "queue-cancel" && ownedTurns.has(body.turnId));
      } else {
        assert.ok(["/private-access/v1/pair", "/v1/auth/login"].includes(url.pathname));
        if (url.pathname === "/private-access/v1/pair") pairingRequested = true;
      }
    }
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

const queue = () => transport().request("GET", TEAM_API_ROUTES.agent.queue(agentId), boundary(isQueueSnapshot));
const conversation = () =>
  transport().request("GET", TEAM_API_ROUTES.agent.conversation(agentId), boundary(isConversationSnapshot));
function ownDelivery(snapshot: Awaited<ReturnType<typeof queue>>, receipt: QueuedMessageReceipt): QueueDelivery {
  assert.equal(snapshot.agentId, agentId);
  const deliveryId = receipt.deliveries[0]?.id;
  const matches = snapshot.deliveries.filter(
    (delivery) =>
      delivery.id === deliveryId && delivery.messageId === receipt.messageId && delivery.recipientAgentId === agentId,
  );
  assert.equal(matches.length, 1, "The receipt must have exactly one matching delivery.");
  const delivery = matches[0];
  assert.ok(delivery);
  return delivery;
}

async function send(text: string, clientMessageId: string): Promise<QueuedMessageReceipt> {
  allowedMessages.set(clientMessageId, text);
  const receipt = await transport().request(
    "POST",
    TEAM_API_ROUTES.agent.messages(agentId),
    boundary(isQueuedMessageReceipt),
    {
      text,
      clientMessageId,
      attachmentDraftIds: [],
      replyToMessageId: null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  );
  assert.equal(receipt.deliveries.length, 1);
  const delivery = receipt.deliveries[0];
  assert.ok(delivery && delivery.recipientAgentId === agentId);
  ownedDeliveries.add(delivery.id);
  return receipt;
}
function recordReceipt(clientMessageId: string, receipt: QueuedMessageReceipt, retry?: QueuedMessageReceipt): void {
  const delivery = receipt.deliveries[0];
  assert.ok(delivery);
  if (retry) {
    assert.equal(retry.messageId, receipt.messageId);
    assert.deepEqual(
      retry.deliveries.map((item) => ({ id: item.id, recipientAgentId: item.recipientAgentId })),
      receipt.deliveries.map((item) => ({ id: item.id, recipientAgentId: item.recipientAgentId })),
    );
  }
  report.receipts.push({
    clientMessageId,
    messageId: receipt.messageId,
    deliveryId: delivery.id,
    initialStatus: delivery.status,
    ...(retry ? { retryStatus: retry.deliveries[0]?.status ?? "unknown" } : {}),
  });
}

async function receiptFileCase(): Promise<void> {
  const prompt = `Private transport acceptance run ${runId}. Work only in your own workspace. Create exactly one UTF-8 file at relative path ${JSON.stringify(outputFile)} with exactly these ASCII bytes, no BOM and no trailing newline: ${expectedContent}. Do not read or change any other file, use the network, access a Vault, delegate, or change settings. Do only this small file task, then reply with the marker. The run directory already exists.`;
  const clientMessageId = randomUUID();
  const receipt = await step("duplicate_client_message_id_returns_same_receipt_identity", async () => {
    const first = await send(prompt, clientMessageId);
    const retried = await send(prompt, clientMessageId);
    recordReceipt(clientMessageId, first, retried);
    return first;
  });
  const completed = await step("receipt_linked_delivery_and_WSS_turn_complete", () =>
    proof(async () => {
      const delivery = ownDelivery(await queue(), receipt);
      assert.ok(
        !["failed", "cancelled", "interrupted"].includes(delivery.status),
        "The run's delivery did not complete normally.",
      );
      if (delivery.status !== "completed" || !delivery.turnId) return null;
      if (!startedTurns.has(delivery.turnId) || completedTurns.get(delivery.turnId) !== "completed") return null;
      return delivery;
    }),
  );
  report.evidence.push({
    kind: "completed-delivery-and-events",
    turnId: completed.turnId ?? undefined,
    status: completed.status,
    count: 1,
  });
  await step("one_run_message_and_one_delivery_remain_after_retry", async () => {
    const history = await conversation();
    const own = history.messages.filter((message) => message.author === "user" && message.text === prompt);
    assert.equal(own.length, 1);
    // The conversation projects a user message under its delivery ID, not the mailbox message ID.
    assert.equal(own[0]?.id, receipt.deliveries[0]?.id);
    assert.equal(own[0]?.delivery?.id, receipt.deliveries[0]?.id);
    assert.equal(own[0]?.senderMember?.id, host().member.id);
    assert.equal((await queue()).deliveries.filter((delivery) => delivery.messageId === receipt.messageId).length, 1);
    report.evidence.push({ kind: "own-user-message", count: own.length });
  });
  await step("one_UUID_scoped_output_matches_local_and_real_HTTP_hash", async () => {
    assert.ok(runDirectory);
    const entries = await readdir(runDirectory, { withFileTypes: true });
    assert.equal(entries.length, 1);
    assert.ok(entries[0]?.isFile() && entries[0].name === "result.txt");
    const path = join(runDirectory, "result.txt");
    const stat = await lstat(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(canonical(await realpath(path)), canonical(path));
    const bytes = await readFile(path);
    assert.equal(bytes.toString("utf8"), expectedContent);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash);
    const query = new URLSearchParams({ botId: agentId, path: outputFile });
    const downloaded = await transport().request(
      "GET",
      `${TEAM_API_ROUTES.workspaceFiles}?${query}`,
      Schema.decodeUnknownSync(fileSchema),
    );
    assert.equal(downloaded.name, "result.txt");
    const httpBytes = Buffer.from(downloaded.base64, "base64");
    assert.deepEqual(httpBytes, bytes);
    report.evidence.push({
      kind: "output-file",
      count: 1,
      bytes: bytes.byteLength,
      sha256: expectedHash,
      relativePath: outputFile,
    });
  });
}

async function pendingGate(turnId: string): Promise<boolean> {
  await verifyOwner();
  // Return only booleans: no prompt text, prior history or provider state leaves the renderer.
  const gate = await ipc(
    `(async () => {
    const state = await window.openbot.agent.getRuntimeSnapshot("local");
    if (!state) return { available: false, active: false, pending: false };
    const agentId = ${JSON.stringify(agentId)};
    const turnId = ${JSON.stringify(turnId)};
    const marker = ${JSON.stringify(runId)};
    return {
      available: true,
      active: state.activeTurns.some(turn => turn.agentId === agentId && turn.turnId === turnId),
      pending: state.pendingPrompts.some(prompt => prompt.agentId === agentId && prompt.turnId === turnId &&
        prompt.questions.some(question => question.question.includes(marker) || question.header.includes(marker))),
    };
  })()`,
    Schema.Struct({ available: Schema.Boolean, active: Schema.Boolean, pending: Schema.Boolean }),
  );
  assert.equal(gate.available, true, "The current local runtime must be readable.");
  return gate.active && gate.pending;
}

async function queueCancelCase(): Promise<void> {
  const gatePrompt = `Private queue acceptance run ${runId}. Do not write files, run commands, use the network, access a Vault, delegate or change settings. Use openbot.ask_user once to ask exactly one yes/no question containing ${runId}, then wait for the answer. This is an intentional pending-question gate for a cancellation test; do not answer it yourself. If the tool is unavailable, report that and do nothing else.`;
  const gateMessageId = randomUUID();
  const gate = await step("submit_one_bounded_question_gate", async () => {
    const receipt = await send(gatePrompt, gateMessageId);
    recordReceipt(gateMessageId, receipt);
    return receipt;
  });
  const running = await step("observe_own_running_turn_and_real_pending_prompt", () =>
    proof(async () => {
      const delivery = ownDelivery(await queue(), gate);
      assert.ok(
        !["completed", "failed", "interrupted", "cancelled"].includes(delivery.status),
        "The pending-question gate was not established.",
      );
      if (!delivery.turnId || !startedTurns.has(delivery.turnId)) return null;
      const current = await conversation();
      if (current.activeTurnId !== delivery.turnId || !promptTurns.has(delivery.turnId)) return null;
      if (!(await pendingGate(delivery.turnId))) return null;
      ownedTurns.add(delivery.turnId);
      return delivery;
    }),
  );
  const runningTurnId = running.turnId;
  assert.ok(runningTurnId);
  report.evidence.push({ kind: "pending-question-gate", turnId: runningTurnId, status: running.status });
  const queuedId = randomUUID();
  const queued = await step("queue_second_owned_message_behind_observed_gate", async () => {
    assert.ok(await pendingGate(runningTurnId), "The exact run-marked prompt must still be pending before enqueue.");
    const receipt = await send(
      `Private queue acceptance run ${runId}, queued marker. If this message ever executes, write only ${JSON.stringify(`${relativeDirectory}/unexpected.txt`)} with text ${runId}; do nothing else. This message is expected to be cancelled before it executes.`,
      queuedId,
    );
    recordReceipt(queuedId, receipt);
    return receipt;
  });
  const queuedDelivery = await step("observe_second_delivery_queued_without_a_turn", () =>
    proof(async () => {
      const delivery = ownDelivery(await queue(), queued);
      assert.ok(!["running", "completed", "failed", "interrupted", "cancelled"].includes(delivery.status));
      if (delivery.status !== "queued") return null;
      assert.equal(delivery.turnId, null);
      const first = ownDelivery(await queue(), gate);
      assert.equal(first.turnId, runningTurnId);
      assert.ok(["running", "starting"].includes(first.status));
      return delivery;
    }),
  );
  await step("cancel_only_own_queued_delivery_and_observe_cancelled_status", async () => {
    await transport().request("POST", TEAM_API_ROUTES.agent.queueCancel(agentId), empty, {
      deliveryId: queuedDelivery.id,
    });
    await proof(async () => {
      const delivery = ownDelivery(await queue(), queued);
      if (delivery.status !== "cancelled") return null;
      assert.equal(delivery.turnId, null);
      return delivery;
    });
    report.evidence.push({ kind: "queued-delivery-cancelled", status: "cancelled", count: 1 });
  });
  await step("interrupt_only_the_owned_gated_turn_and_observe_end", async () => {
    const current = await conversation();
    assert.equal(current.activeTurnId, runningTurnId);
    await transport().request("POST", TEAM_API_ROUTES.agent.interrupt(agentId), empty, { turnId: runningTurnId });
    await proof(async () => {
      const delivery = ownDelivery(await queue(), gate);
      if (delivery.status !== "interrupted" || completedTurns.get(runningTurnId) !== "interrupted") return null;
      const history = await conversation();
      if (history.activeTurnId === runningTurnId) return null;
      // A cached WSS snapshot can still describe the old turn. Read the real local runtime again.
      const freshRuntime = await ipc(
        '(async () => { const state = await window.openbot.agent.getRuntimeSnapshot("local"); return state ? { activeTurns: state.activeTurns } : null; })()',
        Schema.Struct({
          activeTurns: Schema.Array(Schema.Struct({ agentId: Schema.String, turnId: Schema.String })),
        }),
      );
      if (freshRuntime.activeTurns.some((turn) => turn.agentId === agentId && turn.turnId === runningTurnId))
        return null;
      return delivery;
    });
    const second = ownDelivery(await queue(), queued);
    assert.equal(second.status, "cancelled");
    assert.equal(second.turnId, null);
    assert.ok(runDirectory);
    assert.equal((await readdir(runDirectory)).length, 0);
    report.evidence.push(
      { kind: "gated-turn-interrupted", turnId: runningTurnId, status: "interrupted" },
      { kind: "queued-task-output-files", count: 0 },
    );
  });
}

async function main(): Promise<void> {
  await mkdir(output, { recursive: true });
  try {
    await step("verify_exact_registry_process_CDP_and_private_origin", async () => {
      const records = readDevInstanceRecords().filter(
        (record) => record.service === "app" && record.instanceId === values.instance,
      );
      assert.equal(records.length, 1);
      instance = records[0] ?? null;
      assert.ok(instance);
      assert.equal(canonical(await realpath(instance.projectRoot)), canonical(await realpath(projectRoot)));
      session = await connectToDevApp(instance.remoteDebuggingPort, logger, {
        expectedRendererPort: instance.rendererPort,
        ownerPid: instance.pid,
      });
      await verifyOwner();
      report.target.ownerPid = instance.pid;
      const info = await ipc("window.openbot.getAppInfo()", Schema.Struct({ privateBuild: Schema.Boolean }));
      assert.equal(info.privateBuild, true);
      const before = await status();
      assert.ok(before.enabled && before.phase === "ready" && before.hostId);
      assert.equal(before.publicOrigin, origin);
      initialMembers = new Set(before.devices.map((device) => device.memberId));
    });
    const offer = await step("create_run_only_offer_from_verified_main", async () => {
      await verifyOwner();
      mutationsStarted = true;
      const offer = await ipc(
        `window.openbot.privateAccess.createPairing(${JSON.stringify({ role: "admin", label: deviceLabel })})`,
        PrivateHostPairingOfferSchema,
      );
      assert.equal(offer.publicOrigin, origin);
      assert.equal(offer.hostId, (await status()).hostId);
      return offer;
    });
    await step("redeem_offer_over_HTTPS_into_memory_only_admin_device", async () => {
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
        "private-live-task-smoke",
      );
      await store.restore();
      pairedHost = await store.pair(JSON.stringify(offer));
      ownedMembers.add(pairedHost.member.id);
      assert.ok(!initialMembers.has(pairedHost.member.id));
      assert.equal(pairedHost.member.role, "admin");
    });
    await step("verify_paired_host_identity_proof_over_HTTPS", () =>
      verifyPrivateHost(network, host(), "private-live-task-smoke"),
    );
    await step("negotiate_compatibility_and_connect_real_WSS", async () => {
      client = new PrivateHttpTransport(
        network,
        host,
        {
          connection(update) {
            online = update.state === "online";
            pulse();
          },
          event(hostId, event) {
            assert.equal(hostId, host().hostId);
            if (event.type === "runtime-snapshot") {
              runtime = event.snapshot;
              for (const prompt of event.snapshot.pendingPrompts)
                if (prompt.agentId === agentId) promptTurns.add(prompt.turnId);
            }
            if (event.type === "turn-started" && event.agentId === agentId) startedTurns.add(event.turnId);
            if (event.type === "turn-completed" && event.agentId === agentId)
              completedTurns.set(event.turnId, event.status);
            if (event.type === "prompt" && event.agentId === agentId) promptTurns.add(event.turnId);
            pulse();
          },
        },
        "private-live-task-smoke",
      );
      await transport().connect(host().hostId, host().hostPublicKey);
    });
    await step("receive_initial_real_runtime_snapshot", () =>
      proof(async () => (online && runtime !== null ? true : null)),
    );
    await step("require_idle_existing_Codex_agent_and_private_managed_workspace", async () => {
      const agents = await transport().request(
        "GET",
        TEAM_API_ROUTES.agents.all,
        boundary((value): value is AgentSummary[] => Array.isArray(value) && value.every(isAgentSummary)),
      );
      const agent = agents.find((value) => value.id === agentId);
      assert.ok(agent);
      assert.equal(agent.provider, "codex");
      assert.ok(instance);
      const profile = isAbsolute(instance.profile)
        ? instance.profile
        : join(resolveDevelopmentAppDataRoot(), instance.profile);
      assert.equal(
        canonical(await realpath(profile)),
        canonical(profile),
        "A redirected profile root is outside this smoke's scope.",
      );
      const expectedWorkspace = join(profile, "workspaces", "Agents", agentId);
      assert.equal(canonical(agent.workspacePath), canonical(expectedWorkspace));
      const workspaceStat = await lstat(expectedWorkspace);
      assert.ok(workspaceStat.isDirectory() && !workspaceStat.isSymbolicLink());
      assert.equal(
        canonical(await realpath(expectedWorkspace)),
        canonical(expectedWorkspace),
        "A linked workspace is outside this smoke's scope.",
      );
      const history: ConversationSnapshot = await conversation();
      assert.equal(history.activeTurnId, null);
      assert.ok(!runtime?.activeTurns.some((turn) => turn.agentId === agentId));
      assert.ok(
        !(await queue()).deliveries.some((delivery) => ["queued", "starting", "running"].includes(delivery.status)),
      );
      if (testCase === "queue-cancel") {
        // The frozen Team API omits per-agent busy mode. Read that local-only precondition from main.
        const local = await ipc(
          `(async () => { const agent = (await window.openbot.agent.listAgents("local")).find(item => item.id === ${JSON.stringify(agentId)}); return agent ? { busyMessageMode: agent.busyMessageMode ?? null } : null; })()`,
          Schema.Struct({
            busyMessageMode: Schema.NullOr(Schema.Literals(["queue", "steer"])),
          }),
        );
        const mode =
          local.busyMessageMode ??
          (
            await ipc(
              "window.openbot.getBusyMessageModePreference()",
              Schema.Struct({ mode: Schema.Literals(["queue", "steer"]) }),
            )
          ).mode;
        assert.equal(mode, "queue", "This case requires the existing queue mode; the smoke does not change settings.");
      }
      runDirectory = join(expectedWorkspace, relativeDirectory);
      assert.ok(relative(expectedWorkspace, runDirectory) === relativeDirectory);
      await mkdir(runDirectory);
      assert.equal(canonical(await realpath(runDirectory)), canonical(runDirectory));
      report.evidence.push({ kind: "run-owned-directory", relativePath: relativeDirectory });
    });
    if (testCase === "receipt-file") await receiptFileCase();
    else await queueCancelCase();
    report.passed = true;
  } finally {
    let cleanupFailed = false;
    if (client && pairedHost && ownedDeliveries.size > 0) {
      try {
        for (const delivery of (await queue()).deliveries.filter((item) => ownedDeliveries.has(item.id)))
          report.evidence.push({
            kind: "own-delivery-final-state",
            status: delivery.status,
            ...(delivery.turnId ? { turnId: delivery.turnId } : {}),
          });
      } catch {
        report.unverified.push("The final state of this run's deliveries could not be read before device cleanup.");
      }
    }
    if (session && mutationsStarted) {
      try {
        await verifyOwner();
        for (const device of (await status()).devices)
          if (!initialMembers.has(device.memberId) && device.label === deviceLabel) ownedMembers.add(device.memberId);
        if (pairingRequested && !pairedHost && ownedMembers.size === 0) {
          report.cleanup.unresolvedPairing = true;
          cleanupFailed = true;
        }
        for (const memberId of ownedMembers) {
          assert.ok(!initialMembers.has(memberId));
          if ((await status()).devices.some((device) => device.memberId === memberId && !device.disabled))
            await ipc(`window.openbot.privateAccess.revokeDevice(${JSON.stringify({ memberId })})`, statusSchema);
        }
        report.cleanup.remainingRunDevices = (await status()).devices.filter(
          (device) => ownedMembers.has(device.memberId) && !device.disabled,
        ).length;
        assert.equal(report.cleanup.remainingRunDevices, 0);
      } catch {
        cleanupFailed = true;
      }
    }
    report.cleanup.passed = !cleanupFailed;
    if (cleanupFailed) report.passed = false;
    await client?.disconnect().catch(() => undefined);
    for (const socket of sockets) socket.close();
    await session?.close().catch(() => undefined);
    await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
}

main().then(
  () => {
    if (!report.passed) process.exitCode = 1;
    process.stdout.write(
      `${JSON.stringify({ passed: report.passed, case: testCase, runId, report: relative(projectRoot, join(output, "report.json")) })}\n`,
    );
  },
  () => {
    process.stdout.write(
      `${JSON.stringify({ passed: false, case: testCase, runId, report: relative(projectRoot, join(output, "report.json")), messagesAndFilesRetained: true })}\n`,
    );
    process.exitCode = 1;
  },
);
