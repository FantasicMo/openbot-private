// CI-only: install this candidate, drive its real renderer/Team API, reinstall, and uninstall it.
// Uses only a new private installation/profile. Never runs the official installer cleanup script.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { createOpenBotLogger, registerSecretValue } from "@openbot/logging";
import { PRIVATE_PAIRING_PATH, PrivateHostPairingOfferSchema } from "@openbot/private-access/contracts";
import { Schema } from "effect";
import { WebSocket } from "ws";
import { parse as parseYaml } from "yaml";
import { type AutomationSession, connectToDevApp } from "./dev-automation/cdp-client";

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
const report: {
  passed: boolean;
  scope: string;
  steps: { name: string; passed: boolean }[];
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

async function step<A>(name: string, action: () => Promise<A>): Promise<A> {
  try {
    const result = await action();
    report.steps.push({ name, passed: true });
    return result;
  } catch {
    report.steps.push({ name, passed: false });
    // No upstream error, page text, request body or credential is copied into the report or log.
    throw new Error(`The ${name} step failed.`);
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
  const [code] = await once(installerProcess, "exit", { signal: AbortSignal.timeout(300_000) }).catch(
    (error: unknown) => {
      if (installerProcess.exitCode === null) installerProcess.kill();
      throw error;
    },
  );
  assert.equal(code, 0, "The silent private installer must exit successfully.");
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

async function until(ready: () => boolean | Promise<boolean>): Promise<void> {
  const limit = Date.now() + 180_000;
  while (!(await ready())) {
    if (launchFailed) throw new Error("The owned app could not start.");
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error("The owned app exited.");
    if (Date.now() >= limit) throw new Error("The requested application state did not arrive.");
    await poll(150);
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
    stdio: "ignore",
  });
  child.once("error", () => {
    launchFailed = true;
  });
  await until(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch {
      return false;
    }
  });
  await until(async () => {
    try {
      session = await connectToDevApp(port, logger, {
        ownerPid: child?.pid,
        pageSelector: "openbot-app://app/index.html",
      });
      return true;
    } catch {
      return false;
    }
  });
  await until(async () => {
    try {
      const status = await ipc("window.openbot.privateAccess.status()", statusSchema);
      return status.enabled && status.hostId !== null;
    } catch {
      return false;
    }
  });
}

async function stopApp(): Promise<void> {
  for (const socket of sockets.splice(0)) socket.terminate();
  const attached = session;
  session = null;
  if (attached) await attached.close().catch(() => undefined);
  const owned = child;
  child = null;
  activeProfileDirectory = null;
  if (!owned || owned.exitCode !== null || owned.signalCode !== null || owned.pid === undefined) return;
  // Only the PID returned by this script's spawn, including its own child tree.
  const exited = once(owned, "exit", { signal: AbortSignal.timeout(30_000) });
  try {
    execFileSync("taskkill.exe", ["/PID", String(owned.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    if (owned.exitCode === null && owned.signalCode === null) throw new Error("The owned app did not stop.");
  }
  await exited;
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
      await until(() => snapshot || invalidEvent);
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
    await until(() => socketA.readyState === WebSocket.CLOSED);
    assert.equal(socketB.readyState, WebSocket.OPEN);
    const revoked = await request(TEAM_API_ROUTES.me, deviceA.sessionToken);
    assert.equal(revoked.status, 401);
    await revoked.body?.cancel();
    const retained = await request(TEAM_API_ROUTES.me, deviceB.sessionToken);
    assert.equal(retained.status, 200);
    await retained.body?.cancel();
  });
  await step("reinstall_same_candidate_preserves_host_profile_and_device_B", async () => {
    await stopApp();
    await runInstaller(installer, "/S");
    await startApp();
    const status = await ipc("window.openbot.privateAccess.status()", statusSchema);
    assert.equal(status.hostId, first.hostId);
    assert.equal(status.phase, "ready");
    assert.equal(await readFile(profileCanary, "utf8"), "private profile persistence\n");
    assert.equal(await readFile(workspaceCanary, "utf8"), "private workspace persistence\n");
    const retained = await request(TEAM_API_ROUTES.me, deviceB.sessionToken);
    assert.equal(retained.status, 200);
    await retained.body?.cancel();
    await assertOfficialDataUnchanged("reinstall");
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
} catch {
  process.exitCode = 1;
} finally {
  await removeOwnedLoginItem().catch(() => {
    process.exitCode = 1;
    report.passed = false;
  });
  await stopApp().catch(() => {
    process.exitCode = 1;
    report.passed = false;
  });
  // No broad delete, registry removal, or cleanup of a pre-existing installation/profile.
  await mkdir(output, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ passed: report.passed, report: reportPath })}\n`);
}
