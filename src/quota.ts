import { QuotaExceededError } from "./errors";

export interface TenantQuotaSnapshot {
  readonly limitBytes: number;
  readonly reservedBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
}

interface TenantQuota {
  limitBytes: number;
  reservedBytes: number;
  usedBytes: number;
}

/**
 * 租户额度账本：limit 约束 used + reserved。
 * 预留（reserve）先占用额度；结算（settle）把预留转成实际用量并归还差额；
 * 释放（release）把未用的预留全额归还。
 * 缩额（setLimit 调低）只影响新的预留，不撤销已存在的预留。
 */
export class TenantQuotaLedger {
  private readonly tenants = new Map<string, TenantQuota>();

  private quotaOf(tenantId: string): TenantQuota {
    let quota = this.tenants.get(tenantId);
    if (quota === undefined) {
      quota = { limitBytes: 0, reservedBytes: 0, usedBytes: 0 };
      this.tenants.set(tenantId, quota);
    }
    return quota;
  }

  setLimit(tenantId: string, limitBytes: number): void {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      throw new RangeError(`limitBytes must be a non-negative safe integer, got ${limitBytes}`);
    }
    this.quotaOf(tenantId).limitBytes = limitBytes;
  }

  reserve(tenantId: string, bytes: number): void {
    assertAmount(bytes, "reserve");
    const quota = this.quotaOf(tenantId);
    const projected = quota.usedBytes + quota.reservedBytes + bytes;
    if (projected > quota.limitBytes) {
      throw new QuotaExceededError(
        `tenant ${tenantId}: reserving ${bytes}B would exceed limit ` +
          `(limit=${quota.limitBytes}B, used=${quota.usedBytes}B, reserved=${quota.reservedBytes}B)`,
      );
    }
    quota.reservedBytes += bytes;
  }

  /** 结束结算：预留 reservedBytes 中实际消耗 actualBytes，差额归还。 */
  settle(tenantId: string, reservedBytes: number, actualBytes: number): void {
    assertAmount(reservedBytes, "settle.reserved");
    assertAmount(actualBytes, "settle.actual");
    if (actualBytes > reservedBytes) {
      throw new RangeError(
        `settle actual ${actualBytes}B exceeds reserved ${reservedBytes}B for tenant ${tenantId}`,
      );
    }
    const quota = this.quotaOf(tenantId);
    if (reservedBytes > quota.reservedBytes) {
      throw new RangeError(
        `settle reserved ${reservedBytes}B exceeds outstanding reservation ${quota.reservedBytes}B for tenant ${tenantId}`,
      );
    }
    quota.reservedBytes -= reservedBytes;
    quota.usedBytes += actualBytes;
  }

  /** 取消释放：把未消耗的预留全额归还。 */
  release(tenantId: string, bytes: number): void {
    assertAmount(bytes, "release");
    const quota = this.quotaOf(tenantId);
    if (bytes > quota.reservedBytes) {
      throw new RangeError(
        `release ${bytes}B exceeds outstanding reservation ${quota.reservedBytes}B for tenant ${tenantId}`,
      );
    }
    quota.reservedBytes -= bytes;
  }

  snapshot(tenantId: string): TenantQuotaSnapshot {
    const quota = this.quotaOf(tenantId);
    return {
      limitBytes: quota.limitBytes,
      reservedBytes: quota.reservedBytes,
      usedBytes: quota.usedBytes,
      availableBytes: Math.max(0, quota.limitBytes - quota.usedBytes - quota.reservedBytes),
    };
  }
}

function assertAmount(bytes: number, op: string): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError(`${op} amount must be a non-negative safe integer, got ${bytes}`);
  }
}
