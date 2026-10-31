// Pairing secrets stay in bounded process memory, outside router params and persisted navigation.
let incoming: string | null = null;
export function rememberPrivateOffer(value: string): boolean {
  if (value.length > 16_384) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "openbot-private:" || url.hostname !== "pair" || !url.searchParams.has("offer")) return false;
    incoming = value;
    return true;
  } catch {
    return false;
  }
}
export function takePrivateOffer(): string {
  const value = incoming ?? "";
  incoming = null;
  return value;
}
