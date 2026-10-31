import * as Crypto from "expo-crypto";
import { fetch } from "@/features/support/model/logged-fetch";
import type { PrivateNetworkPort } from "./private-ports";

export const privateNativeNetwork: PrivateNetworkPort = {
  fetch,
  socket: (url, protocols) => new WebSocket(url, protocols),
  // getRandomBytes can use Math.random in a development debugger. This API always calls native crypto.
  randomBytes: (size) => Crypto.getRandomValues(new Uint8Array(size)),
};
