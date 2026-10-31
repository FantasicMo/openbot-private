import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useRef, useState } from "react";
import * as LockedKeychain from "@/shared/lib/locked-keychain";
import { currentAppVersion } from "@/shared/lib/mobile-features";
import { untilForeground } from "@/shared/lib/until-foreground";
import { PrivateMobileError } from "./private-contracts";
import { privateDirectory } from "./private-directory";
import { PrivateHostStore } from "./private-host-store";
import { privateNativeNetwork } from "./private-native-network";
import type { MobileDirectoryPort } from "./private-ports";

interface PrivateAccessContextValue {
  store: PrivateHostStore;
  directory: MobileDirectoryPort;
  loading: boolean;
  error: PrivateMobileError | null;
  revision: number;
  reload(): void;
}

const PrivateAccessContext = createContext<PrivateAccessContextValue | null>(null);
const STORAGE_KEY = "openbot.private.mobile-state.v1";

export function PrivateAccessProvider({ children }: PropsWithChildren) {
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<PrivateMobileError | null>(null);
  const mounted = useRef(true);
  const [store] = useState(
    () =>
      new PrivateHostStore(
        {
          read: () => LockedKeychain.getItemAsync(STORAGE_KEY),
          write: (value) => LockedKeychain.setItemAsync(STORAGE_KEY, value),
        },
        privateNativeNetwork,
        () => {
          if (mounted.current) setRevision((value) => value + 1);
        },
        Date.now,
        currentAppVersion() ?? "private-mobile",
      ),
  );
  const [directory] = useState(() => privateDirectory(store));
  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    void store
      .restore()
      .catch(() => untilForeground().then(() => store.restore()))
      .catch(() => {
        if (mounted.current) setError(new PrivateMobileError("storage"));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, [store]);
  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);
  return (
    <PrivateAccessContext.Provider value={{ store, directory, loading, error, revision, reload }}>
      {children}
    </PrivateAccessContext.Provider>
  );
}

export function usePrivateAccess(): PrivateAccessContextValue | null {
  return useContext(PrivateAccessContext);
}
