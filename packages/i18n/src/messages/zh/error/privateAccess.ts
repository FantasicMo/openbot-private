import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/privateAccess";

export const messages = {
  "error.privateAccess.disabled": "此版本未启用私网连接。",
  "error.privateAccess.accountUnavailable": "私网模式不使用 OpenBot 账号服务。",
  "error.privateAccess.invalidConfiguration": "私网主机配置无效。",
  "error.privateAccess.ownerSecretUnavailable": "无法读取本地主机凭据。",
  "error.privateAccess.operationFailed": "无法完成私网主机操作。",
} as const satisfies PartialTranslation<typeof source>;
