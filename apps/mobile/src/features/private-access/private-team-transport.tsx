import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { RemoteTeamTransportRef } from "@/features/workspace/components/remote-team-transport";
import { currentAppVersion } from "@/shared/lib/mobile-features";
import { usePrivateAccess } from "./private-access-context";
import { PrivateHttpTransport } from "./private-http-transport";
import { privateNativeNetwork } from "./private-native-network";
import type { PrivateTransportEvents } from "./private-ports";

const transports = new Map<string, PrivateHttpTransport>();
export function cancelPrivateUpload(hostId: string, transferId: string): void {
  transports.get(hostId)?.cancelUpload(transferId);
}

export const PrivateTeamTransport = forwardRef<
  RemoteTeamTransportRef,
  { hostId: string; active: boolean; events: PrivateTransportEvents }
>(function PrivateTeamTransport({ hostId, active, events }, ref) {
  const access = usePrivateAccess();
  if (!access) throw new Error("PrivateTeamTransport requires PrivateAccessProvider.");
  const latest = useRef({ access, events });
  latest.current = { access, events };
  const [transport] = useState(
    () =>
      new PrivateHttpTransport(
        privateNativeNetwork,
        () => latest.current.access.store.host(hostId),
        {
          connection: (update) => latest.current.events.connection(update),
          event: (id, event) => latest.current.events.event(id, event),
        },
        currentAppVersion() ?? "private-mobile",
      ),
  );
  useImperativeHandle(ref, () => transport, [transport]);
  useEffect(() => {
    transport.setActive(active);
  }, [active, transport]);
  useEffect(() => {
    transports.set(hostId, transport);
    return () => {
      if (transports.get(hostId) === transport) transports.delete(hostId);
      void transport.disconnect();
    };
  }, [hostId, transport]);
  return null;
});
