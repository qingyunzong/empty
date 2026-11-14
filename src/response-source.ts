/**
 * 请求来源判定组件：区分 network / service-worker / memory-cache / disk-cache。
 *
 * 证据来源按可信度分三层：
 * 1. CDP / DevTools 显式标志（fromServiceWorker / fromDiskCache / fromMemoryCache）
 * 2. PerformanceResourceTiming 语义字段（workerStart、deliveryType）
 * 3. 传输尺寸启发式（transferSize / encodedBodySize）
 */

export type ResponseSource =
  | "network"
  | "service-worker"
  | "memory-cache"
  | "disk-cache"
  | "unknown";

export interface ResponseEvidence {
  /** CDP Network.Response.fromServiceWorker */
  fromServiceWorker?: boolean;
  /** CDP Network.Response.fromDiskCache */
  fromDiskCache?: boolean;
  /** CDP Network.Response.fromMemoryCache（部分工具链暴露） */
  fromMemoryCache?: boolean;
  /** CDP Network.Response.fromPrefetchCache，预取缓存驻留内存 */
  fromPrefetchCache?: boolean;
  /** PerformanceResourceTiming.workerStart，>0 表示经过 SW */
  workerStart?: number;
  /** PerformanceResourceTiming.deliveryType（"cache" | "" 等） */
  deliveryType?: string;
  /** PerformanceResourceTiming.transferSize */
  transferSize?: number;
  /** PerformanceResourceTiming.encodedBodySize */
  encodedBodySize?: number;
  /** PerformanceResourceTiming.decodedBodySize */
  decodedBodySize?: number;
  /** HTTP 状态码；304 视为网络再验证 */
  status?: number;
}

export interface Classification {
  source: ResponseSource;
  /** 判定所依据的证据层级，便于审计 */
  basis: "explicit-flag" | "timing-field" | "heuristic" | "insufficient-evidence";
  reason: string;
}

export function classifyResponse(evidence: ResponseEvidence): Classification {
  // 第一层：显式标志
  if (evidence.fromServiceWorker === true) {
    return {
      source: "service-worker",
      basis: "explicit-flag",
      reason: "fromServiceWorker=true",
    };
  }
  if (evidence.fromMemoryCache === true) {
    return {
      source: "memory-cache",
      basis: "explicit-flag",
      reason: "fromMemoryCache=true",
    };
  }
  if (evidence.fromDiskCache === true) {
    return {
      source: "disk-cache",
      basis: "explicit-flag",
      reason: "fromDiskCache=true",
    };
  }
  if (evidence.fromPrefetchCache === true) {
    return {
      source: "memory-cache",
      basis: "explicit-flag",
      reason: "fromPrefetchCache=true（预取缓存驻留内存）",
    };
  }

  // 第二层：PerformanceResourceTiming 语义字段
  if (typeof evidence.workerStart === "number" && evidence.workerStart > 0) {
    return {
      source: "service-worker",
      basis: "timing-field",
      reason: `workerStart=${evidence.workerStart} > 0`,
    };
  }
  if (evidence.deliveryType === "cache") {
    return classifyCacheByTransferSize(evidence, "timing-field");
  }

  // 第三层：传输尺寸启发式
  const { transferSize, encodedBodySize, status } = evidence;
  if (status === 304) {
    return {
      source: "network",
      basis: "heuristic",
      reason: "304 再验证，响应头来自网络",
    };
  }
  if (typeof transferSize === "number") {
    if (transferSize === 0 && (encodedBodySize ?? 0) > 0) {
      return classifyCacheByTransferSize(evidence, "heuristic");
    }
    if (transferSize > 0) {
      return {
        source: "network",
        basis: "heuristic",
        reason: `transferSize=${transferSize} > 0，存在线上传输`,
      };
    }
  }

  return {
    source: "unknown",
    basis: "insufficient-evidence",
    reason: "证据不足，无法区分来源",
  };
}

function classifyCacheByTransferSize(
  evidence: ResponseEvidence,
  basis: "timing-field" | "heuristic",
): Classification {
  // Chromium 行为：memory cache 命中 transferSize 恒为 0；
  // disk cache 命中在多数版本同样为 0，但旧版本会带上响应头尺寸（非 0 小值）。
  // 无显式标志时无法可靠区分两者，transferSize=0 时按 memory cache 处理。
  if ((evidence.transferSize ?? 0) === 0) {
    return {
      source: "memory-cache",
      basis,
      reason: "transferSize=0 且 body 非空，判定为 memory cache 命中",
    };
  }
  return {
    source: "disk-cache",
    basis,
    reason: `deliveryType=cache 且 transferSize=${evidence.transferSize}，倾向 disk cache`,
  };
}

/** 判定结果是否为"新鲜网络证据"——仅接受 network。 */
export function isFreshNetworkEvidence(result: Classification): boolean {
  return result.source === "network";
}
