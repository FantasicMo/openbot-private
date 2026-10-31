import type { TeamMemberSummary } from "@openbot/contracts/ipc";
import { type DynamicRecord, isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  PRIVATE_ACCESS_PROTOCOL,
  type PrivateAuthenticatedMember,
  PrivateHostPairingOfferSchema,
} from "@openbot/private-access/contracts";
import { remoteHostFingerprint } from "@openbot/team-client/host-key-handover";
import { Schema } from "effect";

export const MAX_PRIVATE_HOSTS = 32;

export type PrivatePairingStage =
  | "offer-check"
  | "identity-random"
  | "identity-request"
  | "identity-body"
  | "identity-check"
  | "credential-random"
  | "pending-save"
  | "recovery-request"
  | "redemption-request"
  | "authentication-body"
  | "authentication-check"
  | "complete-save";

export class PrivateMobileError extends Error {
  constructor(
    readonly code:
      | "invalidOffer"
      | "expiredOffer"
      | "identity"
      | "pair"
      | "storage"
      | "unsupported"
      | "session"
      | "network",
    readonly diagnostic?: { stage: PrivatePairingStage; status?: number },
  ) {
    super(`Private access: ${code}`);
    this.name = "PrivateMobileError";
  }
}

/** Keep only a fixed stage and numeric HTTP status. Never retain the thrown cause or response. */
export function privatePairingFailure(cause: unknown, stage: PrivatePairingStage, status?: number): PrivateMobileError {
  if (cause instanceof PrivateMobileError && cause.diagnostic) return cause;
  const code = cause instanceof PrivateMobileError ? cause.code : stage.endsWith("-request") ? "network" : "pair";
  return new PrivateMobileError(code, {
    stage,
    ...(Number.isInteger(status) && status !== undefined && status >= 100 && status <= 599 ? { status } : {}),
  });
}

export function privatePairingDiagnosticCode(error: PrivateMobileError): string | null {
  const diagnostic = error.diagnostic;
  return diagnostic ? `${diagnostic.stage}${diagnostic.status === undefined ? "" : `/${diagnostic.status}`}` : null;
}

export interface PrivateHostIdentity {
  hostId: string;
  hostName: string;
  hostFingerprint: string;
  hostPublicKey: string;
  publicOrigin: string;
}

export interface PrivateMobileOffer extends PrivateHostIdentity {
  protocol: typeof PRIVATE_ACCESS_PROTOCOL;
  offerId: string;
  secret: string;
  expiresAt: string;
}

export interface PrivatePairedHost extends PrivateHostIdentity, PrivateAuthenticatedMember {
  username: string;
  password: string;
}

export interface PrivateMobileState {
  deviceId: string;
  hosts: PrivatePairedHost[];
  pending?: { offer: PrivateMobileOffer; username: string; password: string };
}

/** Only HTTPS origins. No userinfo, path, query, fragment, or ambient HTTP exception. */
export function privateOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new PrivateMobileError("invalidOffer");
  return url.origin;
}

function field(value: DynamicRecord, key: string, maximum = 512): string {
  const item = value[key];
  if (!isString(item) || !item || item.length > maximum) throw new PrivateMobileError("invalidOffer");
  return item;
}

export function decodePrivateHost(value: unknown): PrivateHostIdentity {
  if (!isDynamicRecord(value)) throw new PrivateMobileError("invalidOffer");
  const hostPublicKey = field(value, "publicKey", 8192);
  const hostFingerprint = field(value, "fingerprint", 128);
  if (remoteHostFingerprint(hostPublicKey) !== hostFingerprint) throw new PrivateMobileError("identity");
  return {
    hostId: field(value, "hostId", 128),
    hostName: field(value, "hostName", 256),
    hostFingerprint,
    hostPublicKey,
    publicOrigin: privateOrigin(field(value, "publicOrigin", 2048)),
  };
}

/** The host UI supplies JSON, either pasted directly or encoded in our own scheme's offer field. */
export function decodePrivateOffer(input: string, now = Date.now()): PrivateMobileOffer {
  let text = input.trim();
  if (text.length > 16_384) throw new PrivateMobileError("invalidOffer");
  try {
    if (text.startsWith("openbot-private:")) {
      const url = new URL(text);
      if (url.hostname !== "pair" || (url.pathname !== "" && url.pathname !== "/") || url.hash)
        throw new PrivateMobileError("invalidOffer");
      text = url.searchParams.get("offer") ?? "";
    }
    const value = Schema.decodeUnknownSync(PrivateHostPairingOfferSchema)(JSON.parse(text));
    const expiresAt = field(value, "expiresAt", 64);
    if (!Number.isFinite(Date.parse(expiresAt))) throw new PrivateMobileError("invalidOffer");
    if (Date.parse(expiresAt) <= now) throw new PrivateMobileError("expiredOffer");
    const secret = field(value, "secret", 43);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) throw new PrivateMobileError("invalidOffer");
    return {
      ...decodePrivateHost(value),
      protocol: PRIVATE_ACCESS_PROTOCOL,
      offerId: field(value, "offerId", 128),
      secret,
      expiresAt,
    };
  } catch (error) {
    if (error instanceof PrivateMobileError) throw error;
    throw new PrivateMobileError("invalidOffer");
  }
}

export function decodePrivateMember(value: unknown): TeamMemberSummary {
  if (!isDynamicRecord(value)) throw new PrivateMobileError("pair");
  const role = value.role;
  if (role !== "owner" && role !== "admin" && role !== "member") throw new PrivateMobileError("pair");
  if (!isBoolean(value.disabled)) throw new PrivateMobileError("pair");
  const nullable = (key: string) => {
    const item = value[key];
    if (item !== null && !isString(item)) throw new PrivateMobileError("pair");
    return item;
  };
  return {
    id: field(value, "id"),
    username: field(value, "username"),
    role,
    disabled: value.disabled,
    email: nullable("email"),
    name: nullable("name"),
    ...(value.avatarUrl !== undefined ? { avatarUrl: nullable("avatarUrl") } : {}),
    createdAt: field(value, "createdAt"),
  };
}

export function decodePrivateAuthentication(value: unknown): PrivateAuthenticatedMember {
  if (!isDynamicRecord(value)) throw new PrivateMobileError("pair");
  const sessionToken = field(value, "sessionToken", 512);
  if (!/^[A-Za-z0-9_-]+$/u.test(sessionToken)) throw new PrivateMobileError("pair");
  const sessionExpiresAt = field(value, "sessionExpiresAt", 64);
  if (!Number.isFinite(Date.parse(sessionExpiresAt))) throw new PrivateMobileError("pair");
  return { member: decodePrivateMember(value.member), sessionToken, sessionExpiresAt };
}

export function decodePrivateState(value: unknown): PrivateMobileState {
  if (!isDynamicRecord(value) || !Array.isArray(value.hosts) || value.hosts.length > MAX_PRIVATE_HOSTS)
    throw new PrivateMobileError("storage");
  const pending = value.pending;
  if (pending !== undefined && !isDynamicRecord(pending)) throw new PrivateMobileError("storage");
  const offer = pending?.offer;
  if (pending && !isDynamicRecord(offer)) throw new PrivateMobileError("storage");
  return {
    deviceId: field(value, "deviceId", 128),
    ...(pending && isDynamicRecord(offer)
      ? {
          pending: {
            offer: decodePrivateOffer(
              JSON.stringify({ ...offer, publicKey: offer.hostPublicKey, fingerprint: offer.hostFingerprint }),
              0,
            ),
            username: field(pending, "username", 64),
            password: field(pending, "password", 256),
          },
        }
      : {}),
    hosts: value.hosts.map((item) => {
      if (!isDynamicRecord(item)) throw new PrivateMobileError("storage");
      return {
        ...decodePrivateHost({ ...item, publicKey: item.hostPublicKey, fingerprint: item.hostFingerprint }),
        ...decodePrivateAuthentication(item),
        username: field(item, "username", 64),
        password: field(item, "password", 256),
      };
    }),
  };
}
