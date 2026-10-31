import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

export type PrivateAccessPort = OpenBotDesktopApi["privateAccess"];

/** The only renderer adapter for the private main-process boundary. */
export function privateAccessPort(): PrivateAccessPort {
  return window.openbot.privateAccess;
}
