import type { PrivateAccessDevice, PrivateAccessPairing, PrivateAccessStatus } from "@openbot/contracts/ipc";
import { decodeRecord, requiredBoolean, requiredString } from "@openbot/contracts/ipc-decoding";
import { isString } from "@openbot/contracts/runtime-values";

/** FromMain decoders stay separate from the main process's untrusted request decoders. */
export function decodePrivateAccessStatus(value: unknown): PrivateAccessStatus {
  const status = decodeRecord(value, "private access status");
  const phase = status.phase;
  if (phase !== "local-only" && phase !== "starting" && phase !== "ready" && phase !== "error")
    throw new Error("Invalid private phase.");
  if (!Array.isArray(status.devices) || status.devices.length > 1024) throw new Error("Invalid private devices.");
  const gatewayPort = status.gatewayPort;
  if (
    gatewayPort !== null &&
    (typeof gatewayPort !== "number" || !Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535)
  )
    throw new Error("Invalid private gateway port.");
  return {
    enabled: requiredBoolean(status, "enabled"),
    phase,
    hostId: nullableString(status.hostId),
    hostName: nullableString(status.hostName),
    publicOrigin: nullableString(status.publicOrigin),
    gatewayPort,
    devices: status.devices.map(decodeDevice),
    errorCode: nullableString(status.errorCode),
  };
}

export function decodePrivateAccessPairing(value: unknown): PrivateAccessPairing {
  const offer = decodeRecord(value, "private pairing offer");
  if (offer.protocol !== 1) throw new Error("Invalid private pairing protocol.");
  const secret = requiredString(offer, "secret");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) throw new Error("Invalid private pairing secret.");
  const publicOrigin = requiredString(offer, "publicOrigin");
  const url = new URL(publicOrigin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Invalid private pairing origin.");
  return {
    protocol: 1,
    offerId: requiredString(offer, "offerId"),
    secret,
    expiresAt: requiredString(offer, "expiresAt"),
    publicOrigin,
    hostId: requiredString(offer, "hostId"),
    hostName: requiredString(offer, "hostName"),
    fingerprint: requiredString(offer, "fingerprint"),
    publicKey: requiredString(offer, "publicKey"),
  };
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (!isString(value)) throw new Error("Invalid private optional text.");
  return value;
}

function decodeDevice(value: unknown): PrivateAccessDevice {
  const device = decodeRecord(value, "private device");
  const role = device.role;
  if (role !== "admin" && role !== "member") throw new Error("Invalid private device role.");
  if (!Array.isArray(device.sessionIds) || !device.sessionIds.every(isString))
    throw new Error("Invalid private session identifiers.");
  return {
    memberId: requiredString(device, "memberId"),
    label: requiredString(device, "label"),
    role,
    disabled: requiredBoolean(device, "disabled"),
    sessionIds: device.sessionIds,
  };
}
