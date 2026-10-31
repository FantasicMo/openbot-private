// @vitest-environment node
import { IPC_ENDPOINTS } from "@openbot/contracts/ipc";
import { describe, expect, it, vi } from "vitest";
import { registerIpcGroup } from "./define-ipc-group";
import { privateAccessIpcHandlers } from "./private-access-handlers";

const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, ...arguments_: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, ...arguments_: unknown[]) => unknown) {
      registrations.set(channel, listener);
    },
  },
}));

function register(): void {
  registerIpcGroup(
    "privateAccess",
    privateAccessIpcHandlers({ privateAccess: null, getMainRendererId: () => 1 }).privateAccess,
  );
}

const trustedMain = { sender: { id: 1 }, senderFrame: { url: "openbot-app://app/index.html" } };
const trustedOtherWindow = { sender: { id: 2 }, senderFrame: { url: "openbot-app://app/index.html" } };
const remotePage = { sender: { id: 1 }, senderFrame: { url: "https://untrusted.invalid" } };

describe("private host IPC boundary", () => {
  it("rejects remote pages and other app windows before parsing mutation payloads", () => {
    register();
    for (const endpoint of [
      IPC_ENDPOINTS.privateAccess.configure,
      IPC_ENDPOINTS.privateAccess.createPairing,
      IPC_ENDPOINTS.privateAccess.revokeDevice,
      IPC_ENDPOINTS.privateAccess.revokeSession,
    ]) {
      const listener = registrations.get(endpoint.channel);
      expect(() => listener?.(remotePage, null)).toThrow("Rejected IPC request from an untrusted renderer.");
      expect(() => listener?.(trustedOtherWindow, null)).toThrow(
        "Private access requires the main application window.",
      );
    }
  });

  it("validates the allowed sender's origin and explicit non-owner pairing role", () => {
    register();
    expect(() =>
      registrations.get(IPC_ENDPOINTS.privateAccess.configure.channel)?.(trustedMain, {
        publicOrigin: "http://private.invalid",
        gatewayPort: 43187,
      }),
    ).toThrow("The private origin must be HTTPS");
    expect(() =>
      registrations.get(IPC_ENDPOINTS.privateAccess.createPairing.channel)?.(trustedMain, {
        role: "owner",
        label: "Phone",
      }),
    ).toThrow("An explicit private device role is required.");
  });

  it("does not let a valid private mutation run on an official build", () => {
    register();
    expect(() =>
      registrations.get(IPC_ENDPOINTS.privateAccess.createPairing.channel)?.(trustedMain, {
        role: "admin",
        label: "Phone",
      }),
    ).toThrow();
    expect(registrations.get(IPC_ENDPOINTS.privateAccess.status.channel)?.(trustedMain)).toMatchObject({
      enabled: false,
      devices: [],
    });
  });
});
