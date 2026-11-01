// Replays Codex stderr through the real stream reader and ProviderRuntime service. The injected
// client answers local protocol reads only; no provider account, model request or app is used.
// v0.58 keeps Codex stderr in the log. Sign-in replies and process exits report actual failures.
// Run: bun scripts/codex-diagnostics-e2e.ts
// Report: .openbot-build/codex-diagnostics-e2e/report.json
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AGENT_PROVIDERS } from "@openbot/contracts/ipc";
import { redactText, teeLogLines } from "@openbot/logging";
import { Effect, Result } from "effect";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { ProviderRuntime } from "../src/backend/agent/provider-runtime";
import { type AgentClient, AgentProcessExitError, type DiagnosticOrigin } from "../src/backend/agent-client";
import { AgentStore } from "../src/backend/agent-store";
import type {
  AppServerNotification,
  AppServerRequest,
  RequestId,
  ResponseDecoder,
  RpcError,
} from "../src/backend/protocol";
import { providerSync } from "../src/backend/provider-client-effects";
import { NO_PROVIDER_CREDENTIALS } from "../src/backend/provider-drivers";
import { createDiagnosticStream } from "../src/backend/stderr-diagnostics";

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string, origin?: DiagnosticOrigin];
}

class DiagnosticClient extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider = "codex";
  running = false;
  readonly #stream = createDiagnosticStream({
    redact: redactText,
    emit: (message) => this.emit("diagnostic", message),
  });

  start(): void {
    this.running = true;
  }

  stop() {
    return Effect.sync(() => {
      this.#stream.flush();
      this.running = false;
    });
  }

  request<T>(method: string, _params: unknown, decoder: ResponseDecoder<T>) {
    return providerSync(() => {
      switch (method) {
        case "initialize":
          return decoder({});
        case "account/read":
          return decoder({ account: { type: "chatgpt", email: "fixture@example.invalid" } });
        case "account/rateLimits/read":
          return decoder({
            rateLimits: { limitId: "codex", primary: null, secondary: null },
            rateLimitsByLimitId: null,
          });
        case "model/list":
          return decoder({ data: [{ model: "fixture-model", displayName: "Fixture model" }], nextCursor: null });
        case "account/login/start":
          throw new Error(LOGIN_FAILURE);
        default:
          throw new Error(`Unexpected fixture request: ${method}`);
      }
    });
  }

  notify(_method: string, _params?: unknown): void {}
  respond(_id: RequestId, _result: unknown): void {}
  respondError(_id: RequestId, _error: RpcError): void {}

  replay(record: string): void {
    const middle = Math.floor(record.length / 2);
    this.#stream.push(record.slice(0, middle));
    this.#stream.push(`${record.slice(middle)}\n`);
  }
}

const OUT = resolve(import.meta.dirname, "../.openbot-build/codex-diagnostics-e2e");
await mkdir(OUT, { recursive: true });
const root = await mkdtemp(join(OUT, "profile-"));
const cliScript = join(root, "codex.cjs");
const executable = process.platform === "win32" ? join(root, "codex.cmd") : cliScript;
await writeFile(
  cliScript,
  `#!${process.execPath}\nif (!process.argv.includes('--version')) throw new Error('Only the version probe is allowed');\nprocess.stdout.write('codex-cli 999.0.0\\n');\n`,
  { mode: 0o755 },
);
if (process.platform === "win32") {
  await writeFile(executable, `@"${process.execPath}" "${cliScript}" %*\r\n`);
}

const previousCli = process.env.OPENBOT_CODEX_PATH;
process.env.OPENBOT_CODEX_PATH = executable;
const errors: { code: string; message: string }[] = [];
const logs: string[] = [];
const stopLog = teeLogLines(["provider-runtime", "provider-stderr"], (line) => logs.push(line));
const store = new AgentStore(join(root, "user-data"), join(root, "home"));
const client = new DiagnosticClient();
let mainClientCreated = false;
const runtime = new ProviderRuntime({
  conversation: new ConversationRuntime(
    store,
    () => {},
    () => [],
  ),
  hooks: {
    bindClient: () => {},
    onProvidersReady: () => Effect.void,
    onProviderLost: () => {},
    onClientStopped: () => Effect.void,
    isStopping: () => false,
    isProviderBusy: () => false,
    isAgentBusy: () => false,
    isProviderAssigned: () => true,
    onAgentClientLost: () => Effect.void,
    sharedRoot: () => join(root, "shared"),
    onProviderResumed: () => {},
    onProviderActivated: () => Effect.void,
    captureConfigRevision: () => 0,
  },
  emit: () => {},
  emitError: (code, error) => errors.push({ code, message: error instanceof Error ? error.message : String(error) }),
  requestTimeoutMs: 5_000,
  preferredProvider: "codex",
  offProviders: AGENT_PROVIDERS.filter((provider) => provider !== "codex"),
  clientFactory: () => {
    if (mainClientCreated) return new DiagnosticClient();
    mainClientCreated = true;
    return client;
  },
  bundledExecutables: { codex: executable },
  credentials: NO_PROVIDER_CREDENTIALS,
  redactMcp: redactText,
});

const SNAPSHOT = "Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell";
const CANCELLED = "dynamic tool call was cancelled before receiving a response";
const SYNTHETIC_SECRET = "codex-diagnostic-fixture-credential";
const LOGIN_FAILURE = "ChatGPT connection was refused by the fixture.";
function record(
  level: string,
  target: string,
  fields: { message?: string; error?: string; api_key?: string; detail?: string },
) {
  return JSON.stringify({ timestamp: "2026-10-31T07:50:27.654827Z", level, target, fields });
}

const cases = [
  { name: "snapshot-json", text: record("WARN", "codex_core::shell_snapshot", { message: SNAPSHOT }) },
  { name: "snapshot-text", text: `2026-10-31T07:50:27Z  WARN codex_core::shell_snapshot: ${SNAPSHOT}` },
  { name: "cancel-json", text: record("ERROR", "codex_core::tools::router", { error: CANCELLED }) },
  {
    name: "cancel-text",
    text: `2026-10-31T07:51:40Z ERROR codex_core::tools::router: error=${CANCELLED}`,
  },
  {
    // Representative records for the harmless startup case named by upstream issue #4265.
    // These are fixture text, not a captured CLI transcript.
    name: "untrusted-folder-json",
    text: record("ERROR", "codex_core::config", {
      message: "Project folder is not trusted; its config.toml settings are ignored.",
    }),
  },
  {
    name: "untrusted-folder-text",
    text: "ERROR codex_core::config: Project folder is not trusted; its config.toml settings are ignored.",
  },
  {
    name: "tool-error-json",
    text: record("ERROR", "codex_core::tools::router", { error: "image generation failed" }),
  },
  {
    name: "long-tool-json",
    text: record("ERROR", "codex_core::tools::router", { error: CANCELLED, detail: "x".repeat(3_000) }),
  },
  {
    name: "snapshot-redaction",
    text: record("WARN", "codex_core::shell_snapshot", { message: SNAPSHOT, api_key: SYNTHETIC_SECRET }),
  },
  {
    name: "cancel-redaction",
    text: record("ERROR", "codex_core::tools::router", { error: CANCELLED, api_key: SYNTHETIC_SECRET }),
  },
  {
    name: "fatal-tool-json",
    text: record("ERROR", "codex_core::tools::router", { error: "Fatal error: execution stopped" }),
  },
  {
    name: "unexpected-fields-with-tool-marker",
    text: JSON.stringify({
      level: "ERROR",
      target: "codex_core::tools::router",
      fields: ["Fatal error: tool_error: execution_failure"],
    }),
  },
  {
    name: "fatal-tool-text-with-tool-marker",
    text: "ERROR codex_core::tools::router: error=Fatal error: tool_error: execution_failure",
  },
  {
    name: "credential-fallback-text",
    text: 'WARN codex_otel::auth_storage: credential storage file fallback completed secure_error="none" outcome="not_found"',
  },
  {
    name: "authentication-stderr-redaction",
    text: record("ERROR", "codex_core::auth", { message: "Authentication failed", api_key: SYNTHETIC_SECRET }),
  },
];
const report: {
  contract: string;
  passed: boolean;
  cases: { name: string; passed: boolean; visible: boolean; logged: boolean }[];
  failures: { name: string; passed: boolean; surface: "provider-status" | "process-exit" }[];
  error?: string;
} = {
  contract: "upstream-v0.58.0-codex-stderr-log-only",
  passed: false,
  cases: [],
  failures: [],
};

try {
  await Effect.runPromise(runtime.start());
  assert.equal(runtime.isReady(), true, "The local fixture must connect before diagnostics are replayed.");
  assert.equal(errors.length, 0, "The local fixture must start without provider errors.");
  for (const check of cases) {
    const before = errors.length;
    const logBefore = logs.length;
    const lastError = runtime.lastError("codex");
    client.replay(check.text);
    const newErrors = errors.slice(before);
    const newLogs = logs.slice(logBefore);
    const visible = newErrors.some((error) => error.code === "codex_diagnostic");
    const result = { name: check.name, passed: false, visible, logged: newLogs.length > 0 };
    report.cases.push(result);
    assert.equal(newErrors.length, 0, `${check.name}: stderr must not invent a provider failure`);
    assert.equal(result.logged, true, `${check.name}: the diagnostic must remain in the log`);
    assert.equal(
      JSON.stringify([newErrors, newLogs]).includes(SYNTHETIC_SECRET),
      false,
      `${check.name}: no credential may escape`,
    );
    assert.equal(runtime.lastError("codex"), lastError, `${check.name}: the provider error must stay unchanged`);
    assert.equal(runtime.isReady(), true, `${check.name}: the provider must remain ready`);
    assert.equal(client.running, true, `${check.name}: the provider must keep running`);
    result.passed = true;
  }
  const signIn = { name: "protocol-sign-in-failure", passed: false, surface: "provider-status" as const };
  report.failures.push(signIn);
  const login = await Effect.runPromise(runtime.startProviderCodeLogin("codex").pipe(Effect.result));
  assert.equal(Result.isFailure(login), true, "A refused protocol sign-in must fail its caller.");
  assert.equal(
    runtime.status().providers?.find((provider) => provider.id === "codex")?.message,
    LOGIN_FAILURE,
    "The provider status must show the protocol sign-in failure.",
  );
  assert.equal(runtime.isReady(), true, "A failed new sign-in must keep the existing connection.");
  signIn.passed = true;

  const exit = { name: "process-exit-with-redacted-detail", passed: false, surface: "process-exit" as const };
  report.failures.push(exit);
  const beforeExit = errors.length;
  const logsBeforeExit = logs.length;
  client.emit(
    "exit",
    new AgentProcessExitError(
      "Fixture Codex process exited.",
      `ERROR codex_core::fixture: stopped api_key="${SYNTHETIC_SECRET}"`,
    ),
  );
  const exitError = errors.slice(beforeExit).find((error) => error.code === "codex_exited");
  assert.ok(exitError, "A process exit must remain a provider failure.");
  assert.match(exitError.message, /Fixture Codex process exited/);
  assert.match(exitError.message, /codex_core::fixture/);
  assert.equal(
    JSON.stringify([exitError, logs.slice(logsBeforeExit), runtime.status()]).includes(SYNTHETIC_SECRET),
    false,
  );
  assert.equal(runtime.isReady(), false, "An exited provider must not remain ready.");
  exit.passed = true;
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? redactText(error.message) : "The diagnostic service check failed.";
  process.exitCode = 1;
} finally {
  const clients = await Effect.runPromise(runtime.dispose());
  for (const running of clients) await Effect.runPromise(running.stop());
  store.database.close();
  stopLog();
  if (previousCli === undefined) delete process.env.OPENBOT_CODEX_PATH;
  else process.env.OPENBOT_CODEX_PATH = previousCli;
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(
  `${JSON.stringify({ passed: report.passed, stderrCases: report.cases.length, failureCases: report.failures.length, report: join(OUT, "report.json") })}\n`,
);
