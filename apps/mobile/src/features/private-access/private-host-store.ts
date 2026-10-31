import { PRIVATE_PAIRING_PATH } from "@openbot/private-access/contracts";
import { bytesToBase64Url } from "@openbot/team-client/base64";
import {
  decodePrivateAuthentication,
  decodePrivateOffer,
  decodePrivateState,
  PrivateMobileError,
  type PrivateMobileState,
  type PrivatePairedHost,
} from "./private-contracts";
import { boundedText, privateTeamHeaders, verifyPrivateHost } from "./private-http-transport";
import type { PrivateHostPort, PrivateNetworkPort, PrivateStoragePort } from "./private-ports";

/** One serialized SecureStore document. Pending pairing credentials are saved before the POST. */
export class PrivateHostStore implements PrivateHostPort {
  readonly #storage: PrivateStoragePort;
  readonly #network: PrivateNetworkPort;
  readonly #changed: () => void;
  readonly #now: () => number;
  readonly #appVersion: string;
  #state: PrivateMobileState | null = null;
  #tail: Promise<void> = Promise.resolve();
  #pairing = false;

  constructor(
    storage: PrivateStoragePort,
    network: PrivateNetworkPort,
    changed: () => void,
    now: () => number = Date.now,
    appVersion = "private-mobile",
  ) {
    this.#storage = storage;
    this.#network = network;
    this.#changed = changed;
    this.#now = now;
    this.#appVersion = appVersion;
  }

  async restore(): Promise<void> {
    const text = await this.#storage.read();
    if (text !== null) this.#state = decodePrivateState(JSON.parse(text));
    else {
      const state = { deviceId: bytesToBase64Url(this.#network.randomBytes(24)), hosts: [] };
      await this.#storage.write(JSON.stringify(state));
      this.#state = state;
    }
    this.#changed();
  }

  state(): PrivateMobileState {
    if (!this.#state) throw new PrivateMobileError("storage");
    return this.#state;
  }

  host(hostId: string): PrivatePairedHost {
    const host = this.state().hosts.find((item) => item.hostId === hostId);
    if (!host) throw new PrivateMobileError("session");
    return host;
  }

  async #save(change: (state: PrivateMobileState) => PrivateMobileState): Promise<void> {
    const next = this.#tail.then(async () => {
      const state = change(this.state());
      try {
        await this.#storage.write(JSON.stringify(state));
      } catch {
        throw new PrivateMobileError("storage");
      }
      this.#state = state;
      this.#changed();
    });
    this.#tail = next.catch(() => undefined);
    await next;
  }

  async pair(value: string): Promise<PrivatePairedHost> {
    if (this.#pairing) throw new PrivateMobileError("pair");
    this.#pairing = true;
    try {
      // Parsing still validates the full offer and pin. Expiry is checked after the exact saved
      // pending offer can be identified, so an explicit retry can recover a committed credential.
      const offer = decodePrivateOffer(value, 0);
      const saved = this.state().pending;
      const recovering = Boolean(
        saved &&
          saved.offer.offerId === offer.offerId &&
          saved.offer.secret === offer.secret &&
          saved.offer.hostId === offer.hostId &&
          saved.offer.hostName === offer.hostName &&
          saved.offer.hostPublicKey === offer.hostPublicKey &&
          saved.offer.hostFingerprint === offer.hostFingerprint &&
          saved.offer.publicOrigin === offer.publicOrigin &&
          saved.offer.expiresAt === offer.expiresAt,
      );
      const expired = Date.parse(offer.expiresAt) <= this.#now();
      if (expired && !recovering) throw new PrivateMobileError("expiredOffer");
      const existing = this.state().hosts.find((host) => host.hostId === offer.hostId);
      if (existing && existing.hostPublicKey !== offer.hostPublicKey) throw new PrivateMobileError("identity");
      await verifyPrivateHost(this.#network, offer, this.#appVersion);
      const pending =
        saved && recovering
          ? saved
          : {
              offer,
              username: `mobile-${bytesToBase64Url(this.#network.randomBytes(18))}`,
              password: bytesToBase64Url(this.#network.randomBytes(32)),
            };
      await this.#save((state) => ({ ...state, pending }));
      let response: Response | null = null;
      // This is an explicit user retry. Recover a committed pairing through its saved device
      // credentials before asking a single-use offer to create another member.
      if (recovering) {
        response = await this.#network.fetch(new URL("/v1/auth/login", offer.publicOrigin).toString(), {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: { ...privateTeamHeaders(this.#appVersion), "Content-Type": "application/json" },
          body: JSON.stringify({ username: pending.username, password: pending.password }),
        });
        if (response.status === 401) {
          if (expired) throw new PrivateMobileError("expiredOffer");
          response = null;
        } else if (!response.ok) throw new PrivateMobileError("pair");
      }
      if (response === null && Date.parse(offer.expiresAt) <= this.#now()) throw new PrivateMobileError("expiredOffer");
      response ??= await this.#network.fetch(new URL(PRIVATE_PAIRING_PATH, offer.publicOrigin).toString(), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { ...privateTeamHeaders(this.#appVersion), "Content-Type": "application/json" },
        body: JSON.stringify({
          offerId: offer.offerId,
          secret: offer.secret,
          username: pending.username,
          password: pending.password,
        }),
      });
      if (!response.ok) throw new PrivateMobileError("pair");
      const authentication = decodePrivateAuthentication(JSON.parse(await boundedText(response, 32 * 1024)));
      const host: PrivatePairedHost = {
        hostId: offer.hostId,
        hostName: offer.hostName,
        hostPublicKey: offer.hostPublicKey,
        hostFingerprint: offer.hostFingerprint,
        publicOrigin: offer.publicOrigin,
        username: pending.username,
        password: pending.password,
        ...authentication,
      };
      await this.#save((state) => ({
        deviceId: state.deviceId,
        hosts: [...state.hosts.filter((item) => item.hostId !== host.hostId), host],
      }));
      return host;
    } finally {
      this.#pairing = false;
    }
  }

  forget(hostId: string): Promise<void> {
    return this.#save((state) => ({ ...state, hosts: state.hosts.filter((host) => host.hostId !== hostId) }));
  }

  replace(host: PrivatePairedHost): Promise<void> {
    return this.#save((state) => ({
      ...state,
      hosts: state.hosts.map((item) => (item.hostId === host.hostId ? host : item)),
    }));
  }
}
