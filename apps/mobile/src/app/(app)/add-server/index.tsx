import { isPrivateBuild } from "@/features/private-access/private-build";
import { PrivateAddHostScreen } from "@/features/private-access/private-pairing-screen";
import { AddServerLinkScreen } from "@/features/servers/screens/add-server-link-screen";
export default isPrivateBuild ? PrivateAddHostScreen : AddServerLinkScreen;
