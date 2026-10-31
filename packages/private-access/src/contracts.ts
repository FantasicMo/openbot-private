// Portable entry point. Keep Node, Electron and platform storage out of this module.
import type { TeamMemberSummary, TeamRole } from "@openbot/contracts/ipc";
import { type Effect, Schema } from "effect";

export const PRIVATE_PAIRING_PATH = "/private-access/v1/pair";
export const PRIVATE_ACCESS_PROTOCOL = 1;
export type PrivatePairingRole = Exclude<TeamRole, "owner">;

const identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const PrivatePairingRequestSchema = Schema.Struct({
  offerId: identifier,
  secret: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  username: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  password: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
});
export type PrivatePairingRequest = typeof PrivatePairingRequestSchema.Type;

/** Only the host UI receives this. It contains no owner password or TeamStore invite token. */
export interface PrivatePairingOffer {
  protocol: typeof PRIVATE_ACCESS_PROTOCOL;
  offerId: string;
  secret: string;
  expiresAt: string;
}

/** The host UI's QR payload. HTTPS trust and this pinned identity are both retained by clients. */
export const PrivateHostPairingOfferSchema = Schema.Struct({
  protocol: Schema.Literal(PRIVATE_ACCESS_PROTOCOL),
  offerId: identifier,
  secret: PrivatePairingRequestSchema.fields.secret,
  expiresAt: Schema.String.check(Schema.makeFilter((value) => Number.isFinite(Date.parse(value)))),
  publicOrigin: Schema.String.check(
    Schema.makeFilter((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }),
  ),
  hostId: identifier,
  hostName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  fingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  publicKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
});
export type PrivateHostPairingOffer = typeof PrivateHostPairingOfferSchema.Type;

/** The existing TeamStore result. This credential belongs only to the paired device. */
export interface PrivateAuthenticatedMember {
  member: TeamMemberSummary;
  sessionToken: string;
  sessionExpiresAt: string;
}

export interface PrivateSession {
  member: TeamMemberSummary;
  sessionId: string;
  sessionExpiresAt: string;
}

/** Structural subset of TeamStore.CreatedInvite; no copy of its persistence or authorization. */
export interface PrivateAuthorityInvite {
  id: string;
  token: string;
  role: PrivatePairingRole;
  expiresAt: string;
  email: string | null;
  permanent: boolean;
}

/**
 * The host supplies real TeamStore operations. Its revoke/remove adapters must also close the
 * browser and remote-screen resources of the ended access. No owner credential crosses this port.
 */
export interface PrivatePairingAuthority<E> {
  createInvite(role: PrivatePairingRole): Effect.Effect<PrivateAuthorityInvite, E>;
  acceptInvite(token: string, username: string, password: string): Effect.Effect<PrivateAuthenticatedMember, E>;
  revokeInvite(inviteId: string): Effect.Effect<void, E>;
  authenticateSession(token: string): PrivateSession | null;
  revokeSession(sessionId: string): Effect.Effect<void, E>;
  removeMember(memberId: string): Effect.Effect<void, E>;
}

export const PRIVATE_ACCESS_ERROR_CODES = [
  "invalid_configuration",
  "invalid_request",
  "pairing_unavailable",
  "pairing_refused",
  "authority_failed",
  "gateway_unavailable",
  "gateway_closed",
] as const;
export type PrivateAccessErrorCode = (typeof PRIVATE_ACCESS_ERROR_CODES)[number];

/** The network boundary sends only `code`. Causes stay on the host and must not be serialized. */
export class PrivateAccessError extends Schema.TaggedError<PrivateAccessError>()("PrivateAccessError", {
  code: Schema.Literals(PRIVATE_ACCESS_ERROR_CODES),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
