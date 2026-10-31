import {
  type ClientRequest,
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { type Duplex, Transform } from "node:stream";
import { Effect, Layer, ManagedRuntime, Result, Schema, Semaphore } from "effect";
import {
  PRIVATE_PAIRING_PATH,
  PrivateAccessError,
  type PrivateAccessErrorCode,
  PrivatePairingRequestSchema,
} from "./contracts";
import type { PrivatePairingService } from "./pairing";

const HEADER_BYTES_LIMIT = 16 * 1024;
const PAIRING_BYTES_LIMIT = 4096;
const BODY_BYTES_LIMIT = 100 * 1024 * 1024;
const CONNECTION_LIMIT = 32;
const IDLE_TIMEOUT_MS = 60_000;
const decodePairing = Schema.decodeUnknownSync(PrivatePairingRequestSchema);
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface PrivateAccessGatewayOptions<E> {
  /** Exactly http://127.0.0.1:<port>, without credentials, path, query or fragment. */
  upstreamOrigin: string;
  /** The configured HTTPS Tailscale Serve origin. No request can replace it. */
  publicOrigin: string;
  /** A fixed loopback port in production. Zero is permitted for isolated service checks. */
  port: number;
  pairing: PrivatePairingService<E>;
}

export interface PrivateAccessGatewayAddress {
  host: "127.0.0.1";
  port: number;
  publicOrigin: string;
}

/**
 * Serve terminates TLS. This listener accepts only loopback, has one immutable upstream, and never
 * adds authorization. Native pipe backpressure preserves HTTP binary bodies and WebSocket frames.
 */
export class PrivateAccessGateway<E> {
  readonly #options: PrivateAccessGatewayOptions<E>;
  readonly #lifecycle = Semaphore.makeUnsafe(1);
  readonly #runtime = ManagedRuntime.make(Layer.empty);
  readonly #sockets = new Set<Socket | Duplex>();
  readonly #upstreamRequests = new Set<ClientRequest>();
  readonly #pairingOperations = new Set<Promise<void>>();
  #server: Server | null = null;
  #address: PrivateAccessGatewayAddress | null = null;
  #upstream: URL | null = null;
  #public: URL | null = null;
  #closed = false;

  constructor(options: PrivateAccessGatewayOptions<E>) {
    this.#options = options;
  }

  readonly start = Effect.fn("PrivateGateway.start")(
    function* (this: PrivateAccessGateway<E>) {
      if (this.#closed) return yield* new PrivateAccessError({ code: "gateway_closed" });
      if (this.#address) return this.#address;
      const configuration = yield* Effect.try({
        try: () => validateConfiguration(this.#options),
        catch: (cause) => new PrivateAccessError({ code: "invalid_configuration", cause }),
      });
      this.#upstream = configuration.upstream;
      this.#public = configuration.publicOrigin;
      const server = createServer({ maxHeaderSize: HEADER_BYTES_LIMIT }, (request, response) =>
        this.#handleHttp(request, response),
      );
      server.maxConnections = CONNECTION_LIMIT;
      server.maxHeadersCount = 64;
      server.headersTimeout = 10_000;
      server.requestTimeout = 10 * 60_000;
      server.keepAliveTimeout = 5000;
      server.setTimeout(IDLE_TIMEOUT_MS, (socket) => socket.destroy());
      server.on("connection", (socket) => this.#trackSocket(socket));
      server.on("upgrade", (request, socket, head) => this.#handleUpgrade(request, socket, head));
      server.on("clientError", (_error, socket) => {
        if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        else socket.destroy();
      });
      this.#server = server;
      const port = yield* Effect.tryPromise({
        try: () => listen(server, this.#options.port),
        catch: (cause) => new PrivateAccessError({ code: "gateway_unavailable", cause }),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            this.#server = null;
          }),
        ),
      );
      this.#address = { host: "127.0.0.1", port, publicOrigin: configuration.publicOrigin.origin };
      return this.#address;
    },
    (operation) => this.#lifecycle.withPermit(operation).pipe(Effect.uninterruptible),
  ).bind(this);

  readonly stop = Effect.fn("PrivateGateway.stop")(
    function* (this: PrivateAccessGateway<E>) {
      if (this.#closed) return;
      this.#closed = true;
      const server = this.#server;
      this.#server = null;
      this.#address = null;
      const close = server
        ? Effect.tryPromise({
            try: () =>
              new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                for (const request of this.#upstreamRequests) request.destroy();
                for (const socket of this.#sockets) socket.destroy();
              }),
            catch: (cause) => new PrivateAccessError({ code: "gateway_unavailable", cause }),
          })
        : Effect.void;
      // All cleanup steps run, also when an authority or a server close fails.
      const closed = yield* close.pipe(Effect.result);
      yield* Effect.tryPromise({
        try: () => Promise.all([...this.#pairingOperations]),
        catch: (cause) => new PrivateAccessError({ code: "gateway_unavailable", cause }),
      }).pipe(Effect.result);
      const paired = yield* this.#options.pairing.close().pipe(Effect.result);
      yield* this.#runtime.disposeEffect;
      if (Result.isFailure(closed)) return yield* closed.failure;
      if (Result.isFailure(paired)) return yield* paired.failure;
    },
    (operation) => this.#lifecycle.withPermit(operation).pipe(Effect.uninterruptible),
  ).bind(this);

  #handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const path = this.#requestPath(request);
    if (!path) {
      rejectHttp(request, response, 400, "invalid_request");
      return;
    }
    if (path === PRIVATE_PAIRING_PATH) {
      if (request.method !== "POST") {
        rejectHttp(request, response, 404, "invalid_request");
        return;
      }
      const operation = this.#redeem(request, response).finally(() => this.#pairingOperations.delete(operation));
      this.#pairingOperations.add(operation);
      return;
    }
    if (!path.startsWith("/v1/")) {
      rejectHttp(request, response, 404, "invalid_request");
      return;
    }
    if (request.headers.upgrade) {
      rejectHttp(request, response, 400, "invalid_request");
      return;
    }
    const length = request.headers["content-length"];
    if (length && (!/^\d+$/u.test(length) || Number(length) > BODY_BYTES_LIMIT)) {
      rejectHttp(request, response, 413, "invalid_request");
      return;
    }
    const upstream = this.#proxyRequest(request, path, false);
    // A client can leave before the host sends headers. Stop that HTTP transport immediately;
    // this does not call a host operation to cancel an already accepted agent task.
    response.on("close", () => upstream.destroy());
    upstream.on("response", (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming.headers, false));
      const bounded = byteLimit(BODY_BYTES_LIMIT);
      bounded.on("error", () => {
        incoming.destroy();
        response.destroy();
      });
      incoming.on("error", () => response.destroy());
      response.on("close", () => incoming.destroy());
      incoming.pipe(bounded).pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) rejectHttp(request, response, 502, "gateway_unavailable");
      else response.destroy();
    });
    const bounded = byteLimit(BODY_BYTES_LIMIT);
    bounded.on("error", () => {
      upstream.destroy();
      if (!response.headersSent) rejectHttp(request, response, 413, "invalid_request");
      else response.destroy();
    });
    request.on("aborted", () => upstream.destroy());
    request.on("error", () => upstream.destroy());
    request.pipe(bounded).pipe(upstream);
  }

  async #redeem(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
        return rejectHttp(request, response, 415, "invalid_request");
      const body = await readPairingBody(request);
      if (body === null) return rejectHttp(request, response, 413, "invalid_request");
      const input = decodePairing(JSON.parse(body));
      const result = await this.#runtime.runPromise(this.#options.pairing.redeem(input).pipe(Effect.result));
      if (Result.isFailure(result)) {
        const status =
          result.failure.code === "pairing_refused" ? 401 : result.failure.code === "invalid_request" ? 400 : 503;
        return rejectHttp(request, response, status, result.failure.code);
      }
      response.writeHead(201, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(result.success));
    } catch {
      if (!response.headersSent) rejectHttp(request, response, 400, "invalid_request");
      else response.destroy();
    }
  }

  #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = this.#requestPath(request);
    if (
      !path?.startsWith("/v1/") ||
      request.method !== "GET" ||
      request.headers.upgrade?.toLowerCase() !== "websocket"
    ) {
      rejectSocket(socket, 400);
      return;
    }
    const upstream = this.#proxyRequest(request, path, true);
    upstream.on("upgrade", (incoming, target, upstreamHead) => {
      this.#trackSocket(target);
      target.setTimeout(IDLE_TIMEOUT_MS, () => target.destroy());
      socket.on("error", () => target.destroy());
      target.on("error", () => socket.destroy());
      socket.on("close", () => target.destroy());
      target.on("close", () => socket.destroy());
      socket.write(upgradeHead(incoming));
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    upstream.on("response", (incoming) => {
      incoming.resume();
      rejectSocket(socket, incoming.statusCode ?? 502);
    });
    upstream.on("error", () => rejectSocket(socket, 502));
    socket.on("close", () => upstream.destroy());
    upstream.end();
  }

  #requestPath(request: IncomingMessage): string | null {
    if (this.#closed || !this.#address || !this.#public || !this.#upstream) return null;
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::ffff:127.0.0.1")
      return null;
    const host = request.headers.host;
    if (
      host !== this.#public.host &&
      host !== `127.0.0.1:${this.#address.port}` &&
      host !== `localhost:${this.#address.port}`
    )
      return null;
    const raw = request.url ?? "";
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("#")) return null;
    try {
      const decoded = decodeURIComponent(raw.split("?", 1)[0] ?? "");
      if (
        decoded.includes("\\") ||
        decoded.startsWith("//") ||
        Array.from(decoded).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      )
        return null;
      if (decoded.split("/").some((part) => part === "." || part === "..")) return null;
      const target = new URL(raw, this.#upstream);
      if (target.origin !== this.#upstream.origin) return null;
      return `${target.pathname}${target.search}`;
    } catch {
      return null;
    }
  }

  #proxyRequest(request: IncomingMessage, path: string, upgrade: boolean): ClientRequest {
    const target = this.#upstream;
    const publicOrigin = this.#public;
    if (!target || !publicOrigin) throw new Error("The private gateway has no configured upstream.");
    const headers = forwardHeaders(request.headers, upgrade);
    headers.host = target.host;
    headers["x-forwarded-host"] = publicOrigin.host;
    headers["x-forwarded-proto"] = "https";
    const outgoing = httpRequest({
      hostname: "127.0.0.1",
      port: target.port,
      method: request.method,
      path,
      headers,
      timeout: IDLE_TIMEOUT_MS,
      maxHeaderSize: HEADER_BYTES_LIMIT,
      agent: false,
    });
    this.#upstreamRequests.add(outgoing);
    outgoing.on("close", () => this.#upstreamRequests.delete(outgoing));
    outgoing.on("timeout", () => outgoing.destroy());
    return outgoing;
  }

  #trackSocket(socket: Socket | Duplex): void {
    this.#sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.#sockets.delete(socket));
  }
}

function validateConfiguration<E>(options: PrivateAccessGatewayOptions<E>): { upstream: URL; publicOrigin: URL } {
  const upstream = new URL(options.upstreamOrigin);
  const publicOrigin = new URL(options.publicOrigin);
  if (
    upstream.protocol !== "http:" ||
    upstream.hostname !== "127.0.0.1" ||
    !upstream.port ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== "/" ||
    upstream.search ||
    upstream.hash
  )
    throw new Error("The upstream must be one loopback HTTP origin.");
  if (
    publicOrigin.protocol !== "https:" ||
    publicOrigin.username ||
    publicOrigin.password ||
    publicOrigin.pathname !== "/" ||
    publicOrigin.search ||
    publicOrigin.hash
  )
    throw new Error("The public origin must be one HTTPS origin.");
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new Error("The gateway port is invalid.");
  return { upstream, publicOrigin };
}

function forwardHeaders(headers: IncomingMessage["headers"], upgrade: boolean): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  const connection = new Set(headers.connection?.split(",").map((name) => name.trim().toLowerCase()) ?? []);
  for (const [name, value] of Object.entries(headers)) {
    if (
      HOP_HEADERS.has(name) ||
      connection.has(name) ||
      name === "forwarded" ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("tailscale-")
    )
      continue;
    result[name] = value;
  }
  if (upgrade) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
}

function responseHeaders(headers: IncomingMessage["headers"], upgrade: boolean): OutgoingHttpHeaders {
  const result = forwardHeaders(headers, upgrade);
  delete result["x-forwarded-host"];
  delete result["x-forwarded-proto"];
  return result;
}

function upgradeHead(response: IncomingMessage): string {
  const lines = ["HTTP/1.1 101 Switching Protocols"];
  for (const [name, value] of Object.entries(responseHeaders(response.headers, true))) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [String(value)]) lines.push(`${name}: ${item}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function rejectSocket(socket: Duplex, status: number): void {
  if (!socket.writable || socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} Request Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function rejectHttp(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  code: PrivateAccessErrorCode,
): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "close",
  });
  response.end(JSON.stringify({ error: code, code }), () => request.destroy());
}

function byteLimit(maximum: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      if (total > maximum) done(new Error("The private gateway body limit was exceeded."));
      else done(null, chunk);
    },
  });
}

async function readPairingBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > PAIRING_BYTES_LIMIT) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("The private gateway has no loopback address."));
        return;
      }
      resolve(address.port);
    });
  });
}
