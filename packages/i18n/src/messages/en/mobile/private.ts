import { defineMessages } from "../../../message";

export const messages = defineMessages("mobile.private", {
  "mobile.private.title": "Private hosts",
  "mobile.private.intro": "Connect to your own OpenBot computer.",
  "mobile.private.pairingLabel": "Pairing link or JSON",
  "mobile.private.pairingPlaceholder": "Paste the pairing offer from your computer",
  "mobile.private.pair": "Pair host",
  "mobile.private.scan": "Scan pairing QR code",
  "mobile.private.addHost": "Add private host",
  "mobile.private.forgetHost": "Forget host",
  "mobile.private.device": "This device",
  "mobile.private.error.invalidOffer": "This private pairing offer is invalid.",
  "mobile.private.error.expiredOffer": "This pairing offer has expired. Create a new one on the computer.",
  "mobile.private.error.identity": "The host identity could not be verified.",
  "mobile.private.error.pair": "The host could not be paired. Check the offer and connection.",
  "mobile.private.error.storage": "The private credentials could not be saved.",
  "mobile.private.error.unsupported": "This feature is unavailable in private mode.",
  "mobile.private.error.session": "This device session has ended. Pair the host again.",
  "mobile.private.error.network": "The private host could not be reached.",
});
