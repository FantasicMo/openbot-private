const { withAppBuildGradle } = require("expo/config-plugins");

const START = "// @generated with-private-android-signing start";
const END = "// @generated with-private-android-signing end";

// Credentials stay in the build process environment. Do not put them in Expo config, generated
// source, Gradle properties, logs, or the APK. In particular, do not keep Expo's debug release key.
const SIGNING = `
${START}
def privateSigningEnvironment = [
    "OPENBOT_ANDROID_KEYSTORE_PATH",
    "OPENBOT_ANDROID_STORE_PASSWORD",
    "OPENBOT_ANDROID_KEY_ALIAS",
    "OPENBOT_ANDROID_KEY_PASSWORD",
]
def privateSigningValues = privateSigningEnvironment.collectEntries { name ->
    [(name): System.getenv(name)]
}
def requirePrivateSigning = {
    def missing = privateSigningEnvironment.findAll { name -> !privateSigningValues[name] }
    if (!missing.isEmpty()) {
        throw new GradleException("Private release signing requires: " + missing.join(", "))
    }
    if (!file(privateSigningValues["OPENBOT_ANDROID_KEYSTORE_PATH"]).isFile()) {
        throw new GradleException("The private Android keystore file does not exist.")
    }
}
android {
    signingConfigs {
        openbotPrivateRelease {
            if (privateSigningEnvironment.every { name -> privateSigningValues[name] }) {
                storeFile file(privateSigningValues["OPENBOT_ANDROID_KEYSTORE_PATH"])
                storePassword privateSigningValues["OPENBOT_ANDROID_STORE_PASSWORD"]
                keyAlias privateSigningValues["OPENBOT_ANDROID_KEY_ALIAS"]
                keyPassword privateSigningValues["OPENBOT_ANDROID_KEY_PASSWORD"]
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.openbotPrivateRelease
        }
    }
}
gradle.taskGraph.whenReady { graph ->
    if (graph.allTasks.any { task -> task.project == project && task.name.contains("Release") }) {
        requirePrivateSigning()
    }
}
${END}
`;

/** @param {string} contents */
function withPrivateSigning(contents) {
  const start = contents.indexOf(START);
  const end = contents.indexOf(END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error("The generated private Android signing block is incomplete. Use a fresh Android prebuild.");
  }
  const source = start === -1 ? contents : contents.slice(0, start) + contents.slice(end + END.length);
  return `${source.trimEnd()}\n${SIGNING}`;
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
module.exports = (config) =>
  withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== "groovy") {
      throw new Error("Private Android signing requires Expo's Groovy app build.gradle template.");
    }
    mod.modResults.contents = withPrivateSigning(mod.modResults.contents);
    return mod;
  });
