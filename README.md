# SSO 重定向流程边界

企业 RPA 登录协调器可直接接入 TypeScript SSO 导航状态机。它只做四件事：校验允许的 issuer、校验 redirect origin、绑定并比较 state、拒绝旧页面世代。多 IdP 选择和 MFA 人工步骤会让流程进入可暂停状态；任何跨域、state 变化或旧标签页返回都会让当前流程立即、不可恢复地隔离。组件不读取密码、OTP、授权码或令牌值，只输出下一动作与脱敏证据。

## 快速接入

```ts
import { createSsoLoginCoordinator } from "./index.js";

const coordinator = createSsoLoginCoordinator({
  allowedIssuers: [
    "https://login.microsoftonline.com/tenant/v2.0",
    "https://idp.example.com/tenant",
  ],
  allowedRedirectOrigins: ["https://rpa.example.com"],
  applicationOrigins: ["https://rpa.example.com"],
  expectedState: stateFromAuthorizationRequest,
});

const decision = coordinator.begin(
  { tabId: "login-tab", generation: 0 },
  "https://rpa.example.com/login",
);

switch (decision.action.type) {
  case "wait_for_redirect":
    await browser.waitForTopLevelNavigation();
    break;
  case "select_idp":
    await ui.select(decision.action.candidates);
    break;
  case "await_mfa":
    await ui.completeMfa(decision.action.methods);
    break;
  case "login_complete":
    await rpa.continueWith(decision.action.issuer);
    break;
  case "isolate":
    await rpa.quarantine(decision.action.code, decision.evidence);
    break;
}
```

浏览器导航提交后，把顶层页面事件送入协调器：

```ts
coordinator.dispatch({
  type: "navigation",
  page: { tabId: "login-tab", generation: 1 },
  url: "https://idp.example.com/tenant/authorize?state=...&client_id=rpa",
});

coordinator.dispatch({
  type: "idp_choice",
  page: { tabId: "login-tab", generation: 1 },
  candidates: [
    { id: "work", displayName: "Work account", issuer: "https://idp.example.com/tenant" },
    { id: "partner", displayName: "Partner account", issuer: "https://login.microsoftonline.com/tenant/v2.0" },
  ],
});

coordinator.dispatch({
  type: "idp_selected",
  page: { tabId: "login-tab", generation: 1 },
  idpId: "work",
});

coordinator.dispatch({
  type: "mfa_challenge",
  page: { tabId: "login-tab", generation: 2 },
  methods: ["push", "otp"],
});

coordinator.dispatch({
  type: "mfa_completed",
  page: { tabId: "login-tab", generation: 2 },
});

const completed = coordinator.dispatch({
  type: "auth_callback",
  page: { tabId: "login-tab", generation: 3 },
  url: "https://rpa.example.com/callback?code=...&state=...",
  issuer: "https://idp.example.com/tenant",
});
```

`dispatch()` 每次都返回不可变快照：

```ts
interface CoordinatorSnapshot {
  phase: "idle" | "navigating" | "awaiting_idp_selection" | "awaiting_mfa" | "completed" | "isolated";
  page: { tabId: string; generation: number } | null;
  action: NextAction;
  evidence: readonly EvidenceRecord[];
}
```

## 登录完成条件

只有下列条件同时成立才会产生 `login_complete`：

- 回调页面属于 `allowedRedirectOrigins` 中的精确 origin。
- issuer 与 `allowedIssuers` 中的某一项精确匹配。可从事件字段或 URL 的 `iss` 参数取得；两者冲突会隔离。
- state 与启动时绑定的 `expectedState` 恒定时间比较一致。可从事件字段或 URL 的 `state` 参数取得；缺失、重复、冲突或变化都会隔离。
- 事件页面属于绑定的 `tabId`，且 `generation` 不低于当前世代。
- 当前不处于 IdP 选择或 MFA 暂停阶段。

`type: "navigation"` 事件若已经携带可验证的 issuer、state，并落在允许的 redirect origin，也可直接完成登录，便于只产生导航事件的状态机接入。

## 暂停与恢复

- `idp_choice` 输出 `select_idp`，只列出 issuer 在允许列表内的候选。未授权候选会被过滤并记录证据；一个可用候选都没有时立即隔离。
- `idp_selected` 只能选择当前提示中出现过的 id；未知 id 立即隔离。
- `mfa_challenge` 输出 `await_mfa`。人工步骤完成后由 RPA 发送 `mfa_completed`，不需要也不允许携带验证码。
- 暂停期间到达认证回调视为绕过人工步骤，立即隔离。
- `issuer` 应由适配层在完成 token 校验后提供；组件不解析 ID token。候选中的 `displayName` 属于 IdP 提供的非受信文本，UI 必须按文本渲染。

## 隔离规则

隔离是终态。进入 `isolated` 后，同一协调器不会再处理事件，也不会再完成登录；必须新建协调器开始新的登录尝试。以下情况会立即隔离：

| 情况 | IsolationCode |
| --- | --- |
| 导航或回调进入未授权的 origin | `UNEXPECTED_ORIGIN` |
| 回调 origin 不在 redirect allowlist | `REDIRECT_ORIGIN_NOT_ALLOWED` |
| issuer 缺失、冲突或不在 allowlist | `ISSUER_MISSING` / `ISSUER_CONFLICT` / `ISSUER_AMBIGUOUS` / `ISSUER_NOT_ALLOWED` |
| state 缺失、重复、冲突或变化 | `STATE_MISSING` / `STATE_AMBIGUOUS` / `STATE_MISMATCH` |
| 旧页面世代或旧标签页返回 | `STALE_PAGE` / `FOREIGN_TAB` |
| 登录完成后仍有页面事件 | `POST_COMPLETION_ACTIVITY` |
| 暂停阶段到达认证回调 | `PAUSED_STEP_BYPASSED` |
| URL 含账号密码、非 HTTP(S) 协议或无法解析 | `INVALID_URL` |
| 授权端点返回 `error` | `AUTHENTICATION_ERROR` |

## 页面世代契约

适配层必须为每个顶层文档分配单调递增的 `generation`，并在同一登录流程中固定 `tabId`。浏览器后退、恢复旧文档或旧标签页重新激活时，必须发送原始页面的世代；协调器会拒绝低于当前世代的事件。标签页重新激活使用：

```ts
coordinator.dispatch({
  type: "page_activated",
  page: { tabId: "login-tab", generation: currentDocumentGeneration },
  url: "https://rpa.example.com/login",
});
```

只接入顶层 frame 的导航。子资源、埋点请求和后台 fetch 不应送入协调器。

## 凭证与证据

- 事件类型没有密码、OTP、授权码、access token 或 refresh token 字段；调用方即使额外传入这些属性，协调器也不会读取或保存。
- 证据中的 URL 只保留 `origin`、`pathname`、查询参数名和是否存在 fragment；所有查询参数值与 fragment 值都会被丢弃。
- state 只以 `statePresent` / `stateMatched` 布尔值出现，不保存原值。
- 证据数组、快照、动作、页面和候选列表都被冻结，后续修改不会影响已返回结果。
- `redactUrl()` 可复用于适配层日志，返回同样的脱敏 URL 结构。

## 开发

```bash
npm run typecheck
npm test
```

实现不依赖第三方运行时包。策略在构造时校验：issuer 和 origin 必须是安全的绝对 HTTP(S) URL，HTTP 只允许 loopback 地址；redirect origin 与 application origin 必须是不带路径、查询和 fragment 的精确 origin。
