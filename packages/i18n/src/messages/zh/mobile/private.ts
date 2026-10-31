import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/mobile/private";

export const messages = {
  "mobile.private.title": "私网主机",
  "mobile.private.intro": "连接你自己的 OpenBot 电脑。",
  "mobile.private.pairingLabel": "配对链接或 JSON",
  "mobile.private.pairingPlaceholder": "粘贴电脑生成的配对信息",
  "mobile.private.pair": "配对主机",
  "mobile.private.scan": "扫描配对二维码",
  "mobile.private.addHost": "添加私网主机",
  "mobile.private.forgetHost": "移除此主机",
  "mobile.private.device": "当前设备",
  "mobile.private.diagnosticCode": "诊断代码：{code}",
  "mobile.private.error.invalidOffer": "私网配对信息无效。",
  "mobile.private.error.expiredOffer": "配对信息已过期，请在电脑上重新生成。",
  "mobile.private.error.identity": "无法验证主机身份。",
  "mobile.private.error.pair": "无法配对主机，请检查配对信息和网络连接。",
  "mobile.private.error.storage": "无法保存私网设备凭据。",
  "mobile.private.error.unsupported": "私网模式暂不支持此功能。",
  "mobile.private.error.session": "设备会话已失效，请重新配对主机。",
  "mobile.private.error.network": "无法连接私网主机。",
} as const satisfies PartialTranslation<typeof source>;
