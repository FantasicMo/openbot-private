// CI-only: install this candidate, drive its real renderer/Team API, reinstall, and uninstall it.
// Uses only a new private installation/profile. Never runs the official installer cleanup script.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as poll } from "node:timers/promises";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { teamCapabilitiesForProtocol } from "@openbot/contracts/team-protocol/current";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_PROTOCOL_V1_WEBSOCKET,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol/v1";
import { encodeTeamProtocolV1CurrentClientEvent } from "@openbot/contracts/team-protocol/v1-adapter";
import { createOpenBotLogger, redactText, registerSecretValue } from "@openbot/logging";
import { PRIVATE_PAIRING_PATH, PrivateHostPairingOfferSchema } from "@openbot/private-access/contracts";
import { Schema } from "effect";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";
import { parse as parseYaml } from "yaml";
import { forwardDiagnosticLines } from "../src/main/remote-diagnostics";
import { type AutomationSession, connectToDevApp, verifyBrowserOwnership } from "./dev-automation/cdp-client";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true")
  throw new Error("This installer E2E runs only on a disposable Windows GitHub Actions runner.");

const installerArgument = process.argv[2];
assert.ok(installerArgument, "Pass exactly one private installer path.");
assert.equal(process.argv.length, 3, "Only the private installer path is accepted.");
const installer = resolve(installerArgument);
assert.ok(existsSync(installer), "The candidate installer must exist.");
const installerSuffix = relative(resolve("dist-private"), installer);
assert.ok(installerSuffix !== "" && !installerSuffix.startsWith("..") && !isAbsolute(installerSuffix));
assert.match(basename(installer), /^OpenBot-Private-.+-x64\.exe$/u);
const config = Schema.decodeUnknownSync(
  Schema.Struct({
    extends: Schema.String,
    appId: Schema.String,
    productName: Schema.String,
    protocols: Schema.Array(Schema.String),
    publish: Schema.Array(Schema.String),
    directories: Schema.Struct({ output: Schema.String }),
    nsis: Schema.Struct({ include: Schema.String, runAfterFinish: Schema.Boolean }),
  }),
)(parseYaml(await readFile("electron-builder.private.yml", "utf8")));
assert.equal(config.appId, "io.github.fantasicmo.openbot");
assert.equal(config.productName, "OpenBot Private");
assert.equal(config.extends, "./electron-builder.yml");
assert.equal(config.protocols.length, 0);
assert.equal(config.publish.length, 0);
assert.equal(config.directories.output, "dist-private");
assert.equal(config.nsis.include, "build/installer-private.nsh");
assert.equal(config.nsis.runAfterFinish, false);
const localAppData = process.env.LOCALAPPDATA;
const appData = process.env.APPDATA;
assert.ok(localAppData && appData, "Windows application directories must exist.");
const installDirectory = resolve(localAppData, "Programs", config.productName);
const profileDirectory = resolve(appData, config.productName);
const workspaceDirectory = resolve(homedir(), config.productName);
const executable = join(installDirectory, `${config.productName}.exe`);
const uninstaller = join(installDirectory, `Uninstall ${config.productName}.exe`);
const output = resolve(".openbot-build/private-windows-installer-e2e");
const loginProfileDirectory = join(output, "login profile with spaces");
const loginCommandPrefix = `"${executable}" `;
const expectedLoginCommand = `${loginCommandPrefix}"--user-data-dir=${loginProfileDirectory}"`;
const reportPath = join(output, "report.json");
const logger = createOpenBotLogger("private-windows-installer-e2e", () => undefined);
const publicOrigin = "https://private-windows-ci.invalid";
const publicHost = new URL(publicOrigin).host;
type WaitPhase =
  | "installer_exit"
  | "uninstaller_exit"
  | "owned_app_exit"
  | "cdp_disconnect"
  | "cdp_http_ready"
  | "cdp_renderer_connect"
  | "private_host_ready"
  | "startup_diagnostics"
  | "event_runtime_snapshot"
  | "revoked_socket_closed";
interface SafeFailure {
  code: string;
  phase?: WaitPhase;
  errorName?: string;
  systemCode?: string;
  commandExitCode?: number;
  assertionOperator?: string;
  timeoutMs?: number;
  exitCode?: number | null;
  expectedExitCode?: number;
  signal?: NodeJS.Signals | null;
  httpStatus?: number;
  expectedHttpStatus?: number;
  hostPhase?: "error" | "local-only" | "starting" | "ready";
}
class SmokeFailure extends Error {
  constructor(readonly details: SafeFailure) {
    super(details.code);
    this.name = "SmokeFailure";
  }
}
interface LaunchEvidence {
  attempt: number;
  profile: "default" | "explicit";
  startedAt: string;
  pid: number | null;
  phase: WaitPhase;
  cdpHttpReady: boolean;
  rendererAttached: boolean;
  ownerAlive: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  lastAttachError?: SafeFailure & { message?: string };
  cdpOwnerVerified?: boolean;
  targets?: { type: string; category: string }[];
  totalTargets?: number;
  nativeWindow?: "startup_error" | "other" | "none";
  freshMainErrorCount?: number;
  freshMainErrors?: string[];
  processMainErrors: string[];
  diagnosticFailures: SafeFailure[];
}
const report: {
  passed: boolean;
  scope: string;
  steps: { name: string; passed: boolean; durationMs: number; failure?: SafeFailure }[];
  failure?: { step: string } & SafeFailure;
  cleanupFailures: ({ operation: "login_item" | "owned_app" } & SafeFailure)[];
  launches: LaunchEvidence[];
  officialDataChecks: {
    scope: "CI_sentinel_files_only";
    sentinels: { area: string; sha256: string; rootExistedBefore: boolean }[];
    verifiedAfter: string[];
  };
  loginItemChecks: { scope: "CI_private_AUMID_only"; preservedProfileWithSpaces: boolean; removed: boolean };
  unverified: string[];
} = {
  passed: false,
  scope: "installed_private_Windows_Electron_real_HostService_TeamApiServer_TeamStore_and_gateway",
  steps: [],
  cleanupFailures: [],
  launches: [],
  officialDataChecks: { scope: "CI_sentinel_files_only", sentinels: [], verifiedAfter: [] },
  loginItemChecks: { scope: "CI_private_AUMID_only", preservedProfileWithSpaces: false, removed: false },
  unverified: [
    "Tailscale Serve HTTPS trust, ACLs, LAN routing, Clash coexistence and physical devices.",
    "Android native runtime, UI, file transfers and model-provider execution.",
    "Remote desktop/browser streaming resources and migration from an older private release.",
    "A forced process restart is tested; normal tray shutdown and power-loss durability are separate checks.",
    "Unsigned internal candidate: no Authenticode publisher identity or SmartScreen acceptance is established.",
    "Official data preservation covers two CI-created sentinel files; other pre-existing official files are not inventoried.",
    "Login-item registration and stored-command relaunch are tested; an actual Windows sign-in is not tested.",
  ],
};
let child: ChildProcess | null = null;
let session: AutomationSession | null = null;
let installedByThisRun = false;
let launchFailed = false;
let activeProfileDirectory: string | null = null;
let loginItemMayBeOwned = false;
const sockets: WebSocket[] = [];

const statusSchema = Schema.Struct({
  enabled: Schema.Boolean,
  phase: Schema.String,
  hostId: Schema.NullOr(Schema.String),
  publicOrigin: Schema.NullOr(Schema.String),
  gatewayPort: Schema.NullOr(Schema.Number),
  errorCode: Schema.NullOr(Schema.String),
});
const acceptedSchema = Schema.Struct({
  member: Schema.Struct({ id: Schema.String, role: Schema.String }),
  sessionToken: Schema.String,
});
const meSchema = Schema.Struct({ id: Schema.String, role: Schema.String });
const behaviorSchema = Schema.Struct({ launchAtLogin: Schema.Boolean });
const loginRegistrationSchema = Schema.Struct({
  command: Schema.NullOr(Schema.String),
  approval: Schema.NullOr(Schema.String),
});

function safeFailure(error: unknown): SafeFailure {
  if (error instanceof SmokeFailure) return error.details;
  const failure: SafeFailure = { code: "operation_failed" };
  if (error instanceof Error) {
    failure.errorName = [
      "Error",
      "TypeError",
      "RangeError",
      "SyntaxError",
      "TimeoutError",
      "AbortError",
      "AssertionError",
    ].includes(error.name)
      ? error.name
      : "Error";
    if (
      "code" in error &&
      typeof error.code === "string" &&
      ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EADDRINUSE", "ABORT_ERR"].includes(
        error.code,
      )
    )
      failure.systemCode = error.code;
    if ("status" in error && typeof error.status === "number" && Number.isInteger(error.status))
      failure.commandExitCode = error.status;
  }
  if (error instanceof assert.AssertionError) {
    failure.code = "assertion_failed";
    failure.assertionOperator = [
      "==",
      "!=",
      "===",
      "!==",
      "strictEqual",
      "deepStrictEqual",
      "notStrictEqual",
      "notDeepStrictEqual",
      "match",
      "ok",
    ].includes(error.operator)
      ? error.operator
      : "other";
  }
  return failure;
}

async function within<A>(phase: WaitPhase, timeoutMs: number, action: () => Promise<A>): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SmokeFailure({ code: "timeout", phase, timeoutMs })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function step<A>(name: string, action: () => Promise<A>): Promise<A> {
  const started = performance.now();
  process.stdout.write(`${JSON.stringify({ step: name, state: "started" })}\n`);
  try {
    const result = await action();
    const durationMs = Math.round(performance.now() - started);
    report.steps.push({ name, passed: true, durationMs });
    process.stdout.write(`${JSON.stringify({ step: name, state: "passed", durationMs })}\n`);
    return result;
  } catch (error) {
    const failure = safeFailure(error);
    const durationMs = Math.round(performance.now() - started);
    report.steps.push({ name, passed: false, durationMs, failure });
    report.failure ??= { step: name, ...failure };
    // Keep fixed diagnostics, not messages, actual assertion values, page text or credentials.
    process.stdout.write(`${JSON.stringify({ step: name, state: "failed", durationMs, ...failure })}\n`);
    throw error;
  }
}

function ownsInstalledPath(path: string): boolean {
  const suffix = relative(installDirectory, resolve(path));
  return suffix !== "" && !suffix.startsWith("..") && !isAbsolute(suffix);
}

function protocolRegistration(): string | null {
  const environment = { ...process.env };
  delete environment.PSModulePath;
  const present = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; (Test-Path -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\openbot').ToString()",
    ],
    {
      encoding: "utf8",
      env: environment,
    },
  ).trim();
  if (present === "False") return null;
  assert.equal(present, "True", "The official protocol registry must be readable.");
  return execFileSync("reg.exe", ["query", "HKCU\\Software\\Classes\\openbot", "/s"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Reads only this private app's user-scope Run and StartupApproved values. */
function privateLoginRegistration(): typeof loginRegistrationSchema.Type {
  const environment = { ...process.env };
  delete environment.PSModulePath;
  const text = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'
$name = '${config.appId}'
$runPath = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
$approvedPath = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
$command = $null
$approval = $null
if (Test-Path -LiteralPath $runPath) {
  $command = (Get-Item -LiteralPath $runPath).GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}
if (Test-Path -LiteralPath $approvedPath) {
  $value = (Get-Item -LiteralPath $approvedPath).GetValue($name)
  if ($null -ne $value) { $approval = [Convert]::ToBase64String($value) }
}
@{ command = $command; approval = $approval } | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "ignore"] },
  );
  return Schema.decodeUnknownSync(loginRegistrationSchema)(JSON.parse(text));
}

const officialRegistration = protocolRegistration();
const officialPaths = [join(localAppData, "Programs", "OpenBot"), join(appData, "OpenBot"), join(homedir(), "OpenBot")];
let officialExistence = officialPaths.map((path) => existsSync(path));
const officialSentinels = [
  { area: "profile", directory: join(appData, "OpenBot") },
  { area: "workspace", directory: join(homedir(), "OpenBot") },
].map(({ area, directory }) => {
  const content = `OpenBot Private CI preservation sentinel: official ${area}\n`;
  return {
    area,
    directory,
    path: join(directory, "openbot-private-ci-preservation-sentinel.txt"),
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
    rootExistedBefore: existsSync(directory),
  };
});

async function assertOfficialDataUnchanged(phase: "install" | "reinstall" | "uninstall"): Promise<void> {
  assert.equal(protocolRegistration(), officialRegistration, "The official openbot scheme must remain unchanged.");
  assert.deepEqual(
    officialPaths.map((path) => existsSync(path)),
    officialExistence,
  );
  for (const sentinel of officialSentinels) {
    const bytes = await readFile(sentinel.path);
    assert.equal(bytes.toString("utf8"), sentinel.content, "Official data sentinel content changed.");
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      sentinel.sha256,
      "Official data sentinel hash changed.",
    );
  }
  report.officialDataChecks.verifiedAfter.push(phase);
}

async function runInstaller(file: string, argumentsText: string): Promise<void> {
  assert.ok(file === installer || (installedByThisRun && file === uninstaller && ownsInstalledPath(file)));
  const installerProcess = spawn(file, [argumentsText], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    stdio: "ignore",
  });
  const phase = file === uninstaller ? "uninstaller_exit" : "installer_exit";
  const [code, signal] = await within(phase, 300_000, () => once(installerProcess, "exit")).catch((error: unknown) => {
    if (installerProcess.exitCode === null && installerProcess.signalCode === null) installerProcess.kill();
    if (error instanceof SmokeFailure) throw error;
    throw new SmokeFailure({ ...safeFailure(error), code: "installer_spawn_failed", phase });
  });
  if (code !== 0)
    throw new SmokeFailure({ code: "installer_exit_nonzero", phase, exitCode: code, signal, expectedExitCode: 0 });
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening", { signal: AbortSignal.timeout(10_000) });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
  return address.port;
}

async function until(phase: WaitPhase, ready: () => boolean | Promise<boolean>): Promise<void> {
  const limit = Date.now() + 180_000;
  await within(phase, 180_000, async () => {
    while (true) {
      // The outer deadline also covers a stalled callback. Stop the poll when it returns later.
      if (Date.now() >= limit) throw new SmokeFailure({ code: "timeout", phase, timeoutMs: 180_000 });
      if (launchFailed) throw new SmokeFailure({ code: "app_spawn_failed", phase });
      if (child && (child.exitCode !== null || child.signalCode !== null))
        throw new SmokeFailure({ code: "owned_app_exited", phase, exitCode: child.exitCode, signal: child.signalCode });
      if (await ready()) return;
      await poll(150);
    }
  });
}

/** Redact complete values before bounding them. No raw log, page title or URL is exported. */
function diagnosticText(value: string): string {
  return redactText(value)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, "[url-redacted]")
    .slice(0, 12_000);
}

function targetCategory(
  value: string,
): "about_blank" | "private_app" | "app_helper" | "error_page" | "devtools" | "unparseable" | "other" {
  if (value === "about:blank") return "about_blank";
  try {
    const url = new URL(value);
    if (url.protocol === "openbot-app:" && url.hostname === "app" && url.pathname === "/index.html")
      return "private_app";
    if (url.protocol === "openbot-app:" && url.pathname === "/helper.html") return "app_helper";
    if (url.protocol === "chrome-error:") return "error_page";
    if (url.protocol === "devtools:") return "devtools";
  } catch {
    return "unparseable";
  }
  return "other";
}

async function collectLaunchFailure(launch: LaunchEvidence, port: number, directory: string): Promise<void> {
  const owned = child;
  launch.ownerAlive = Boolean(owned?.pid !== undefined && owned.exitCode === null && owned.signalCode === null);
  launch.exitCode = owned?.exitCode ?? null;
  launch.signal = owned?.signalCode ?? null;
  await within("startup_diagnostics", 15_000, async () => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 });
    try {
      launch.cdpOwnerVerified = launch.pid !== null && (await verifyBrowserOwnership(browser, launch.pid));
      if (!launch.cdpOwnerVerified) return;
      const probe = await browser.newBrowserCDPSession();
      try {
        const { targetInfos } = await probe.send("Target.getTargets");
        launch.totalTargets = targetInfos.length;
        launch.targets = targetInfos.slice(0, 20).map((target) => ({
          type: ["page", "service_worker", "background_page", "browser"].includes(target.type) ? target.type : "other",
          category: targetCategory(target.url),
        }));
      } finally {
        await probe.detach().catch(() => undefined);
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
  }).catch((error: unknown) => launch.diagnosticFailures.push(safeFailure(error)));
  if (launch.pid !== null) {
    try {
      const environment = { ...process.env };
      delete environment.PSModulePath;
      const text = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference = 'Stop'; $ownedProcess = Get-Process -Id ${launch.pid}; @{ present = ($ownedProcess.MainWindowHandle.ToInt64() -ne 0); title = $ownedProcess.MainWindowTitle } | ConvertTo-Json -Compress`,
        ],
        { encoding: "utf8", env: environment, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
      );
      const window = Schema.decodeUnknownSync(Schema.Struct({ present: Schema.Boolean, title: Schema.String }))(
        JSON.parse(text),
      );
      launch.nativeWindow = !window.present
        ? "none"
        : ["OpenBot couldn’t start", "OpenBot 无法启动"].includes(window.title)
          ? "startup_error"
          : "other";
    } catch (error) {
      launch.diagnosticFailures.push(safeFailure(error));
    }
  }
  try {
    const path = join(directory, "logs", "main", "main.log");
    const info = await stat(path);
    assert.ok(info.size <= 2 * 1024 * 1024, "Only the bounded main log may be read.");
    const errors = (await readFile(path, "utf8")).split(/\r?\n/u).filter((line) => {
      const timestamp = line.slice(0, 24);
      return timestamp >= launch.startedAt && /^\d{4}-\d{2}-\d{2}T[^ ]+ ERROR \[main\] /u.test(line);
    });
    launch.freshMainErrorCount = errors.length;
    launch.freshMainErrors = errors.slice(-8).map(diagnosticText);
  } catch (error) {
    launch.diagnosticFailures.push(safeFailure(error));
  }
}

async function startApp(userDataDirectory?: string, fromLoginItem = false): Promise<void> {
  const port = await unusedPort();
  launchFailed = false;
  const args = [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"];
  if (fromLoginItem) {
    assert.equal(userDataDirectory, loginProfileDirectory);
    const registration = privateLoginRegistration();
    assert.equal(registration.command, expectedLoginCommand);
    // Replay the exact stored argument, with its quotes, only after matching the owned command.
    args.unshift(registration.command.slice(loginCommandPrefix.length));
  } else if (userDataDirectory) args.unshift(`--user-data-dir=${userDataDirectory}`);
  activeProfileDirectory = userDataDirectory ?? profileDirectory;
  const launch: LaunchEvidence = {
    attempt: report.launches.length + 1,
    profile: userDataDirectory ? "explicit" : "default",
    startedAt: new Date().toISOString(),
    pid: null,
    phase: "cdp_http_ready",
    cdpHttpReady: false,
    rendererAttached: false,
    ownerAlive: true,
    exitCode: null,
    signal: null,
    processMainErrors: [],
    diagnosticFailures: [],
  };
  report.launches.push(launch);
  // Initial install/reinstall checks keep the default private data path.
  child = spawn(executable, args, {
    env: {
      ...process.env,
      CODEX_HOME: join(activeProfileDirectory, "ci-missing-codex"),
      CLAUDE_CONFIG_DIR: join(activeProfileDirectory, "ci-missing-claude"),
      OPENBOT_CODEX_PATH: join(activeProfileDirectory, "missing-codex.exe"),
      OPENBOT_CLAUDE_PATH: join(activeProfileDirectory, "missing-claude.exe"),
      OPENBOT_GROK_PATH: join(activeProfileDirectory, "missing-grok.exe"),
    },
    windowsVerbatimArguments: fromLoginItem,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const captureMainErrors = (text: string) => {
    for (const line of text.split(/\r?\n/u)) {
      if (!/^\d{4}-\d{2}-\d{2}T[^ ]+ ERROR \[main\] /u.test(line)) continue;
      launch.processMainErrors.push(diagnosticText(line));
      if (launch.processMainErrors.length > 8) launch.processMainErrors.shift();
    }
  };
  // The startup error box blocks Electron's event loop. Its asynchronous disk log may not flush;
  // keep only bounded, redacted main-error lines from this exact spawned process's streams too.
  forwardDiagnosticLines(child.stdout, captureMainErrors);
  forwardDiagnosticLines(child.stderr, captureMainErrors);
  child.once("error", () => {
    launchFailed = true;
  });
  launch.pid = child.pid ?? null;
  let acceptingConnections = true;
  try {
    await until("cdp_http_ready", async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
        return response.ok;
      } catch {
        return false;
      }
    });
    launch.cdpHttpReady = true;
    launch.phase = "cdp_renderer_connect";
    await until("cdp_renderer_connect", async () => {
      try {
        const attached = await connectToDevApp(port, logger, {
          ownerPid: child?.pid,
          pageSelector: "openbot-app://app/index.html",
        });
        if (!acceptingConnections) {
          await attached.close().catch(() => undefined);
          return false;
        }
        session = attached;
        return true;
      } catch (error) {
        launch.lastAttachError = {
          ...safeFailure(error),
          ...(error instanceof Error ? { message: diagnosticText(error.message) } : {}),
        };
        return false;
      }
    });
    launch.rendererAttached = true;
    launch.phase = "private_host_ready";
    await until("private_host_ready", async () => {
      try {
        const status = await ipc("window.openbot.privateAccess.status()", statusSchema);
        if (status.phase === "error")
          throw new SmokeFailure({
            code:
              status.errorCode === "invalid_configuration"
                ? "private_invalid_configuration"
                : "private_gateway_start_failed",
            phase: "private_host_ready",
            hostPhase: "error",
          });
        return status.enabled && status.hostId !== null;
      } catch (error) {
        if (error instanceof SmokeFailure) throw error;
        return false;
      }
    });
  } catch (error) {
    acceptingConnections = false;
    await collectLaunchFailure(launch, port, activeProfileDirectory);
    throw error;
  }
}

async function stopApp(): Promise<void> {
  for (const socket of sockets.splice(0)) socket.terminate();
  const attached = session;
  session = null;
  const owned = child;
  let failure: unknown;
  try {
    if (owned && owned.exitCode === null && owned.signalCode === null && owned.pid !== undefined) {
      // Attach before taskkill. A failed command can race with an already-exiting owned process.
      const exited = once(owned, "exit", { signal: AbortSignal.timeout(30_000) }).then(
        () => null,
        (error: unknown) => safeFailure(error),
      );
      let commandFailure: SafeFailure | undefined;
      try {
        // Only the PID returned by this script's spawn, including its own child tree.
        execFileSync("taskkill.exe", ["/PID", String(owned.pid), "/T", "/F"], { stdio: "ignore", timeout: 15_000 });
      } catch (error) {
        commandFailure = safeFailure(error);
      }
      const exitFailure = await exited;
      if (exitFailure)
        throw new SmokeFailure({
          ...commandFailure,
          code: "owned_app_exit_unconfirmed",
          phase: "owned_app_exit",
          timeoutMs: 30_000,
        });
    }
    // Keep the owned PID available to final cleanup until its exit is confirmed.
    child = null;
    activeProfileDirectory = null;
  } catch (error) {
    failure = error;
  }
  try {
    // Stop the owned app before waiting for CDP. A stalled disconnect must not block termination.
    if (attached) await within("cdp_disconnect", 10_000, () => attached.close().catch(() => undefined));
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

async function ipc<A>(expression: string, schema: Schema.Decoder<A>): Promise<A> {
  assert.ok(session, "The owned renderer must be connected.");
  return Schema.decodeUnknownSync(schema)(await session.page.evaluate(expression));
}

async function removeOwnedLoginItem(): Promise<void> {
  if (!loginItemMayBeOwned) return;
  const registration = privateLoginRegistration();
  assert.ok(registration.command === null || registration.command === expectedLoginCommand);
  assert.ok(installedByThisRun && existsSync(executable));
  if (!session || activeProfileDirectory !== loginProfileDirectory) {
    await stopApp();
    await startApp(loginProfileDirectory);
  }
  const disabled = await ipc("window.openbot.setAppBehaviorPreference({ launchAtLogin: false })", behaviorSchema);
  assert.equal(disabled.launchAtLogin, false);
  assert.deepEqual(privateLoginRegistration(), { command: null, approval: null });
  loginItemMayBeOwned = false;
  report.loginItemChecks.removed = true;
}

async function verifyFuses(): Promise<void> {
  const wire = await getCurrentFuseWire(executable);
  for (const fuse of [
    FuseV1Options.RunAsNode,
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseV1Options.EnableNodeCliInspectArguments,
    FuseV1Options.LoadBrowserProcessSpecificV8Snapshot,
    FuseV1Options.GrantFileProtocolExtraPrivileges,
  ])
    assert.equal(wire[fuse], 48, "A disabled Electron fuse changed.");
  for (const fuse of [
    FuseV1Options.EnableCookieEncryption,
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    FuseV1Options.OnlyLoadAppFromAsar,
  ])
    assert.equal(wire[fuse], 49, "An enabled Electron fuse changed.");
}

async function main(): Promise<void> {
  await mkdir(output, { recursive: true });
  await step("refuse_existing_private_installation_or_profile", async () => {
    for (const path of [installDirectory, profileDirectory, workspaceDirectory, loginProfileDirectory])
      assert.ok(!existsSync(path), "The disposable runner must have no private installation or profile.");
    assert.deepEqual(privateLoginRegistration(), { command: null, approval: null });
  });
  await step("prepare_official_data_sentinels_without_overwrite", async () => {
    for (const sentinel of officialSentinels)
      assert.ok(!existsSync(sentinel.path), "An existing sentinel file must not be overwritten.");
    for (const sentinel of officialSentinels) {
      await mkdir(sentinel.directory, { recursive: true });
      // Exclusive creation also prevents an overwrite if another process creates the path now.
      await writeFile(sentinel.path, sentinel.content, { encoding: "utf8", flag: "wx" });
      report.officialDataChecks.sentinels.push({
        area: sentinel.area,
        sha256: sentinel.sha256,
        rootExistedBefore: sentinel.rootExistedBefore,
      });
    }
    // These roots can now exist because this test created its own harmless sentinel files.
    officialExistence = officialPaths.map((path) => existsSync(path));
  });
  await step("install_candidate_in_separate_default_directory", async () => {
    await runInstaller(installer, "/S");
    installedByThisRun = true;
    assert.ok(ownsInstalledPath(executable) && existsSync(executable) && existsSync(uninstaller));
    assert.ok(existsSync(join(installDirectory, "resources", "app.asar")));
    await verifyFuses();
    await assertOfficialDataUnchanged("install");
  });
  await step("launch_installed_private_app_without_account", async () => {
    await startApp();
    const info = await ipc(
      "window.openbot.getAppInfo()",
      Schema.Struct({ name: Schema.String, privateBuild: Schema.Boolean }),
    );
    assert.equal(info.name, config.productName);
    assert.equal(info.privateBuild, true);
    const account = await ipc("window.openbot.auth.getState()", Schema.Struct({ status: Schema.String }));
    assert.equal(account.status, "signed_out");
    assert.equal(
      await ipc("typeof window.require === 'undefined' && typeof window.process === 'undefined'", Schema.Boolean),
      true,
    );
    assert.ok(existsSync(join(profileDirectory, "openbot-private-owner-v1.json")));
    const before = await ipc("window.openbot.privateAccess.status()", statusSchema);
    assert.equal(before.phase, "local-only");
    assert.equal(before.publicOrigin, null);
    const retry = await ipc(
      "(async () => { try { await window.openbot.auth.retry(); return false; } catch { return (await window.openbot.auth.getState()).status === 'signed_out'; } })()",
      Schema.Boolean,
    );
    assert.equal(retry, true);
  });
  const first = await ipc("window.openbot.privateAccess.status()", statusSchema);
  const profileCanary = join(profileDirectory, "private-candidate-canary.txt");
  const workspaceCanary = join(workspaceDirectory, "private-candidate-canary.txt");
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(profileCanary, "private profile persistence\n");
  await writeFile(workspaceCanary, "private workspace persistence\n");
  let base = "";
  const version = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(
    JSON.parse(await readFile("package.json", "utf8")),
  ).version;
  const headers = (token?: string) => ({
    Host: publicHost,
    [TEAM_PROTOCOL_VERSION_HEADER]: "9",
    [TEAM_APP_VERSION_HEADER]: version,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  const request = (path: string, token?: string) =>
    fetch(`${base}${path}`, { headers: headers(token), signal: AbortSignal.timeout(20_000) });
  const { deviceA, deviceB } = await step("real_gateway_pairs_two_explicit_admin_devices", async () => {
    const gatewayPort = await unusedPort();
    const settings = { publicOrigin, gatewayPort };
    const configured = await ipc(`window.openbot.privateAccess.configure(${JSON.stringify(settings)})`, statusSchema);
    assert.equal(configured.phase, "ready");
    base = `http://127.0.0.1:${gatewayPort}`;
    const pair = async (label: string, username: string) => {
      const offer = await ipc(
        `window.openbot.privateAccess.createPairing(${JSON.stringify({ role: "admin", label })})`,
        PrivateHostPairingOfferSchema,
      );
      registerSecretValue(offer.secret);
      const password = randomBytes(32).toString("base64url");
      registerSecretValue(password);
      const response = await fetch(`${base}${PRIVATE_PAIRING_PATH}`, {
        method: "POST",
        headers: { Host: publicHost, "Content-Type": "application/json" },
        body: JSON.stringify({ offerId: offer.offerId, secret: offer.secret, username, password }),
        signal: AbortSignal.timeout(20_000),
      });
      assert.equal(response.status, 201);
      const accepted = Schema.decodeUnknownSync(acceptedSchema)(await response.json());
      registerSecretValue(accepted.sessionToken);
      assert.equal(accepted.member.role, "admin");
      return accepted;
    };
    const deviceA = await pair("CI phone A", "private-ci-a");
    const deviceB = await pair("CI phone B", "private-ci-b");
    assert.notEqual(deviceA.member.id, deviceB.member.id);
    return { deviceA, deviceB };
  });
  await step("real_Team_API_auth_and_local_owner_presence", async () => {
    const anonymous = await request(TEAM_API_ROUTES.me);
    assert.equal(anonymous.status, 401);
    await anonymous.body?.cancel();
    for (const device of [deviceA, deviceB]) {
      const response = await request(TEAM_API_ROUTES.me, device.sessionToken);
      assert.equal(response.status, 200);
      assert.equal(Schema.decodeUnknownSync(meSchema)(await response.json()).id, device.member.id);
    }
    const presence = await request(TEAM_API_ROUTES.team.presence, deviceB.sessionToken);
    assert.equal(presence.status, 200);
    const team = Schema.decodeUnknownSync(
      Schema.Struct({ members: Schema.Array(Schema.Struct({ id: Schema.String, role: Schema.String })) }),
    )(await presence.json());
    assert.equal(team.members.filter((member) => member.role === "owner").length, 1);
    assert.ok(team.members.some((member) => member.id === deviceB.member.id));
  });
  const { socketA, socketB } = await step("real_event_WebSocket_subprotocol_and_runtime_snapshot", async () => {
    const connect = async (token: string) => {
      const socket = new WebSocket(
        `${base.replace("http:", "ws:")}${TEAM_API_ROUTES.events}`,
        [TEAM_PROTOCOL_V1_WEBSOCKET, `openbot-token.${token}`],
        { headers: headers() },
      );
      sockets.push(socket);
      let snapshot = false;
      let invalidEvent = false;
      socket.on("error", () => undefined);
      socket.on("message", (data) => {
        try {
          const payload = Schema.decodeUnknownSync(Schema.Struct({ type: Schema.String }))(JSON.parse(data.toString()));
          if (payload.type === "runtime-snapshot") snapshot = true;
        } catch {
          invalidEvent = true;
        }
      });
      await once(socket, "open", { signal: AbortSignal.timeout(20_000) });
      assert.equal(socket.protocol, TEAM_PROTOCOL_V1_WEBSOCKET);
      socket.send(
        encodeTeamProtocolV1CurrentClientEvent({
          type: "agent-event-scope",
          includeConversations: true,
          capabilities: [...teamCapabilitiesForProtocol(9)],
        }),
      );
      socket.send(encodeTeamProtocolV1CurrentClientEvent({ type: "runtime-snapshot-request" }));
      await until("event_runtime_snapshot", () => snapshot || invalidEvent);
      assert.equal(invalidEvent, false);
      return socket;
    };
    const socketA = await connect(deviceA.sessionToken);
    const socketB = await connect(deviceB.sessionToken);
    return { socketA, socketB };
  });
  await step("real_HostService_revoke_closes_A_while_B_stays", async () => {
    await ipc(
      `window.openbot.privateAccess.revokeDevice(${JSON.stringify({ memberId: deviceA.member.id })})`,
      statusSchema,
    );
    await until("revoked_socket_closed", () => socketA.readyState === WebSocket.CLOSED);
    assert.equal(socketB.readyState, WebSocket.OPEN);
    const revoked = await request(TEAM_API_ROUTES.me, deviceA.sessionToken);
    assert.equal(revoked.status, 401);
    await revoked.body?.cancel();
    const retained = await request(TEAM_API_ROUTES.me, deviceB.sessionToken);
    assert.equal(retained.status, 200);
    await retained.body?.cancel();
  });
  await step("stop_owned_app_before_reinstall", stopApp);
  await step("reinstall_same_candidate_exits_successfully", () => runInstaller(installer, "/S"));
  await step("restart_owned_app_after_reinstall", () => startApp());
  await step("reinstall_preserves_host_identity", async () => {
    const status = await ipc("window.openbot.privateAccess.status()", statusSchema);
    assert.equal(status.hostId, first.hostId);
  });
  await step("reinstall_restores_configured_gateway_ready", async () => {
    const status = await ipc("window.openbot.privateAccess.status()", statusSchema);
    if (status.phase !== "ready")
      throw new SmokeFailure({
        code: "private_gateway_not_ready_after_reinstall",
        hostPhase:
          status.phase === "local-only" || status.phase === "starting" || status.phase === "error"
            ? status.phase
            : undefined,
      });
  });
  await step("reinstall_preserves_private_profile_canary", async () => {
    assert.equal(await readFile(profileCanary, "utf8"), "private profile persistence\n");
  });
  await step("reinstall_preserves_private_workspace_canary", async () => {
    assert.equal(await readFile(workspaceCanary, "utf8"), "private workspace persistence\n");
  });
  await step("reinstall_preserves_device_B_authenticated_session", async () => {
    const retained = await request(TEAM_API_ROUTES.me, deviceB.sessionToken);
    await retained.body?.cancel();
    if (retained.status !== 200)
      throw new SmokeFailure({
        code: "device_B_session_not_preserved",
        httpStatus: retained.status,
        expectedHttpStatus: 200,
      });
  });
  await step("reinstall_preserves_official_protocol_and_data_sentinels", () =>
    assertOfficialDataUnchanged("reinstall"),
  );
  await step("capture_reinstalled_private_app_screenshot", async () => {
    assert.ok(session);
    await session.page.screenshot({ path: join(output, "installed-app.png") });
  });
  const loginHostId = await step("explicit_profile_with_spaces_does_not_enable_startup", async () => {
    await stopApp();
    await startApp(loginProfileDirectory);
    assert.ok(existsSync(join(loginProfileDirectory, "openbot-private-owner-v1.json")));
    assert.equal((await ipc("window.openbot.getAppBehaviorPreference()", behaviorSchema)).launchAtLogin, false);
    assert.deepEqual(privateLoginRegistration(), { command: null, approval: null });
    const status = await ipc("window.openbot.privateAccess.status()", statusSchema);
    assert.ok(status.hostId && status.hostId !== first.hostId);
    return status.hostId;
  });
  await step("enable_existing_private_login_item_with_exact_profile_command", async () => {
    // Set ownership before the IPC call, so a lost reply still triggers scoped cleanup.
    loginItemMayBeOwned = true;
    const enabled = await ipc("window.openbot.setAppBehaviorPreference({ launchAtLogin: true })", behaviorSchema);
    assert.equal(enabled.launchAtLogin, true);
    assert.deepEqual(privateLoginRegistration(), { command: expectedLoginCommand, approval: null });
  });
  await step("relaunch_from_stored_login_argument_preserves_profile_and_enabled_readback", async () => {
    await stopApp();
    await startApp(loginProfileDirectory, true);
    assert.equal((await ipc("window.openbot.privateAccess.status()", statusSchema)).hostId, loginHostId);
    assert.equal((await ipc("window.openbot.getAppBehaviorPreference()", behaviorSchema)).launchAtLogin, true);
    assert.deepEqual(privateLoginRegistration(), { command: expectedLoginCommand, approval: null });
    report.loginItemChecks.preservedProfileWithSpaces = true;
  });
  await step("remove_only_CI_owned_private_login_item", removeOwnedLoginItem);
  await step("uninstall_only_owned_private_application_keeps_data", async () => {
    await stopApp();
    await runInstaller(uninstaller, `/S _?=${installDirectory}`);
    assert.ok(!existsSync(executable));
    assert.equal(await readFile(profileCanary, "utf8"), "private profile persistence\n");
    assert.equal(await readFile(workspaceCanary, "utf8"), "private workspace persistence\n");
    assert.ok(existsSync(join(loginProfileDirectory, "openbot-private-owner-v1.json")));
    assert.deepEqual(privateLoginRegistration(), { command: null, approval: null });
    await assertOfficialDataUnchanged("uninstall");
    installedByThisRun = false;
  });
  report.passed = true;
}

try {
  await main();
} catch (error) {
  report.failure ??= { step: "outside_named_step", ...safeFailure(error) };
  process.exitCode = 1;
} finally {
  await removeOwnedLoginItem().catch((error: unknown) => {
    report.cleanupFailures.push({ operation: "login_item", ...safeFailure(error) });
    process.exitCode = 1;
    report.passed = false;
  });
  await stopApp().catch((error: unknown) => {
    report.cleanupFailures.push({ operation: "owned_app", ...safeFailure(error) });
    process.exitCode = 1;
    report.passed = false;
  });
  // No broad delete, registry removal, or cleanup of a pre-existing installation/profile.
  await mkdir(output, { recursive: true });
  await writeFile(reportPath, `${redactText(JSON.stringify(report, null, 2))}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, report: reportPath })}\n`);
}
