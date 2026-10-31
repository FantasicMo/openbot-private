import { fetch } from "expo/fetch";
import * as Crypto from "expo-crypto";
import { supportLog } from "@/features/support/model/support-log";
import { PrivateMobileError } from "./private-contracts";
import type { PrivateNetworkPort } from "./private-ports";

export const privateNativeNetwork: PrivateNetworkPort = {
  // Keep transport status/timing diagnostics, without the shared logger's URLs and raw causes.
  fetch: async (...args) => {
    const requested = args[1]?.method?.toUpperCase() ?? "GET";
    const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/u.test(requested) ? requested : "REQUEST";
    const started = Date.now();
    try {
      const response = await fetch(...args);
      supportLog.add(
        response.ok ? "info" : "warn",
        "network",
        `Private HTTP ${method} -> ${response.status} (${Date.now() - started} ms)`,
      );
      return response;
    } catch (cause) {
      const aborted = args[1]?.signal?.aborted === true;
      supportLog.add(
        aborted ? "info" : "warn",
        "network",
        `Private HTTP ${method} -> ${aborted ? "canceled" : "failed"} (${Date.now() - started} ms)`,
      );
      // Keep cancellation behavior, but do not retain a native exception with a URL or cause.
      const error = new PrivateMobileError("network");
      if (aborted || (cause instanceof Error && cause.name === "AbortError")) error.name = "AbortError";
      throw error;
    }
  },
  socket: (url, protocols) => new WebSocket(url, protocols),
  // getRandomBytes can use Math.random in a development debugger. This API always calls native crypto.
  randomBytes: (size) => Crypto.getRandomValues(new Uint8Array(size)),
};
