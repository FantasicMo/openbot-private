import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sourceText } from "@openbot/i18n/source";
import { registerSecretValue } from "@openbot/logging";
import { Effect, Result, Schema } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { readPreferenceFile, writePreferenceFile } from "./preference-file";
import type { TeamStore } from "./team-store";

export class PrivateHostFailure extends Schema.TaggedError<PrivateHostFailure>()("PrivateHostFailure", {
  code: Schema.String,
  message: Schema.String,
}) {}

export function privateHostFailure(
  code: "disabled" | "invalid_configuration" | "owner_secret_unavailable" | "operation_failed",
) {
  const key =
    code === "disabled"
      ? "error.privateAccess.disabled"
      : code === "invalid_configuration"
        ? "error.privateAccess.invalidConfiguration"
        : code === "owner_secret_unavailable"
          ? "error.privateAccess.ownerSecretUnavailable"
          : "error.privateAccess.operationFailed";
  return new PrivateHostFailure({ code, message: sourceText(key) });
}

export interface PrivateOwnerCipher {
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

const ownerSchema = Schema.Struct({
  version: Schema.Literal(1),
  encryptedSecret: Schema.String.check(Schema.isMinLength(1)),
});
const decodeOwner = Schema.decodeUnknownSync(ownerSchema);

/** This runs before HostService is constructed. It returns no owner credential to its caller. */
export const ensurePrivateOwner = Effect.fn("PrivateAccess.ensureOwner")(function* (input: {
  directory: string;
  serverName: string;
  store: Pick<
    TeamStore,
    "configured" | "getOwnerEmail" | "getOwnerAnalyticsIdentity" | "getOwnerMemberId" | "configure"
  >;
  cipher: PrivateOwnerCipher;
}) {
  if (
    input.store.configured &&
    (input.store.getOwnerEmail() || input.store.getOwnerAnalyticsIdentity() || !input.store.getOwnerMemberId())
  )
    return yield* privateHostFailure("invalid_configuration");
  const path = join(input.directory, "openbot-private-owner-v1.json");
  const loaded = yield* readPreferenceFile(path, decodeOwner).pipe(Effect.result);
  let ownerSecret: string;
  if (Result.isSuccess(loaded)) {
    ownerSecret = yield* Effect.try({
      try: () => input.cipher.decrypt(Buffer.from(loaded.success.encryptedSecret, "base64")),
      catch: () => privateHostFailure("owner_secret_unavailable"),
    });
    if (ownerSecret.length < 32) return yield* privateHostFailure("owner_secret_unavailable");
  } else {
    if (!isMissingFileError(loaded.failure.cause) || input.store.configured)
      return yield* privateHostFailure("owner_secret_unavailable");
    ownerSecret = randomBytes(32).toString("base64url");
    const encryptedSecret = yield* Effect.try({
      try: () => input.cipher.encrypt(ownerSecret).toString("base64"),
      catch: () => privateHostFailure("owner_secret_unavailable"),
    });
    yield* writePreferenceFile(path, { version: 1, encryptedSecret }).pipe(
      Effect.mapError(() => privateHostFailure("owner_secret_unavailable")),
    );
  }
  registerSecretValue(ownerSecret);
  if (!input.store.configured)
    yield* input.store
      .configure(input.serverName, "private-owner", ownerSecret)
      .pipe(Effect.mapError(() => privateHostFailure("operation_failed")));
});
