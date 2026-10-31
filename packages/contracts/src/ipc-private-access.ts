export const DEFAULT_PRIVATE_GATEWAY_PORT = 43187;
export const PRIVATE_ACCESS_PHASES = ["local-only", "starting", "ready", "error"] as const;
export type PrivateAccessPhase = (typeof PRIVATE_ACCESS_PHASES)[number];

export interface PrivateAccessDevice {
  memberId: string;
  label: string;
  role: "admin" | "member";
  disabled: boolean;
  sessionIds: string[];
}

export interface PrivateAccessStatus {
  enabled: boolean;
  phase: PrivateAccessPhase;
  hostId: string | null;
  hostName: string | null;
  publicOrigin: string | null;
  gatewayPort: number | null;
  devices: PrivateAccessDevice[];
  errorCode: string | null;
}

export interface ConfigurePrivateAccessInput {
  publicOrigin: string | null;
  gatewayPort: number;
}

export interface CreatePrivatePairingInput {
  role: "admin" | "member";
  label: string;
}

/** Only a temporary device pairing credential and the public host identity cross IPC. */
export interface PrivateAccessPairing {
  protocol: 1;
  offerId: string;
  secret: string;
  expiresAt: string;
  publicOrigin: string;
  hostId: string;
  hostName: string;
  fingerprint: string;
  publicKey: string;
}

export interface RevokePrivateDeviceInput {
  memberId: string;
}

export interface RevokePrivateSessionInput {
  sessionId: string;
}
