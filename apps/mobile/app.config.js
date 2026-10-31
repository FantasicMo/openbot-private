const { existsSync } = require("node:fs");
const { join } = require("node:path");

// Android notifications come through Firebase Cloud Messaging, which needs the Firebase file of the
// app. The file is optional, so the app builds before the Firebase project exists, and such a build
// gets no notifications on Android. The file has public identifiers only; the account service has the
// key that sends.
const GOOGLE_SERVICES_FILE = "./google-services.json";

/** @param {{ config: import('expo/config').ExpoConfig }} context */
module.exports = ({ config }) => {
  if (process.env.OPENBOT_PRIVATE_BUILD !== "1") {
    return existsSync(join(__dirname, GOOGLE_SERVICES_FILE))
      ? { ...config, android: { ...config.android, googleServicesFile: GOOGLE_SERVICES_FILE } }
      : config;
  }

  const versionCode = Number(process.env.OPENBOT_ANDROID_VERSION_CODE ?? config.android?.versionCode ?? 1);
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
    throw new Error("OPENBOT_ANDROID_VERSION_CODE must be an integer from 1 to 2100000000.");
  }
  const extra = { ...config.extra, privateBuild: true };
  delete extra.eas;
  const android = { ...config.android, package: "io.github.fantasicmo.openbot", versionCode };
  // A private candidate never reads the Firebase project file of the upstream app.
  delete android.googleServicesFile;
  const privateConfig = {
    ...config,
    name: "OpenBot Private",
    slug: "openbot-private",
    scheme: "openbot-private",
    platforms: ["android"],
    android,
    extra,
    updates: { enabled: false },
    plugins: [...(config.plugins ?? []), "./plugins/with-private-android-signing"],
  };
  delete privateConfig.owner;
  delete privateConfig.runtimeVersion;
  return privateConfig;
};
