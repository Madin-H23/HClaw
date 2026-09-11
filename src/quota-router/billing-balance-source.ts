/**
 * 上游 billing 余额源适配器 — 只读消费上游既有导出（HClaw 原创模块）
 *
 * 用户余额沿上游 billing 体系（src/db.ts 的 user_balances 表），语义原样不改：
 * 适配器不复制不重组上游 UserBalance 类型（import type 单点复用），不判断
 * 余额够不够——那是上游既有 fail-closed 余额闸的职责，本模块**不新建任何
 * 闸门**，只把余额数据供进统一输入类型（routing-inputs.ts），供 fail-open
 * 决策层参考（ADR-0004：三源里唯一保留上游 fail-closed 语义的源是上游
 * 自己的闸，不是这里）。
 *
 * 上游连接（db.ts 模块私有 `db`）不经由本模块取得——装配侧注入上游已导出的
 * 读取函数（getUserBalance，含上游 auto-init 零行语义）或等价的裸读实现；
 * 上游未初始化（读取函数抛错）/上游表查不到（裸读返回 null）→ 显式降级
 * missing，绝不抛异常（fail-open 供数，ADR-0004）。
 */
import type { UserBalance } from '../types.js';

// 上游类型单点复用：本模块的公开面引用它，统一输入层（routing-inputs.ts）经此处转出
export type { UserBalance };

/**
 * 上游余额读取函数：装配侧传 db.ts 导出的 getUserBalance（上游既有导出，
 * 永不返回 null——查无行时按上游语义 auto-init 零行）；裸读实现可返回
 * null 表示查无此行（适配器折 missing 降级）。
 */
export type BillingBalanceReader = (userId: string) => UserBalance | null;

/** 用户余额缺失标记：上游未初始化 / 表查无行 / 读取抛错 */
export interface MissingUserBalance {
  /** 查找键 userId（上游 UserBalance.user_id 同值） */
  readonly userId: string;
  readonly missing: true;
}

export type UserBalanceOrMissing = UserBalance | MissingUserBalance;

export function isMissingUserBalance(
  balance: UserBalanceOrMissing,
): balance is MissingUserBalance {
  return (balance as MissingUserBalance).missing === true;
}

/** 源级降级原因（可解释性）；无降级时 null */
export interface BillingSourceFailure {
  readonly kind: 'reader-error';
  readonly error: string;
}

export interface BillingBalanceSourceOptions {
  /** 上游余额读取函数（注入上游既有导出；本模块不触碰上游文件） */
  readonly readBalance: BillingBalanceReader;
}

export class BillingBalanceSource {
  private readonly readBalance: BillingBalanceReader;
  private failure: BillingSourceFailure | null = null;

  constructor(options: BillingBalanceSourceOptions) {
    this.readBalance = options.readBalance;
  }

  /**
   * 读一个用户的上游余额。成功 → 上游 UserBalance 原样透传（语义零改）；
   * 读取函数抛错（上游未初始化等）或裸读返回 null → missing，不抛异常。
   */
  getUserBalance(userId: string): UserBalanceOrMissing {
    try {
      const balance = this.readBalance(userId);
      if (!balance) return { userId, missing: true };
      return balance;
    } catch (err) {
      this.failure = {
        kind: 'reader-error',
        error: err instanceof Error ? err.message : String(err),
      };
      return { userId, missing: true };
    }
  }

  /** 最近一次降级原因；无降级时 null */
  lastFailure(): BillingSourceFailure | null {
    return this.failure;
  }
}
