import { IncomingLinkScreen } from "@/features/links/screens/incoming-link-screen";
import { isPrivateBuild } from "@/features/private-access/private-build";
import { PrivatePairingScreen } from "@/features/private-access/private-pairing-screen";
export default isPrivateBuild ? PrivatePairingScreen : IncomingLinkScreen;
