import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/privateAccess";

export const messages = {
  "privateAccess.title": "私网连接",
  "privateAccess.description": "连接手机并管理已配对设备。",
  "privateAccess.address": "主机地址",
  "privateAccess.addressPlaceholder": "https://your-host.your-tailnet.ts.net",
  "privateAccess.save": "保存地址",
  "privateAccess.localOnly": "本地工作区",
  "privateAccess.starting": "正在连接",
  "privateAccess.ready": "可以配对",
  "privateAccess.error": "连接异常",
  "privateAccess.deviceLabel": "设备名称",
  "privateAccess.devicePlaceholder": "我的安卓手机",
  "privateAccess.createPairing": "生成配对码",
  "privateAccess.pairingDescription": "用手机 App 扫描二维码，或粘贴配对信息。",
  "privateAccess.copy": "复制配对信息",
  "privateAccess.expires": "有效期至 {time}",
  "privateAccess.devices": "已配对设备",
  "privateAccess.noDevices": "尚无已配对设备。",
  "privateAccess.revoke": "撤销访问",
  "privateAccess.disabled": "已撤销访问",
  "privateAccess.failed": "无法保存私网连接设置。",
} as const satisfies PartialTranslation<typeof source>;
