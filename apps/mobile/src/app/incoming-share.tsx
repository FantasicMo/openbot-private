import { Redirect } from "expo-router";
import { isPrivateBuild } from "@/features/private-access/private-build";
import { IncomingShareScreen } from "@/features/share/screens/incoming-share-screen";

function PrivateShareScreen() {
  return <Redirect href="/" />;
}
export default isPrivateBuild ? PrivateShareScreen : IncomingShareScreen;
