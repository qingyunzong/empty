/**
 * Service Worker 旁路验证流程。
 *
 * 当任务要求"新鲜网络证据"时，必须按顺序完成：
 *   1. 注销所有 SW 注册并等待页面失去 SW 控制（controller === null）
 *   2. 创建新文档世代（完整导航，而非 bfcache 恢复或同文档渲染）
 *   3. 在新世代内采集目标请求并核对 response source 为 network
 *
 * 仅清理某一个 cache（如 caches.delete）不构成旁路证据。
 */

import {
  classifyResponse,
  isFreshNetworkEvidence,
  type Classification,
  type ResponseEvidence,
} from "./response-source.ts";

/** 可被浏览器页面或 CDP 适配层实现的环境接口 */
export interface BrowserEnv {
  /** 当前控制页面的 SW scriptURL；无控制时返回 null */
  getSwController(): Promise<string | null>;
  /** 注销所有 SW 注册，返回注销数量 */
  unregisterAllServiceWorkers(): Promise<number>;
  /** 触发完整导航，创建新文档世代，返回新世代 ID（单调递增） */
  navigateNewDocument(url: string): Promise<number>;
  /** 当前文档世代 ID */
  getDocumentGeneration(): Promise<number>;
  /** 采集指定 URL 最近一次请求的响应证据 */
  collectEvidence(url: string): Promise<ResponseEvidence>;
}

export interface BypassOptions {
  /** 等待 SW 失控的超时毫秒数，默认 5000 */
  swLoseControlTimeoutMs?: number;
  /** 轮询间隔毫秒数，默认 100 */
  pollIntervalMs?: number;
}

export interface BypassVerification {
  ok: boolean;
  unregisteredCount: number;
  generationBefore: number;
  generationAfter: number;
  classification: Classification;
  failureReason?: string;
}

export class BypassError extends Error {}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 步骤 1：注销 SW 并等待页面失控 */
export async function waitForSwLoseControl(
  env: BrowserEnv,
  options: BypassOptions = {},
): Promise<number> {
  const timeout = options.swLoseControlTimeoutMs ?? 5000;
  const interval = options.pollIntervalMs ?? 100;
  const unregistered = await env.unregisterAllServiceWorkers();

  const deadline = Date.now() + timeout;
  for (;;) {
    const controller = await env.getSwController();
    if (controller === null) {
      return unregistered;
    }
    if (Date.now() >= deadline) {
      throw new BypassError(
        `等待 SW 失控超时（${timeout}ms），当前 controller=${controller}`,
      );
    }
    await sleep(interval);
  }
}

/** 步骤 2：创建新文档世代，并确认世代号确实前进 */
export async function createDocumentGeneration(
  env: BrowserEnv,
  url: string,
): Promise<{ before: number; after: number }> {
  const before = await env.getDocumentGeneration();
  const after = await env.navigateNewDocument(url);
  if (after <= before) {
    throw new BypassError(
      `导航未产生新文档世代：before=${before} after=${after}`,
    );
  }
  return { before, after };
}

/**
 * 完整旁路验证：失控 → 新世代 → 核对 response source。
 * 任何一步失败都会抛出 BypassError 或返回 ok=false，绝不提前宣称成功。
 */
export async function verifyFreshNetworkEvidence(
  env: BrowserEnv,
  url: string,
  options: BypassOptions = {},
): Promise<BypassVerification> {
  const generationBefore = await env.getDocumentGeneration();
  const unregisteredCount = await waitForSwLoseControl(env, options);
  const { after: generationAfter } = await createDocumentGeneration(env, url);

  const evidence = await env.collectEvidence(url);
  const classification = classifyResponse(evidence);

  if (!isFreshNetworkEvidence(classification)) {
    return {
      ok: false,
      unregisteredCount,
      generationBefore,
      generationAfter,
      classification,
      failureReason:
        `旁路后响应来源为 ${classification.source}（${classification.reason}），` +
        "不构成新鲜网络证据",
    };
  }

  return {
    ok: true,
    unregisteredCount,
    generationBefore,
    generationAfter,
    classification,
  };
}
