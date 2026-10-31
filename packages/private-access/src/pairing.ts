import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Effect, Result, Semaphore } from "effect";
import {
  PRIVATE_ACCESS_PROTOCOL,
  PrivateAccessError,
  type PrivateAuthenticatedMember,
  type PrivatePairingAuthority,
  type PrivatePairingOffer,
  type PrivatePairingRequest,
  type PrivatePairingRole,
} from "./contracts";

const DEFAULT_TTL_MS = 2 * 60_000;
const MAXIMUM_TTL_MS = 10 * 60_000;
const MAXIMUM_OFFERS = 8;

interface PendingOffer {
  inviteId: string;
  inviteToken: string;
  secretHash: Buffer;
  expiresAt: number;
}

export interface PrivatePairingOptions<E> {
  authority: PrivatePairingAuthority<E>;
  /** Injected only by deterministic service checks. Production reads the system clock. */
  now?: () => number;
}

/**
 * A bounded set of temporary handles for TeamStore invitations. It keeps neither roles nor device
 * sessions. Raw invite tokens never leave this service. Expiry is checked before each redemption;
 * the next operation and close revoke the underlying unused invitations.
 */
export class PrivatePairingService<E> {
  readonly #authority: PrivatePairingAuthority<E>;
  readonly #now: () => number;
  readonly #offers = new Map<string, PendingOffer>();
  readonly #pendingRevocations = new Set<string>();
  readonly #operations = Semaphore.makeUnsafe(1);
  #closed = false;

  constructor(options: PrivatePairingOptions<E>) {
    this.#authority = options.authority;
    this.#now = options.now ?? Date.now;
  }

  readonly createOffer = Effect.fn("PrivatePairing.createOffer")(
    function* (this: PrivatePairingService<E>, role: PrivatePairingRole, ttlMs = DEFAULT_TTL_MS) {
      if (this.#closed) return yield* new PrivateAccessError({ code: "gateway_closed" });
      if (
        (role !== "admin" && role !== "member") ||
        !Number.isSafeInteger(ttlMs) ||
        ttlMs < 1 ||
        ttlMs > MAXIMUM_TTL_MS
      )
        return yield* new PrivateAccessError({ code: "invalid_request" });
      yield* this.#expireOffers();
      if (this.#offers.size >= MAXIMUM_OFFERS) return yield* new PrivateAccessError({ code: "pairing_unavailable" });
      const invite = yield* this.#authority
        .createInvite(role)
        .pipe(Effect.mapError((cause) => new PrivateAccessError({ code: "authority_failed", cause })));
      const inviteExpiry = Date.parse(invite.expiresAt);
      if (
        invite.permanent ||
        invite.email !== null ||
        invite.role !== role ||
        inviteExpiry <= this.#now() ||
        !Number.isFinite(inviteExpiry)
      ) {
        yield* this.#revokeInvite(invite.id);
        return yield* new PrivateAccessError({ code: "authority_failed" });
      }
      const offerId = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const expiresAt = Math.min(this.#now() + ttlMs, inviteExpiry);
      this.#offers.set(offerId, {
        inviteId: invite.id,
        inviteToken: invite.token,
        secretHash: hashSecret(secret),
        expiresAt,
      });
      return {
        protocol: PRIVATE_ACCESS_PROTOCOL,
        offerId,
        secret,
        expiresAt: new Date(expiresAt).toISOString(),
      } satisfies PrivatePairingOffer;
    },
    (operation) => this.#operations.withPermit(operation).pipe(Effect.uninterruptible),
  ).bind(this);

  readonly redeem = Effect.fn("PrivatePairing.redeem")(
    function* (this: PrivatePairingService<E>, input: PrivatePairingRequest) {
      if (this.#closed) return yield* new PrivateAccessError({ code: "gateway_closed" });
      yield* this.#expireOffers();
      const offer = this.#offers.get(input.offerId);
      if (!offer || !timingSafeEqual(offer.secretHash, hashSecret(input.secret)))
        return yield* new PrivateAccessError({ code: "pairing_refused" });
      // Remove before the authority yields. Concurrent callers can never spend one offer twice.
      this.#offers.delete(input.offerId);
      const accepted = yield* this.#authority
        .acceptInvite(offer.inviteToken, input.username, input.password)
        .pipe(Effect.result);
      yield* this.#revokeInvite(offer.inviteId).pipe(Effect.result);
      if (Result.isFailure(accepted))
        return yield* new PrivateAccessError({ code: "pairing_refused", cause: accepted.failure });
      // acceptInvite committed the member and its session. Invitation cleanup cannot hide that
      // credential or turn the committed join into a failed response. Failed cleanup stays queued.
      return accepted.success satisfies PrivateAuthenticatedMember;
    },
    (operation) => this.#operations.withPermit(operation).pipe(Effect.uninterruptible),
  ).bind(this);

  /** Local host operation. The authority decides which member may be removed and ends its access. */
  readonly revokeDevice = Effect.fn("PrivatePairing.revokeDevice")((memberId: string) =>
    this.#authority
      .removeMember(memberId)
      .pipe(Effect.mapError((cause) => new PrivateAccessError({ code: "authority_failed", cause }))),
  );

  /** Local host operation. Session ownership and resource cleanup remain in the host adapter. */
  readonly revokeSession = Effect.fn("PrivatePairing.revokeSession")((sessionId: string) =>
    this.#authority
      .revokeSession(sessionId)
      .pipe(Effect.mapError((cause) => new PrivateAccessError({ code: "authority_failed", cause }))),
  );

  readonly close = Effect.fn("PrivatePairing.close")(
    function* (this: PrivatePairingService<E>) {
      this.#closed = true;
      const invites = new Set([...this.#offers.values()].map((offer) => offer.inviteId));
      for (const id of this.#pendingRevocations) invites.add(id);
      this.#offers.clear();
      yield* this.#revokeOffers([...invites]);
    },
    (operation) => this.#operations.withPermit(operation).pipe(Effect.uninterruptible),
  ).bind(this);

  readonly #expireOffers = Effect.fn("PrivatePairing.expireOffers")(function* (this: PrivatePairingService<E>) {
    const expired = new Set(this.#pendingRevocations);
    for (const [id, offer] of this.#offers) {
      if (offer.expiresAt > this.#now()) continue;
      this.#offers.delete(id);
      expired.add(offer.inviteId);
    }
    yield* this.#revokeOffers([...expired]);
  });

  readonly #revokeOffers = Effect.fn("PrivatePairing.revokeOffers")(function* (
    this: PrivatePairingService<E>,
    inviteIds: readonly string[],
  ) {
    const attempts = yield* Effect.forEach(inviteIds, (id) => this.#revokeInvite(id).pipe(Effect.result));
    for (const attempt of attempts) if (Result.isFailure(attempt)) return yield* attempt.failure;
  });

  #revokeInvite(inviteId: string) {
    return this.#authority.revokeInvite(inviteId).pipe(
      Effect.tap(() => Effect.sync(() => this.#pendingRevocations.delete(inviteId))),
      Effect.tapError(() => Effect.sync(() => this.#pendingRevocations.add(inviteId))),
      Effect.mapError((cause) => new PrivateAccessError({ code: "authority_failed", cause })),
    );
  }
}

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}
