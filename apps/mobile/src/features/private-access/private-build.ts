import Constants from "expo-constants";

/** Set by our private build configuration. A missing marker keeps the upstream application. */
export const isPrivateBuild = Constants.expoConfig?.extra?.privateBuild === true;
