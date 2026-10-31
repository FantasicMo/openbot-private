import { isPrivateBuild } from "@/features/private-access/private-build";
import { PrivateScanScreen } from "@/features/private-access/private-pairing-screen";
import { ScanInviteScreen } from "@/features/servers/screens/scan-invite-screen";
export default isPrivateBuild ? PrivateScanScreen : ScanInviteScreen;
