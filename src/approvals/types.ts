/**
 * 审批子系统的唯一形状定义。T1 不依赖控制面、QQ 通道或网页层；
 * 控制面的 `IntentName` 在结构上等价于下面的 `ControlIntentName`。
 */

/** M2b 只有前两个 kind 有生产者；其余为 M6 预留。 */
export type ApprovalKind =
  | 'capability.activate'
  | 'control.command'
  | 'persona.change'
  | 'skill.change'
  | 'mcp.change'
  | 'cli.exec';

export type RiskTier = 'auto' | 'human';

/** 终态不可变；`stale` 表示执行前指纹复核失败。 */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'stale';

export type DecisionChannel = 'qq' | 'web' | 'system';

/**
 * §4 的 8 个意图名。T2 的 `IntentName` 与本类型结构等价，
 * 因此审批载荷可以在两个模块之间直接传递，无需 T1 反向依赖控制面。
 */
export type ControlIntentName =
  | 'help.read'
  | 'status.read'
  | 'approval.list'
  | 'approval.decide'
  | 'capability.ban'
  | 'capability.unban'
  | 'group.silence'
  | 'group.resume';

export type ApprovalPayload =
  | {
      kind: 'capability.activate';
      plugin: string;
      version: string;
      fingerprint: string;
      declaredPermissions: string[];
      toolNames: string[];
    }
  | {
      kind: 'control.command';
      intent: ControlIntentName;
      args: Record<string, string | number>;
    };

export interface ApprovalExecution {
  state: 'pending' | 'done' | 'failed';
  at?: string;
  error?: string;
}

export interface ApprovalRecord {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  tier: RiskTier;
  title: string;
  summary: string;
  payload: ApprovalPayload;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  /** 进程内单调截止；跨重启后重新计算，磁盘上的值不可信。 */
  expiresAtMono?: number;
  createdVia: DecisionChannel;
  createdBy: string;
  decidedAt?: string;
  decidedVia?: DecisionChannel;
  decidedBy?: string;
  decisionReason?: string;
  /** `status` 与执行状态分离：批准了但执行失败仍然可见，也不会被误当未批准。 */
  execution?: ApprovalExecution;
}

export type ApprovalErrorCode =
  | 'not_found'
  | 'not_pending'
  | 'expired'
  | 'stale'
  | 'conflict'
  | 'wrong_channel'
  | 'lethal_trifecta'
  | 'not_implemented'
  | 'invalid_body'
  | 'rate_limited';

export type ApprovalEventType = 'proposed' | 'decided' | 'expired' | 'executed';

export interface ApprovalEvent {
  type: ApprovalEventType;
  record: ApprovalRecord;
}
