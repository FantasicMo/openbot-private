import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  type ConfigurePrivateAccessInput,
  type CreatePrivatePairingInput,
  DEFAULT_PRIVATE_GATEWAY_PORT,
  type PrivateAccessPairing,
  type PrivateAccessStatus,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { PrivateAccessGateway, PrivatePairingService } from "@openbot/private-access/node";
import { Effect, Result, Semaphore } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import type { HostService } from "./host-service";
import { readPreferenceFile, writePreferenceFile } from "./preference-file";
import { type PrivateHostFailure, privateHostFailure } from "./private-access-owner";
import type { RemoteWorkflowError } from "./remote-service-effects";
import type { TeamStore } from "./team-store";

interface PrivateSettings extends ConfigurePrivateAccessInput {
  labels: Record<string, string>;
}

interface PrivateHostOptions {
  directory: string;
  store: Pick<
    TeamStore,
    | "getIdentity"
    | "listMembers"
    | "listSessions"
    | "createInvite"
    | "acceptInvite"
    | "revokeInvite"
    | "authenticateSession"
  >;
  host: Pick<HostService, "startLoopbackOnly" | "removeMember" | "revokeSession">;
}

export function disabledPrivateAccessStatus(): PrivateAccessStatus {
  return {
    enabled: false,
    phase: "local-only",
    hostId: null,
    hostName: null,
    publicOrigin: null,
    gatewayPort: null,
    devices: [],
    errorCode: null,
  };
}

export function parsePrivateConfiguration(value: unknown): ConfigurePrivateAccessInput {
  if (!isDynamicRecord(value)) throw new Error("Private access configuration is required.");
  const gatewayPort = value.gatewayPort;
  if (
    typeof gatewayPort !== "number" ||
    !Number.isSafeInteger(gatewayPort) ||
    gatewayPort < 1024 ||
    gatewayPort > 65535
  )
    throw new Error("A private gateway port between 1024 and 65535 is required.");
  if (value.publicOrigin === null) return { publicOrigin: null, gatewayPort };
  if (!isString(value.publicOrigin)) throw new Error("A private HTTPS origin is required.");
  const origin = new URL(value.publicOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("The private origin must be HTTPS without a path or credentials.");
  return { publicOrigin: origin.origin, gatewayPort };
}

/** Local configuration and device labels only. TeamStore remains the member/session authority. */
export class PrivateAccessHostService extends EventEmitter<{ changed: [status: PrivateAccessStatus] }> {
  readonly #options: PrivateHostOptions;
  readonly #path: string;
  readonly #operations = Semaphore.makeUnsafe(1);
  readonly #writes = Semaphore.makeUnsafe(1);
  readonly #pendingLabels = new Map<string, { id: string; label: string }>();
  #settings: PrivateSettings = { publicOrigin: null, gatewayPort: DEFAULT_PRIVATE_GATEWAY_PORT, labels: {} };
  #phase: PrivateAccessStatus["phase"] = "local-only";
  #errorCode: string | null = null;
  #readOnly = false;
  #creatingLabel = "";
  #gateway: PrivateAccessGateway<RemoteWorkflowError | PrivateHostFailure> | null = null;
  #pairing: PrivatePairingService<RemoteWorkflowError | PrivateHostFailure> | null = null;

  constructor(options: PrivateHostOptions) {
    super();
    this.#options = options;
    this.#path = join(options.directory, "openbot-private-access-v1.json");
  }

  getStatus(): PrivateAccessStatus {
    const identity = this.#options.store.getIdentity();
    const sessions = this.#options.store.listSessions();
    return {
      enabled: true,
      phase: this.#phase,
      hostId: identity?.serverId ?? null,
      hostName: identity?.serverName ?? null,
      publicOrigin: this.#settings.publicOrigin,
      gatewayPort: this.#settings.gatewayPort,
      devices: this.#options.store.listMembers().flatMap((member) =>
        member.role === "owner"
          ? []
          : [
              {
                memberId: member.id,
                label: this.#settings.labels[member.id] ?? member.name ?? member.username,
                role: member.role,
                disabled: member.disabled,
                sessionIds: sessions.filter((session) => session.memberId === member.id).map((session) => session.id),
              },
            ],
      ),
      errorCode: this.#errorCode,
    };
  }

  readonly initialize = Effect.fn("PrivateAccessHost.initialize")(
    function* (this: PrivateAccessHostService) {
      const loaded = yield* readPreferenceFile(this.#path, decodeSettings).pipe(Effect.result);
      if (Result.isSuccess(loaded)) this.#settings = loaded.success;
      else if (!isMissingFileError(loaded.failure.cause)) {
        this.#readOnly = true;
        this.#phase = "error";
        this.#errorCode = "invalid_configuration";
      }
      yield* this.#options.host.startLoopbackOnly().pipe(Effect.mapError(() => privateHostFailure("operation_failed")));
      if (!this.#readOnly) yield* this.#restartGateway();
      this.#changed();
      return this.getStatus();
    },
    (operation) => this.#operations.withPermit(operation),
  ).bind(this);

  readonly configure = Effect.fn("PrivateAccessHost.configure")(
    function* (this: PrivateAccessHostService, input: ConfigurePrivateAccessInput) {
      if (this.#readOnly) return yield* privateHostFailure("invalid_configuration");
      const previous = this.#settings;
      this.#settings = { ...this.#settings, ...input };
      const saved = yield* this.#save().pipe(Effect.result);
      if (Result.isFailure(saved)) {
        this.#settings = previous;
        return yield* saved.failure;
      }
      yield* this.#restartGateway();
      this.#changed();
      return this.getStatus();
    },
    (operation) => this.#operations.withPermit(operation).pipe(Effect.uninterruptible),
  ).bind(this);

  readonly createPairing = Effect.fn("PrivateAccessHost.createPairing")(
    function* (
      this: PrivateAccessHostService,
      input: CreatePrivatePairingInput,
    ): Effect.fn.Return<PrivateAccessPairing, PrivateHostFailure> {
      const identity = this.#options.store.getIdentity();
      const pairing = this.#pairing;
      const publicOrigin = this.#settings.publicOrigin;
      if (!identity || !pairing || !publicOrigin || this.#phase !== "ready")
        return yield* privateHostFailure("invalid_configuration");
      this.#creatingLabel = input.label;
      const offer = yield* pairing
        .createOffer(input.role)
        .pipe(Effect.mapError(() => privateHostFailure("operation_failed")));
      return {
        ...offer,
        publicOrigin,
        hostId: identity.serverId,
        hostName: identity.serverName,
        fingerprint: identity.fingerprint,
        publicKey: identity.publicKey,
      };
    },
    (operation) => this.#operations.withPermit(operation).pipe(Effect.uninterruptible),
  ).bind(this);

  readonly revokeDevice = Effect.fn("PrivateAccessHost.revokeDevice")(
    function* (this: PrivateAccessHostService, memberId: string) {
      yield* this.#options.host
        .removeMember(memberId)
        .pipe(Effect.mapError(() => privateHostFailure("operation_failed")));
      delete this.#settings.labels[memberId];
      if (!this.#readOnly) yield* this.#save();
      this.#changed();
      return this.getStatus();
    },
    (operation) => this.#operations.withPermit(operation).pipe(Effect.uninterruptible),
  ).bind(this);

  readonly revokeSession = Effect.fn("PrivateAccessHost.revokeSession")(
    function* (this: PrivateAccessHostService, sessionId: string) {
      yield* this.#options.host
        .revokeSession(sessionId)
        .pipe(Effect.mapError(() => privateHostFailure("operation_failed")));
      this.#changed();
      return this.getStatus();
    },
    (operation) => this.#operations.withPermit(operation).pipe(Effect.uninterruptible),
  ).bind(this);

  readonly shutdown = Effect.fn("PrivateAccessHost.shutdown")(
    function* (this: PrivateAccessHostService) {
      if (this.#gateway)
        yield* this.#gateway.stop().pipe(Effect.mapError(() => privateHostFailure("operation_failed")));
      this.#gateway = null;
      this.#pairing = null;
      this.#pendingLabels.clear();
    },
    (operation) => this.#operations.withPermit(operation).pipe(Effect.uninterruptible),
  ).bind(this);

  readonly #restartGateway = Effect.fn("PrivateAccessHost.restartGateway")(function* (this: PrivateAccessHostService) {
    if (this.#gateway) yield* this.#gateway.stop().pipe(Effect.mapError(() => privateHostFailure("operation_failed")));
    this.#gateway = null;
    this.#pairing = null;
    this.#pendingLabels.clear();
    this.#errorCode = null;
    if (!this.#settings.publicOrigin) {
      this.#phase = "local-only";
      return;
    }
    this.#phase = "starting";
    this.#changed();
    const { store, host } = this.#options;
    const pairing = new PrivatePairingService<RemoteWorkflowError | PrivateHostFailure>({
      authority: {
        createInvite: (role) =>
          store.createInvite(role).pipe(
            Effect.tap((invite) =>
              Effect.sync(() => {
                this.#pendingLabels.set(invite.token, { id: invite.id, label: this.#creatingLabel });
              }),
            ),
          ),
        acceptInvite: (token, username, password) =>
          store.acceptInvite(token, username, password).pipe(
            Effect.tap((accepted) => {
              this.#settings.labels[accepted.member.id] =
                this.#pendingLabels.get(token)?.label || accepted.member.username;
              this.#changed();
              // The authority has committed. A label write must not hide the device credential.
              return this.#save().pipe(Effect.catch(() => Effect.void));
            }),
          ),
        revokeInvite: (id) =>
          store.revokeInvite(id).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                for (const [token, pending] of this.#pendingLabels)
                  if (pending.id === id) this.#pendingLabels.delete(token);
              }),
            ),
          ),
        authenticateSession: (token) => store.authenticateSession(token),
        revokeSession: (id) => host.revokeSession(id),
        removeMember: (id) => host.removeMember(id),
      },
    });
    const status = yield* host.startLoopbackOnly().pipe(Effect.mapError(() => privateHostFailure("operation_failed")));
    if (!status.apiUrl) return yield* privateHostFailure("operation_failed");
    const internal = new URL(status.apiUrl);
    const gateway = new PrivateAccessGateway({
      upstreamOrigin: `http://127.0.0.1:${internal.port}`,
      publicOrigin: this.#settings.publicOrigin,
      port: this.#settings.gatewayPort,
      pairing,
    });
    this.#pairing = pairing;
    this.#gateway = gateway;
    const started = yield* gateway.start().pipe(Effect.result);
    if (Result.isFailure(started)) {
      this.#phase = "error";
      this.#errorCode = "operation_failed";
    } else this.#phase = "ready";
  });

  #save() {
    return this.#writes.withPermit(
      Effect.suspend(() => {
        if (this.#readOnly) return Effect.fail(privateHostFailure("invalid_configuration"));
        return writePreferenceFile(this.#path, { version: 1, ...this.#settings }).pipe(
          Effect.mapError(() => privateHostFailure("operation_failed")),
        );
      }),
    );
  }

  #changed(): void {
    this.emit("changed", this.getStatus());
  }
}

function decodeSettings(value: unknown): PrivateSettings {
  if (!isDynamicRecord(value) || value.version !== 1 || !isDynamicRecord(value.labels))
    throw new Error("Invalid private access settings.");
  const config = parsePrivateConfiguration(value);
  const labels: Record<string, string> = {};
  for (const [memberId, label] of Object.entries(value.labels)) {
    if (!isString(label) || label.length > 80 || memberId.length > 128)
      throw new Error("Invalid private device label.");
    labels[memberId] = label;
  }
  return { ...config, labels };
}
