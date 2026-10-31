import { ScanQrCodeScreen } from "@/features/auth/screens/scan-qr-code-screen";
import { isPrivateBuild } from "@/features/private-access/private-build";
import { PrivateScanScreen } from "@/features/private-access/private-pairing-screen";
export default isPrivateBuild ? PrivateScanScreen : ScanQrCodeScreen;
