import { SignInScreen } from "@/features/auth/screens/sign-in-screen";
import { isPrivateBuild } from "@/features/private-access/private-build";
import { PrivatePairingScreen } from "@/features/private-access/private-pairing-screen";
export default isPrivateBuild ? PrivatePairingScreen : SignInScreen;
