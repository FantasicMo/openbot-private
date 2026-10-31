import { RemoteTeamDirectoryClient } from "@openbot/team-client";
import { verifyEd25519Base64Url } from "@openbot/team-client/ed25519";
import { useMemo } from "react";
import type { MobileSession } from "@/features/auth/api/mobile-auth";
import { useMobileSession } from "@/features/auth/context/mobile-session-context";
import { fetch } from "@/features/support/model/logged-fetch";
import { trustedHostKeys } from "@/features/workspace/model/trusted-host-keys";
import { usePrivateAccess } from "./private-access-context";
import type { MobileDirectoryPort } from "./private-ports";

export interface MobileWorkspaceAccess {
  namespace: string;
  identityId: string;
  scope: number;
  pairedHostId?: string;
  directory: MobileDirectoryPort;
  officialSession: MobileSession | null;
}

export function useMobileWorkspaceAccess(): MobileWorkspaceAccess | null {
  const { session, sessionScope } = useMobileSession();
  const access = usePrivateAccess();
  const store = access?.store;
  const directory = access?.directory;
  const loading = access?.loading;
  const error = access?.error;
  return useMemo(() => {
    if (store && directory) {
      if (loading || error) return null;
      return {
        namespace: "https://private-device.invalid",
        identityId: store.state().deviceId,
        scope: 0,
        directory,
        officialSession: null,
      };
    }
    if (!session) return null;
    return {
      namespace: session.apiUrl,
      identityId: session.user.id,
      scope: sessionScope,
      pairedHostId: session.host?.hostId,
      officialSession: session,
      directory: new RemoteTeamDirectoryClient({
        apiUrl: session.apiUrl,
        token: session.sessionToken,
        fetch,
        hostKeys: trustedHostKeys(session.apiUrl, session.user.id),
        pairedHost: session.host,
        verifyHostKeySignature: verifyEd25519Base64Url,
      }),
    };
  }, [loading, error, store, directory, session, sessionScope]);
}
