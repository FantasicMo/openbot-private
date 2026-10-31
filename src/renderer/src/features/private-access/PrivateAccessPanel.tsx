import {
  DEFAULT_PRIVATE_GATEWAY_PORT,
  type PrivateAccessPairing,
  type PrivateAccessStatus,
} from "@openbot/contracts/ipc";
import {
  Alert,
  AlertContent,
  AlertDescription,
  Button,
  Field,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  QrCode,
  SettingsSection,
} from "@openbot/ui";
import { createStore, For, onSettled, Show } from "solid-js";
import { useI18n } from "../../i18n-context";
import { privateAccessPort } from "./private-access-port";
import "./private-access.css";

/** Public host configuration and short-lived pairing data. No owner credential enters this view. */
export function PrivateAccessPanel() {
  const i18n = useI18n();
  const [state, setState] = createStore<{
    status: PrivateAccessStatus | null;
    origin: string;
    label: string;
    busy: boolean;
    failed: boolean;
    offer: PrivateAccessPairing | null;
  }>({ status: null, origin: "", label: "", busy: false, failed: false, offer: null });
  let disposed = false;
  let initialized = false;
  let statusRevision = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function clearOffer(): void {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (!disposed)
      setState((draft) => {
        draft.offer = null;
      });
  }

  function applyStatus(status: PrivateAccessStatus): void {
    if (disposed) return;
    statusRevision += 1;
    setState((draft) => {
      draft.status = status;
    });
    if (!initialized) {
      initialized = true;
      setState((draft) => {
        draft.origin = status.publicOrigin ?? "";
      });
    }
    if (state.offer && (status.phase !== "ready" || state.offer.publicOrigin !== status.publicOrigin)) clearOffer();
  }

  async function load(): Promise<void> {
    const revision = statusRevision;
    try {
      const status = await privateAccessPort().status();
      if (revision === statusRevision) applyStatus(status);
    } catch {
      if (!disposed)
        setState((draft) => {
          draft.failed = true;
        });
    }
  }

  onSettled(() => {
    const unsubscribe = privateAccessPort().onChanged(applyStatus);
    void load();
    return () => {
      disposed = true;
      unsubscribe();
      if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    };
  });

  async function run(action: () => Promise<void>): Promise<void> {
    if (state.busy) return;
    setState((draft) => {
      draft.busy = true;
      draft.failed = false;
    });
    try {
      await action();
    } catch {
      if (!disposed)
        setState((draft) => {
          draft.failed = true;
        });
    } finally {
      if (!disposed)
        setState((draft) => {
          draft.busy = false;
        });
    }
  }

  function save(): void {
    void run(async () => {
      clearOffer();
      const status = await privateAccessPort().configure({
        publicOrigin: state.origin.trim() || null,
        gatewayPort: state.status?.gatewayPort ?? DEFAULT_PRIVATE_GATEWAY_PORT,
      });
      applyStatus(status);
      if (!disposed)
        setState((draft) => {
          draft.origin = status.publicOrigin ?? "";
        });
    });
  }

  function pair(): void {
    void run(async () => {
      clearOffer();
      const offer = await privateAccessPort().createPairing({ role: "admin", label: state.label.trim() });
      if (disposed) return;
      const remaining = Date.parse(offer.expiresAt) - Date.now();
      if (remaining <= 0) return;
      setState((draft) => {
        draft.offer = offer;
      });
      expiryTimer = setTimeout(clearOffer, remaining);
    });
  }

  const phaseText = () => {
    switch (state.status?.phase) {
      case "ready":
        return i18n.t("privateAccess.ready");
      case "error":
        return i18n.t("privateAccess.error");
      case "starting":
        return i18n.t("privateAccess.starting");
      default:
        return i18n.t("privateAccess.localOnly");
    }
  };

  return (
    <div class="private-access-panel">
      <Show when={state.failed}>
        <Alert tone="danger" role="alert">
          <AlertContent>
            <AlertDescription>{i18n.t("privateAccess.failed")}</AlertDescription>
          </AlertContent>
          <Show when={!state.status}>
            <Button variant="outline" size="sm" onClick={() => void run(load)}>
              {i18n.t("common.retry")}
            </Button>
          </Show>
        </Alert>
      </Show>
      <SettingsSection title={phaseText()} description={state.status?.hostName ?? undefined}>
        <Field label={i18n.t("privateAccess.address")}>
          <Input
            type="url"
            value={state.origin}
            placeholder={i18n.t("privateAccess.addressPlaceholder")}
            disabled={state.busy || !state.status?.enabled}
            onValueChange={(value) =>
              setState((draft) => {
                draft.origin = value;
              })
            }
          />
        </Field>
        <Button variant="outline" disabled={state.busy || !state.status?.enabled} onClick={save}>
          {i18n.t("privateAccess.save")}
        </Button>
      </SettingsSection>
      <SettingsSection
        title={i18n.t("privateAccess.createPairing")}
        description={i18n.t("privateAccess.pairingDescription")}
      >
        <Field label={i18n.t("privateAccess.deviceLabel")}>
          <Input
            value={state.label}
            maxlength={80}
            placeholder={i18n.t("privateAccess.devicePlaceholder")}
            disabled={state.busy}
            onValueChange={(value) =>
              setState((draft) => {
                draft.label = value;
              })
            }
          />
        </Field>
        <Button disabled={state.busy || state.status?.phase !== "ready" || !state.label.trim()} onClick={pair}>
          {i18n.t("privateAccess.createPairing")}
        </Button>
        <Show when={state.offer}>
          {(offer) => (
            <div class="private-access-offer">
              <QrCode value={JSON.stringify(offer())} label={i18n.t("privateAccess.createPairing")} size={280} />
              <p>
                {i18n.t("privateAccess.expires", {
                  time: new Date(offer().expiresAt).toLocaleTimeString(i18n.language()),
                })}
              </p>
              <Button
                variant="outline"
                disabled={state.busy}
                onClick={() =>
                  void run(async () => {
                    const current = state.offer;
                    if (current && Date.parse(current.expiresAt) > Date.now())
                      await navigator.clipboard.writeText(JSON.stringify(current));
                  })
                }
              >
                {i18n.t("privateAccess.copy")}
              </Button>
            </div>
          )}
        </Show>
      </SettingsSection>
      <SettingsSection title={i18n.t("privateAccess.devices")}>
        <ItemGroup class="settings-modal-card">
          <For
            each={state.status?.devices ?? []}
            fallback={<p class="private-access-empty">{i18n.t("privateAccess.noDevices")}</p>}
          >
            {(device) => (
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>{device.label}</ItemTitle>
                  <Show when={device.disabled}>
                    <ItemDescription>{i18n.t("privateAccess.disabled")}</ItemDescription>
                  </Show>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state.busy || device.disabled}
                    onClick={() =>
                      void run(async () => {
                        applyStatus(await privateAccessPort().revokeDevice({ memberId: device.memberId }));
                      })
                    }
                  >
                    {i18n.t("privateAccess.revoke")}
                  </Button>
                </ItemActions>
              </Item>
            )}
          </For>
        </ItemGroup>
      </SettingsSection>
    </div>
  );
}
