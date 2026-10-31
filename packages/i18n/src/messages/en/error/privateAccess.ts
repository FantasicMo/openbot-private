import { defineMessages } from "../../../message";

export const messages = defineMessages("error.privateAccess", {
  "error.privateAccess.disabled": "Private access is unavailable in this build.",
  "error.privateAccess.accountUnavailable": "OpenBot account services are unavailable in private mode.",
  "error.privateAccess.invalidConfiguration": "The private host configuration is invalid.",
  "error.privateAccess.ownerSecretUnavailable": "The local host credential could not be read.",
  "error.privateAccess.operationFailed": "The private host operation could not be completed.",
});
