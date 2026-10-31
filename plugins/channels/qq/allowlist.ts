/**
 * QQ 渠道的白/黑名单。
 *
 * 名单来自逗号分隔的环境变量；空项与空白项被丢弃。黑名单优先于白名单。
 * 群白名单为空表示没有任何群激活（安全默认）。
 *
 * 私聊语义（D3）：默认**失败关闭**——只有 `QQ_PRIVATE_ALLOWLIST` 里的用户
 * 能私聊它。`QQ_PRIVATE_OPEN` 显式打开后（`1`/`true`/`yes`），私聊名单
 * 整体视为关闭：任何不在黑名单里的私聊都被接收，但只回复不主动（白名单
 * 仍被 M2b 用作主动私聊目标）。私聊黑名单在两种模式下都权威。
 */

/** 四个名单 + 私聊开关，字符串 id 与 OneBot 事件里的数字 id 分离。 */
export interface AllowLists {
  groupAllowlist: Set<string>;
  groupDenylist: Set<string>;
  privateAllowlist: Set<string>;
  privateDenylist: Set<string>;
  /** 私聊名单整体关闭（`QQ_PRIVATE_OPEN`）；默认 false，失败关闭。 */
  privateOpen: boolean;
}

/** 解析逗号分隔的名单；`undefined` 与空字符串都得到空集合。 */
export function parseList(env: string | undefined): Set<string> {
  if (env === undefined) return new Set();
  return new Set(
    env
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  );
}

/** 事件参与者：群消息带 group，私聊只带 userId。 */
export interface AllowlistActor {
  group?: string;
  userId?: string;
}

/**
 * 判断一条消息是否被允许。
 *
 * 群消息只看群名单（`group` 存在时忽略 `userId`）：黑名单优先，空白名单
 * 表示无群激活。私聊先过黑名单（任何模式下都权威）；`privateOpen` 打开时
 * 接受任何非黑名单用户，否则只接受白名单内的用户（默认失败关闭）。
 */
export function isAllowed(actor: AllowlistActor, lists: AllowLists): boolean {
  if (actor.group !== undefined) {
    if (lists.groupDenylist.has(actor.group)) return false;
    return lists.groupAllowlist.has(actor.group);
  }

  if (actor.userId !== undefined) {
    if (lists.privateDenylist.has(actor.userId)) return false;
    if (lists.privateOpen) return true;
    return lists.privateAllowlist.has(actor.userId);
  }

  return false;
}
