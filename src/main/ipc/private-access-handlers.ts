import type {
  ConfigurePrivateAccessInput,
  CreatePrivatePairingInput,
  RevokePrivateDeviceInput,
  RevokePrivateSessionInput,
} from "@openbot/contracts/ipc";
import type { IpcMainInvokeEvent } from "electron";
import {
  disabledPrivateAccessStatus,
  type PrivateAccessHostService,
  parsePrivateConfiguration,
} from "../private-access-host";
import { privateHostFailure } from "../private-access-owner";
import { authorizedHandler, handler, type IpcGroupHandlers } from "./define-ipc-group";
import { isObject, requireString } from "./validation";

export function privateAccessIpcHandlers(input: {
  privateAccess: PrivateAccessHostService | null;
  getMainRendererId: () => number | null;
}): Pick<IpcGroupHandlers, "privateAccess"> {
  const requireMain = (event: IpcMainInvokeEvent) => {
    if (event.sender.id !== input.getMainRendererId())
      throw new Error("Private access requires the main application window.");
  };
  const service = () => {
    if (!input.privateAccess) throw privateHostFailure("disabled");
    return input.privateAccess;
  };
  return {
    privateAccess: {
      status: handler(() => input.privateAccess?.getStatus() ?? disabledPrivateAccessStatus()),
      configure: authorizedHandler(requireMain, parseConfiguration, (_event, value) =>
        Effect.runPromise(service().configure(value)),
      ),
      createPairing: authorizedHandler(requireMain, parsePairing, (_event, value) =>
        Effect.runPromise(service().createPairing(value)),
      ),
      revokeDevice: authorizedHandler(requireMain, parseDevice, (_event, value) =>
        Effect.runPromise(service().revokeDevice(value.memberId)),
      ),
      revokeSession: authorizedHandler(requireMain, parseSession, (_event, value) =>
        Effect.runPromise(service().revokeSession(value.sessionId)),
      ),
    },
  };
}

import { Effect } from "effect";

function parseConfiguration(value: unknown): ConfigurePrivateAccessInput {
  return parsePrivateConfiguration(value);
}

function parsePairing(value: unknown): CreatePrivatePairingInput {
  if (!isObject(value) || (value.role !== "admin" && value.role !== "member"))
    throw new Error("An explicit private device role is required.");
  return { role: value.role, label: requireString(value.label, "label", 80).trim() };
}

function parseDevice(value: unknown): RevokePrivateDeviceInput {
  if (!isObject(value)) throw new Error("A private member is required.");
  return { memberId: requireString(value.memberId, "memberId", 128) };
}

function parseSession(value: unknown): RevokePrivateSessionInput {
  if (!isObject(value)) throw new Error("A private session is required.");
  return { sessionId: requireString(value.sessionId, "sessionId", 128) };
}
