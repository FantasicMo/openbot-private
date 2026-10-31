import type { PrivateAccessPairing, PrivateAccessStatus } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { decodePrivateAccessPairing, decodePrivateAccessStatus } from "./private-access-decoding";

const status: PrivateAccessStatus = {
  enabled: true,
  phase: "local-only",
  hostId: "host",
  hostName: "Private",
  publicOrigin: null,
  gatewayPort: 43187,
  devices: [],
  errorCode: null,
};
const pairing: PrivateAccessPairing = {
  protocol: 1,
  offerId: "offer",
  secret: "x".repeat(43),
  expiresAt: "2030-01-01T00:00:00.000Z",
  publicOrigin: "https://host.example.test",
  hostId: "host",
  hostName: "Private",
  fingerprint: "fingerprint",
  publicKey: "public-key",
};

describe("private access FromMain decoding", () => {
  it("keeps valid local-only status and a public pairing identity", () => {
    expect(decodePrivateAccessStatus(status)).toEqual(status);
    expect(decodePrivateAccessPairing(pairing)).toEqual(pairing);
  });

  it("rejects malformed phases and owner identities in the paired-device list", () => {
    expect(() => decodePrivateAccessStatus({ ...status, phase: "published" })).toThrow();
    expect(() =>
      decodePrivateAccessStatus({
        ...status,
        devices: [{ memberId: "owner", role: "owner", label: "Owner", disabled: false, sessionIds: [] }],
      }),
    ).toThrow();
  });

  it("rejects malformed pairing secrets and untrusted origin forms", () => {
    expect(() => decodePrivateAccessPairing({ ...pairing, secret: "short" })).toThrow();
    expect(() => decodePrivateAccessPairing({ ...pairing, publicOrigin: "http://host.example.test" })).toThrow();
    expect(() =>
      decodePrivateAccessPairing({ ...pairing, publicOrigin: "https://user:secret@host.example.test" }),
    ).toThrow();
  });
});
