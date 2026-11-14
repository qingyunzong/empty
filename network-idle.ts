// 网络静默状态机：供页面抓取器直接接入。
//
// 事件驱动，不依赖固定 sleep：静默窗口从最后一个相关请求进入终态
// （完成 / 失败 / 中止）的时刻起算，期间出现新的相关请求则窗口重置。
// 取消与超时都会返回当前阻塞证据快照。

export type RequestKind =
  | "document"
  | "xhr"
  | "fetch"
  | "websocket"
  | "eventsource"
  | "preload"
  | "other";

export type SettleReason = "finished" | "failed" | "aborted";

export interface RequestStartedEvent {
  id: string;
  url: string;
  method?: string;
  /** 资源类型，如 document/xhr/fetch/websocket/eventsource/script/image… */
  resourceType?: string;
  /** 请求由 service worker 处理（含 SW 缓存命中与 SW 发起的转发）。 */
  fromServiceWorker?: boolean;
  /** 由 <link rel="preload"> 或预加载扫描器发起的请求。 */
  isPreload?: boolean;
  startedAt?: number;
}

export interface RequestSettledEvent {
  reason: SettleReason;
  settledAt?: number;
}

export interface IgnoreRule {
  /** 匹配 URL 的正则或子串。 */
  url?: RegExp | string;
  /** 匹配 resourceType。 */
  resourceType?: string;
  /** 匹配请求方法。 */
  method?: string;
}

export interface NetworkIdleOptions {
  /** 静默窗口时长（ms），从最后一个相关请求终态起算。默认 500。 */
  quietWindowMs?: number;
  /** service worker 处理的请求是否计入阻塞。默认 false（区分但不阻塞）。 */
  countServiceWorkerRequests?: boolean;
  /** 预加载请求是否计入阻塞。默认 true。 */
  countPreloadRequests?: boolean;
  /** 同一 method+URL 在该窗口内出现达到阈值即判定为轮询。默认 10000ms。 */
  pollingWindowMs?: number;
  /** 轮询判定阈值（次数）。默认 3。 */
  pollingThreshold?: number;
  /** 用户配置的忽略规则，命中的请求完全不参与静默判定。 */
  ignoreRules?: IgnoreRule[];
  /** 注入时钟，便于测试。默认 Date.now。 */
  now?: () => number;
}

export interface BlockingEvidence {
  id: string;
  url: string;
  method: string;
  kind: RequestKind;
  startedAt: number;
  ageMs: number;
  reason: "in-flight";
}

export type WaitForIdleResult =
  | { status: "idle"; idleSince: number; waitedMs: number }
  | { status: "timeout"; waitedMs: number; blocking: BlockingEvidence[] }
  | { status: "cancelled"; waitedMs: number; blocking: BlockingEvidence[] };

export interface WaitOptions {
  /** 覆盖本次等待的静默窗口时长。 */
  quietWindowMs?: number;
  /** 最长等待时间（ms）。超时返回当前阻塞证据而非抛出。 */
  timeoutMs?: number;
  /** 取消信号。取消返回当前阻塞证据而非抛出。 */
  signal?: AbortSignal;
}

interface TrackedRequest {
  id: string;
  url: string;
  method: string;
  kind: RequestKind;
  startedAt: number;
}

interface Waiter {
  quietWindowMs: number;
  deadline: number | null;
  startedWaitingAt: number;
  quietTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  resolve: (result: WaitForIdleResult) => void;
}

const PERSISTENT_TYPES = new Set(["websocket", "eventsource"]);

function normalizeKind(event: RequestStartedEvent): RequestKind {
  const type = (event.resourceType ?? "").toLowerCase();
  if (PERSISTENT_TYPES.has(type)) return type as RequestKind;
  if (event.isPreload || type === "preload") return "preload";
  if (type === "document" || type === "xhr" || type === "fetch") return type;
  return "other";
}

function matchesRule(rule: IgnoreRule, event: RequestStartedEvent): boolean {
  if (rule.url !== undefined) {
    const hit =
      typeof rule.url === "string"
        ? event.url.includes(rule.url)
        : rule.url.test(event.url);
    if (!hit) return false;
  }
  if (rule.resourceType !== undefined) {
    const type = (event.resourceType ?? "").toLowerCase();
    if (type !== rule.resourceType.toLowerCase()) return false;
  }
  if (rule.method !== undefined) {
    if ((event.method ?? "GET").toUpperCase() !== rule.method.toUpperCase()) {
      return false;
    }
  }
  return true;
}

export class NetworkIdleMonitor {
  private readonly quietWindowMs: number;
  private readonly countServiceWorkerRequests: boolean;
  private readonly countPreloadRequests: boolean;
  private readonly pollingWindowMs: number;
  private readonly pollingThreshold: number;
  private readonly ignoreRules: IgnoreRule[];
  private readonly now: () => number;

  /** 参与静默判定、仍在飞的请求。 */
  private readonly inFlight = new Map<string, TrackedRequest>();
  /** 持续连接（WebSocket / SSE），单独跟踪，永不阻塞静默。 */
  private readonly persistentConnections = new Map<string, TrackedRequest>();
  /** 被忽略规则命中的请求 id，终态事件到达时用于清理。 */
  private readonly ignoredIds = new Set<string>();
  /** 已判定为轮询的 method+URL 端点。 */
  private readonly pollingEndpoints = new Set<string>();
  /** 近期相关请求的终态历史，用于轮询检测：endpoint -> 终态时间列表。 */
  private readonly settleHistory = new Map<string, number[]>();
  /** 最后一个相关请求进入终态的时间；尚无终态时为监控器创建时间。 */
  private lastRelevantSettledAt: number;
  private generation = 0;
  private readonly waiters = new Set<Waiter>();

  constructor(options: NetworkIdleOptions = {}) {
    this.quietWindowMs = options.quietWindowMs ?? 500;
    this.countServiceWorkerRequests = options.countServiceWorkerRequests ?? false;
    this.countPreloadRequests = options.countPreloadRequests ?? true;
    this.pollingWindowMs = options.pollingWindowMs ?? 10_000;
    this.pollingThreshold = options.pollingThreshold ?? 3;
    this.ignoreRules = options.ignoreRules ?? [];
    this.now = options.now ?? Date.now;
    this.lastRelevantSettledAt = this.now();
  }

  /** 当前导航代数，导航切换时递增。 */
  get navigationGeneration(): number {
    return this.generation;
  }

  /** 当前打开的持续连接快照（WebSocket / SSE）。 */
  get openPersistentConnections(): readonly TrackedRequest[] {
    return [...this.persistentConnections.values()];
  }

  /** 已判定为轮询的端点（"METHOD url" 形式）。 */
  get detectedPollingEndpoints(): readonly string[] {
    return [...this.pollingEndpoints];
  }

  /** 当前阻塞证据快照。 */
  getBlockingEvidence(): BlockingEvidence[] {
    const now = this.now();
    return [...this.inFlight.values()].map((req) => ({
      id: req.id,
      url: req.url,
      method: req.method,
      kind: req.kind,
      startedAt: req.startedAt,
      ageMs: now - req.startedAt,
      reason: "in-flight",
    }));
  }

  /** 请求开始。返回该请求是否参与静默判定。 */
  requestStarted(event: RequestStartedEvent): boolean {
    if (this.ignoreRules.some((rule) => matchesRule(rule, event))) {
      this.ignoredIds.add(event.id);
      return false;
    }

    const kind = normalizeKind(event);
    const tracked: TrackedRequest = {
      id: event.id,
      url: event.url,
      method: (event.method ?? "GET").toUpperCase(),
      kind,
      startedAt: event.startedAt ?? this.now(),
    };

    if (kind === "websocket" || kind === "eventsource") {
      this.persistentConnections.set(event.id, tracked);
      return false;
    }
    if (event.fromServiceWorker && !this.countServiceWorkerRequests) {
      this.ignoredIds.add(event.id);
      return false;
    }
    if (kind === "preload" && !this.countPreloadRequests) {
      this.ignoredIds.add(event.id);
      return false;
    }
    if (this.pollingEndpoints.has(this.endpointKey(tracked))) {
      this.ignoredIds.add(event.id);
      return false;
    }

    this.inFlight.set(event.id, tracked);
    this.reevaluateWaiters();
    return true;
  }

  /** 请求进入终态（完成 / 失败 / 中止）。 */
  requestSettled(id: string, event: RequestSettledEvent = { reason: "finished" }): void {
    void event;
    if (this.ignoredIds.delete(id)) {
      this.persistentConnections.delete(id);
      return;
    }
    if (this.persistentConnections.delete(id)) {
      return;
    }
    const tracked = this.inFlight.get(id);
    if (!tracked) return;

    const settledAt = event.settledAt ?? this.now();
    this.inFlight.delete(id);
    this.lastRelevantSettledAt = settledAt;
    this.recordSettleForPollingDetection(tracked, settledAt);
    this.reevaluateWaiters();
  }

  /** 导航切换：清空旧页面所有请求与等待依据，从头累计静默。 */
  navigationCommitted(): void {
    this.generation += 1;
    this.inFlight.clear();
    this.persistentConnections.clear();
    this.ignoredIds.clear();
    this.pollingEndpoints.clear();
    this.settleHistory.clear();
    this.lastRelevantSettledAt = this.now();
    this.reevaluateWaiters();
  }

  // 等待网络静默：无相关在飞请求，且自最后一个相关请求终态起
  // 已经过 quietWindowMs。超时或取消时返回当前阻塞证据。
  waitForIdle(options: WaitOptions = {}): Promise<WaitForIdleResult> {
    const quietWindowMs = options.quietWindowMs ?? this.quietWindowMs;
    const startedWaitingAt = this.now();

    return new Promise<WaitForIdleResult>((resolve) => {
      const waiter: Waiter = {
        quietWindowMs,
        deadline:
          options.timeoutMs !== undefined
            ? startedWaitingAt + options.timeoutMs
            : null,
        startedWaitingAt,
        quietTimer: null,
        timeoutTimer: null,
        onAbort: null,
        resolve,
      };

      const finish = (result: WaitForIdleResult) => {
        if (waiter.quietTimer) clearTimeout(waiter.quietTimer);
        if (waiter.timeoutTimer) clearTimeout(waiter.timeoutTimer);
        if (waiter.onAbort && options.signal) {
          options.signal.removeEventListener("abort", waiter.onAbort);
        }
        this.waiters.delete(waiter);
        resolve(result);
      };

      waiter.resolve = (result) => finish(result);

      if (options.signal) {
        if (options.signal.aborted) {
          finish({
            status: "cancelled",
            waitedMs: this.now() - startedWaitingAt,
            blocking: this.getBlockingEvidence(),
          });
          return;
        }
        waiter.onAbort = () => {
          finish({
            status: "cancelled",
            waitedMs: this.now() - startedWaitingAt,
            blocking: this.getBlockingEvidence(),
          });
        };
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      if (waiter.deadline !== null) {
        waiter.timeoutTimer = setTimeout(() => {
          finish({
            status: "timeout",
            waitedMs: this.now() - startedWaitingAt,
            blocking: this.getBlockingEvidence(),
          });
        }, Math.max(0, waiter.deadline - this.now()));
      }

      this.waiters.add(waiter);
      this.reevaluateWaiter(waiter);
    });
  }

  private endpointKey(req: { method: string; url: string }): string {
    return `${req.method} ${req.url}`;
  }

  private recordSettleForPollingDetection(req: TrackedRequest, settledAt: number): void {
    const key = this.endpointKey(req);
    const history = this.settleHistory.get(key) ?? [];
    history.push(settledAt);
    const cutoff = settledAt - this.pollingWindowMs;
    const recent = history.filter((t) => t >= cutoff);
    this.settleHistory.set(key, recent);
    if (recent.length >= this.pollingThreshold) {
      this.pollingEndpoints.add(key);
    }
  }

  private reevaluateWaiters(): void {
    for (const waiter of [...this.waiters]) {
      this.reevaluateWaiter(waiter);
    }
  }

  private reevaluateWaiter(waiter: Waiter): void {
    if (!this.waiters.has(waiter)) return;
    if (waiter.quietTimer) {
      clearTimeout(waiter.quietTimer);
      waiter.quietTimer = null;
    }
    if (this.inFlight.size > 0) return;

    const now = this.now();
    const idleSince = this.lastRelevantSettledAt;
    const remaining = waiter.quietWindowMs - (now - idleSince);
    if (remaining <= 0) {
      waiter.resolve({
        status: "idle",
        idleSince,
        waitedMs: now - waiter.startedWaitingAt,
      });
      return;
    }
    if (waiter.deadline !== null && waiter.deadline - now <= remaining) {
      return; // 超时定时器会先触发，届时返回阻塞证据。
    }
    waiter.quietTimer = setTimeout(() => {
      waiter.quietTimer = null;
      this.reevaluateWaiter(waiter);
    }, remaining);
  }
}
