import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { supportsTeamSemanticTags, teamCapabilitiesForProtocol } from "@openbot/contracts/team-protocol/current";
import { teamHttpCodec } from "@openbot/contracts/team-protocol/http-codecs";
import { optionalTeamEvent, optionalTeamEventToCurrent } from "@openbot/contracts/team-protocol/optional-events";
import { isQueueEditRoute, QueueEditRejectedError } from "@openbot/contracts/team-protocol/queue-edit-v1";
import { teamSideRouteCodec } from "@openbot/contracts/team-protocol/side-routes";
import {
  highestCommonTeamProtocol,
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_V1_WEBSOCKET,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol/v1";
import { encodeTeamProtocolV1CurrentClientEvent } from "@openbot/contracts/team-protocol/v1-adapter";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { decodeTeamProtocolV8BaseCurrentEvent } from "@openbot/contracts/team-protocol/v8-base-adapter";
import { decodeTeamProtocolSupportV9 } from "@openbot/contracts/team-protocol/v9";
import { sourceText } from "@openbot/i18n/source";
import { runTeamEffect } from "@openbot/team-client";
import { base64ToBytes, bytesToBase64, bytesToBase64Url } from "@openbot/team-client/base64";
import { verifyEd25519Base64Url } from "@openbot/team-client/ed25519";
import { MOBILE_ATTACHMENT_BYTES, type RemoteFileUpload } from "@openbot/team-client/remote-peer";
import { InactiveRequestError } from "../workspace/model/pending-approvals";
import { type PrivateHostIdentity, PrivateMobileError, type PrivatePairedHost } from "./private-contracts";
import type { PrivateNetworkPort, PrivateTransportEvents } from "./private-ports";

const FILE_LIMIT = MOBILE_ATTACHMENT_BYTES;
const JSON_LIMIT = 8 * 1024 * 1024;
const EVENT_LIMIT = 1024 * 1024;
const TIMEOUT_MS = 30_000;

export function privateTeamHeaders(appVersion: string, protocol = 9): Record<string, string> {
  return {
    [TEAM_PROTOCOL_VERSION_HEADER]: String(protocol),
    [TEAM_APP_VERSION_HEADER]: appVersion,
    [TEAM_CAPABILITIES_HEADER]: teamCapabilitiesForProtocol(protocol).join(","),
  };
}

/** Match the released host's RFC 5987 UTF-8 name and its malformed-header fallback. */
export function privateFileName(disposition: string | null, fallback: string): string {
  const encodedName = disposition?.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (encodedName) {
    try {
      return decodeURIComponent(encodedName);
    } catch {
      return fallback;
    }
  }
  return /filename="([^"\r\n]+)"/u.exec(disposition ?? "")?.[1] ?? fallback;
}

export async function verifyPrivateHost(
  network: PrivateNetworkPort,
  host: PrivateHostIdentity,
  appVersion = "private-mobile",
): Promise<void> {
  const challenge = bytesToBase64Url(network.randomBytes(24));
  const response = await network.fetch(
    new URL(`${TEAM_API_ROUTES.identity}?challenge=${challenge}`, host.publicOrigin).toString(),
    {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: privateTeamHeaders(appVersion),
    },
  );
  if (!response.ok) throw new PrivateMobileError("identity");
  const proof = JSON.parse(await boundedText(response, JSON_LIMIT));
  if (
    !isDynamicRecord(proof) ||
    proof.serverId !== host.hostId ||
    proof.challenge !== challenge ||
    proof.fingerprint !== host.hostFingerprint ||
    proof.publicKey !== host.hostPublicKey ||
    !isString(proof.signature) ||
    !(await runTeamEffect(
      verifyEd25519Base64Url(proof.signature, new TextEncoder().encode(challenge), host.hostPublicKey),
    ))
  )
    throw new PrivateMobileError("identity");
}

async function boundedBytes(
  response: Response,
  limit: number,
  tooLarge = sourceText("error.remote.invalidData"),
): Promise<Uint8Array<ArrayBuffer>> {
  const size = response.headers.get("content-length");
  if (size && Number(size) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(tooLarge);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new Error(tooLarge);
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function boundedText(response: Response, limit = JSON_LIMIT): Promise<string> {
  return new TextDecoder().decode(await boundedBytes(response, limit));
}

/** One host, one foreground connection. Recovery belongs to the existing ServerConnection owner. */
export class PrivateHttpTransport {
  readonly #network: PrivateNetworkPort;
  readonly #host: () => PrivatePairedHost;
  readonly #events: PrivateTransportEvents;
  readonly #version: string;
  readonly #requests = new Map<AbortController, { read: boolean; upload: boolean; transferId?: string }>();
  #socket: WebSocket | null = null;
  #generation = 0;
  #protocol = 9;
  #active = true;

  constructor(
    network: PrivateNetworkPort,
    host: () => PrivatePairedHost,
    events: PrivateTransportEvents,
    version: string,
  ) {
    this.#network = network;
    this.#host = host;
    this.#events = events;
    this.#version = version;
  }

  async connect(hostId: string, publicKey: string): Promise<void> {
    await this.disconnect();
    const generation = this.#generation;
    const host = this.#host();
    if (!this.#active || host.hostId !== hostId || host.hostPublicKey !== publicKey)
      throw new PrivateMobileError("identity");
    if (Date.parse(host.sessionExpiresAt) <= Date.now()) throw new PrivateMobileError("session");
    await verifyPrivateHost(this.#network, host, this.#version);
    const support = await this.request("GET", TEAM_API_ROUTES.compatibility, decodeTeamProtocolSupportV9);
    const protocol = highestCommonTeamProtocol({ minimum: 3, maximum: 9 }, support.protocol);
    if (protocol === null) throw new Error(sourceText("error.remote.mobileUpdateRequired"));
    this.#protocol = protocol;
    if (generation !== this.#generation || !this.#active) throw new PrivateMobileError("network");
    const url = new URL(TEAM_API_ROUTES.events, host.publicOrigin);
    url.protocol = "wss:";
    const socket = this.#network.socket(url.toString(), [
      TEAM_PROTOCOL_V1_WEBSOCKET,
      `openbot-token.${host.sessionToken}`,
    ]);
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      const timer = setTimeout(() => {
        socket.close();
        reject(new PrivateMobileError("network"));
      }, TIMEOUT_MS);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          if (this.#socket !== socket || generation !== this.#generation || !this.#active) {
            socket.close();
            reject(new PrivateMobileError("network"));
            return;
          }
          if (socket.protocol !== TEAM_PROTOCOL_V1_WEBSOCKET) {
            socket.close();
            reject(new PrivateMobileError("network"));
            return;
          }
          socket.send(
            encodeTeamProtocolV1CurrentClientEvent({
              type: "agent-event-scope",
              includeConversations: true,
              capabilities: [...teamCapabilitiesForProtocol(this.#protocol)],
            }),
          );
          socket.send(encodeTeamProtocolV1CurrentClientEvent({ type: "runtime-snapshot-request" }));
          opened = true;
          this.#events.connection({ hostId, state: "online", message: null });
          resolve();
        },
        { once: true },
      );
      socket.addEventListener("message", ({ data }) => {
        if (this.#socket !== socket || generation !== this.#generation) return;
        try {
          if (!isString(data) || new TextEncoder().encode(data).byteLength > EVENT_LIMIT)
            throw new PrivateMobileError("network");
          const value = JSON.parse(data);
          const optional = optionalTeamEvent(value, { agentTaskUiBlocks: true });
          const decoded = optional
            ? { kind: "known" as const, event: optionalTeamEventToCurrent(optional) }
            : decodeTeamProtocolV8BaseCurrentEvent(value);
          if (decoded.kind === "invalid") throw new Error(sourceText("error.remote.invalidData"));
          if (decoded.kind === "known") this.#events.event(hostId, decoded.event);
        } catch {
          socket.close(1002, "Invalid event");
        }
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        if (!opened) reject(new PrivateMobileError("network"));
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        if (!opened) reject(new PrivateMobileError("network"));
        if (this.#socket !== socket || generation !== this.#generation) return;
        this.#socket = null;
        this.#events.connection({ hostId, state: "offline", message: sourceText("error.remote.hostUnreachable") });
      });
    });
  }

  async request<T>(
    method: string,
    path: string,
    decode: (value: unknown) => T,
    body?: TeamProtocolV2Json,
    upload?: RemoteFileUpload,
    progress?: (fraction: number) => void,
    transferId?: string,
  ): Promise<T> {
    const host = this.#host();
    const url = new URL(path, host.publicOrigin);
    if (url.origin !== host.publicOrigin || !url.pathname.startsWith("/v1/"))
      throw new PrivateMobileError("unsupported");
    const read = method === "GET" || method === "HEAD";
    if (!this.#active && read) throw new PrivateMobileError("network");
    const controller = new AbortController();
    this.#requests.set(controller, { read, upload: Boolean(upload), transferId });
    const timer = setTimeout(() => controller.abort(), upload ? 10 * 60_000 : TIMEOUT_MS);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${host.sessionToken}`,
      ...privateTeamHeaders(this.#version, this.#protocol),
    };
    const side = teamSideRouteCodec(path);
    const codec = teamHttpCodec(this.#protocol);
    try {
      let payload: BodyInit | undefined;
      if (upload) {
        if (upload.base64.length > Math.ceil(FILE_LIMIT / 3) * 4)
          throw new Error(sourceText("error.remote.attachmentTooLarge"));
        const bytes = base64ToBytes(upload.base64);
        if (bytes.byteLength > FILE_LIMIT) throw new Error(sourceText("error.remote.attachmentTooLarge"));
        headers["Content-Type"] = upload.mimeType;
        payload = bytes.buffer;
      } else if (body !== undefined && !read) {
        headers["Content-Type"] = "application/json";
        payload = side
          ? JSON.stringify(side.request(path, body))
          : codec.encodeRequest(method, path, body, {
              preserveSemanticTags: supportsTeamSemanticTags(teamCapabilitiesForProtocol(this.#protocol)),
              agentCreateModel: true,
            });
      }
      progress?.(0);
      const response = await this.#network.fetch(url.toString(), {
        method,
        headers,
        body: payload,
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status === 409 && isQueueEditRoute(method, path))
        throw new QueueEditRejectedError(sourceText("error.remote.serverRequestFailed"));
      if (
        response.status === 409 &&
        method === "POST" &&
        (path === TEAM_API_ROUTES.respond.approval || path === TEAM_API_ROUTES.respond.prompt)
      )
        throw new InactiveRequestError(sourceText("error.remote.serverRequestFailed"));
      if (response.status === 401 || response.status === 403) {
        if (response.status === 401)
          this.#events.connection({
            hostId: host.hostId,
            state: "offline",
            message: sourceText("error.remote.accountSessionInactive"),
            code: "session_revoked",
          });
        throw new PrivateMobileError(response.status === 401 ? "session" : "unsupported");
      }
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      let value: unknown;
      if (response.status !== 204 && method !== "HEAD") {
        if (response.ok && (response.headers.has("content-disposition") || !contentType.includes("json"))) {
          const name = privateFileName(response.headers.get("content-disposition"), "download");
          value = {
            name,
            mimeType: contentType.split(";", 1)[0],
            base64: bytesToBase64(
              await boundedBytes(response, FILE_LIMIT, sourceText("error.remote.attachmentTooLarge")),
            ),
          };
        } else {
          const text = await boundedText(response);
          const input = text ? JSON.parse(text) : null;
          value = side
            ? side.response(path, response.status, input, {
                historyExtent: true,
                channelAttention: true,
                agentTaskUiBlocks: true,
              })
            : codec.decodeResponse(method, path, response.status, input);
        }
      }
      if (!response.ok) throw new Error(sourceText("error.remote.requestFailedStatus", { status: response.status }));
      progress?.(1);
      return decode(value);
    } finally {
      clearTimeout(timer);
      this.#requests.delete(controller);
    }
  }

  setActive(active: boolean): void {
    this.#active = active;
    if (!active) {
      this.#generation += 1;
      const socket = this.#socket;
      this.#socket = null;
      socket?.close(1000, "Background");
      for (const [controller, request] of this.#requests) if (request.read) controller.abort();
    }
  }

  cancelUpload(transferId: string): void {
    for (const [controller, request] of this.#requests)
      if (request.upload && request.transferId === transferId) controller.abort();
  }
  async disconnect(): Promise<void> {
    this.#generation += 1;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000, "Client stopped");
    for (const controller of this.#requests.keys()) controller.abort();
  }
  openBrowserView(): null {
    return null;
  }
}
