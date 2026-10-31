import { sourceText } from "@openbot/i18n/source";
import { RemoteDirectoryError, type RemoteTeamHost } from "@openbot/team-client";
import { Effect } from "effect";
import type { PrivatePairedHost } from "./private-contracts";
import type { MobileDirectoryPort, PrivateHostPort } from "./private-ports";

function summary(host: PrivatePairedHost): RemoteTeamHost {
  return {
    hostId: host.hostId,
    name: host.hostName,
    devicePublicKey: host.hostPublicKey,
    logoKey: null,
    membershipId: host.member.id,
    role: host.member.role,
    hosted: false,
  };
}

/** Account invitations and memberships are not emulated by private device pairing. */
export function privateDirectory(store: PrivateHostPort): MobileDirectoryPort {
  const failure = () =>
    new RemoteDirectoryError(405, sourceText("error.remote.serverRequestFailed"), "private_unsupported");
  const unsupported = () => Effect.fail(failure());
  return {
    listHosts: () => Effect.try({ try: () => store.state().hosts.map(summary), catch: failure }),
    acceptInvite: (value) => Effect.tryPromise({ try: () => store.pair(value).then(summary), catch: failure }),
    leaveHost: (hostId) => Effect.tryPromise({ try: () => store.forget(hostId), catch: failure }),
    listMembers: unsupported,
    listInvites: unsupported,
    createInvite: unsupported,
    sendInviteEmail: unsupported,
    revokeInvite: unsupported,
    updateMember: unsupported,
    removeOwnedHost: unsupported,
    createBootstrap: unsupported,
    endSession: unsupported,
    previewInvite: unsupported,
  };
}
