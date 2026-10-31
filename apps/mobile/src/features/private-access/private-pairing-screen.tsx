import { router, Stack } from "expo-router";
import { Button, Typography } from "heroui-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { QrScanner } from "@/features/auth/components/qr-scanner";
import { SheetFormField } from "@/shared/components/sheet-form-field";
import { SheetSaveAction } from "@/shared/components/sheet-save-action";
import { SheetScrollView } from "@/shared/components/sheet-scroll-view";
import { useText } from "@/shared/lib/text";
import { usePrivateAccess } from "./private-access-context";
import { PrivateMobileError } from "./private-contracts";
import { takePrivateOffer } from "./private-incoming";

export function PrivateAddHostScreen() {
  return <PrivatePairingScreen sheet />;
}

export function PrivatePairingScreen({ sheet = false }: { sheet?: boolean }) {
  const access = usePrivateAccess();
  const { t } = useText();
  const insets = useSafeAreaInsets();
  const [value, setValue] = useState(takePrivateOffer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PrivateMobileError | null>(null);
  async function pair() {
    if (!access || busy) return;
    setBusy(true);
    setError(null);
    try {
      await access.store.pair(value);
      if (sheet) router.dismissTo("/connected");
      else router.replace("/connected");
    } catch (cause) {
      setError(cause instanceof PrivateMobileError ? cause : new PrivateMobileError("pair"));
    } finally {
      setBusy(false);
    }
  }
  const content = (
    <View className="gap-5">
      {sheet ? null : <Typography.Heading>{t("mobile.private.title")}</Typography.Heading>}
      <Typography.Paragraph>{t("mobile.private.intro")}</Typography.Paragraph>
      <SheetFormField
        label={t("mobile.private.pairingLabel")}
        placeholder={t("mobile.private.pairingPlaceholder")}
        value={value}
        onChangeText={setValue}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        maxLength={16_384}
      />
      {access?.error ? (
        <View className="gap-3">
          <Typography.Paragraph className="text-danger-text">{t("mobile.private.error.storage")}</Typography.Paragraph>
          <Button variant="secondary" onPress={access.reload}>
            <Button.Label>{t("common.retry")}</Button.Label>
          </Button>
        </View>
      ) : null}
      {error ? (
        <Typography.Paragraph accessibilityLiveRegion="polite" className="text-danger-text">
          {t(`mobile.private.error.${error.code}`)}
        </Typography.Paragraph>
      ) : null}
      {sheet ? null : (
        <Button isDisabled={busy || !value.trim() || Boolean(access?.error)} onPress={() => void pair()}>
          <Button.Label>{t("mobile.private.pair")}</Button.Label>
        </Button>
      )}
      <Button
        variant="secondary"
        isDisabled={busy}
        onPress={() => router.push(sheet ? "/add-server/scan" : "/scan-qr-code")}
      >
        <Button.Label>{t("mobile.private.scan")}</Button.Label>
      </Button>
    </View>
  );
  if (sheet)
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: t("mobile.private.addHost") }} />
        <SheetSaveAction
          dirty={Boolean(value.trim())}
          canSave={!access?.error}
          pending={busy}
          label={t("mobile.private.pair")}
          onSave={() => void pair()}
        />
        <SheetScrollView contentContainerClassName="gap-5 px-5 py-6" keyboardShouldPersistTaps="handled">
          {content}
        </SheetScrollView>
      </>
    );
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24, paddingHorizontal: 24 }}
      keyboardShouldPersistTaps="handled"
    >
      {content}
    </ScrollView>
  );
}

export function PrivateScanScreen() {
  const access = usePrivateAccess();
  const { t } = useText();
  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: t("mobile.private.scan") }} />
      <QrScanner
        onScan={async (value) => {
          if (!access) throw new Error(t("mobile.private.error.storage"));
          try {
            await access.store.pair(value);
            router.dismissTo("/connected");
          } catch (cause) {
            const error = cause instanceof PrivateMobileError ? cause : new PrivateMobileError("pair");
            throw new Error(t(`mobile.private.error.${error.code}`));
          }
        }}
      />
    </>
  );
}
