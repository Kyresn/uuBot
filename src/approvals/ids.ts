/**
 * 审批 id：`ap_` + 128 bit 随机十六进制。永不复用，无序号，
 * 因此不存在「按前缀匹配」或「批准最新一条」的捷径。
 */
import { randomBytes } from 'node:crypto';

export function newApprovalId(): string {
  return `ap_${randomBytes(16).toString('hex')}`;
}
