import type { AgentEvent, TeamRealtimeEvent } from "@openbot/contracts/ipc";
import type { RemoteTeamDirectoryClient } from "@openbot/team-client";
import type { RemoteTeamConnectionUpdate } from "@openbot/team-client/remote-peer";
import type { PrivateMobileState, PrivatePairedHost } from "./private-contracts";

export type MobileDirectoryPort = Pick<
  RemoteTeamDirectoryClient,
  | "listHosts"
  | "listMembers"
  | "listInvites"
  | "createInvite"
  | "sendInviteEmail"
  | "revokeInvite"
  | "updateMember"
  | "leaveHost"
  | "removeOwnedHost"
  | "createBootstrap"
  | "endSession"
  | "previewInvite"
  | "acceptInvite"
>;

export interface PrivateStoragePort {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export interface PrivateNetworkPort {
  fetch(...args: Parameters<typeof globalThis.fetch>): ReturnType<typeof globalThis.fetch>;
  socket(url: string, protocols: string[]): WebSocket;
  randomBytes(size: number): Uint8Array;
}

export interface PrivateTransportEvents {
  connection(update: RemoteTeamConnectionUpdate): void;
  event(hostId: string, event: AgentEvent | TeamRealtimeEvent): void;
}

export interface PrivateHostPort {
  state(): PrivateMobileState;
  host(hostId: string): PrivatePairedHost;
  pair(value: string): Promise<PrivatePairedHost>;
  forget(hostId: string): Promise<void>;
  replace(host: PrivatePairedHost): Promise<void>;
}
