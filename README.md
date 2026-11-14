# 会话 cookie 分区采集

浏览器连接器需要可导入的 TypeScript cookie 快照库，表示 domain/path、SameSite、Secure、HttpOnly、partition key 和 expiry。导入快照前按目标 top-level site 筛选，不能把分区 cookie 降为普通 cookie；并发 Set-Cookie 按响应世代合并，过期删除不会被旧快照复活。

本包实现并验证了上述约束。实现位于 `index.ts`，无运行时依赖。

## 数据模型

`SnapshotCookie` 是规范化后的快照项：

| 字段 | 说明 |
| --- | --- |
| `name`, `value` | cookie 名称与值 |
| `domain`, `path` | 规范化 domain 与 path；domain cookie 保留前导点 |
| `hostOnly` | 是否为 host-only cookie |
| `sameSite` | `"Strict" \| "Lax" \| "None"` |
| `secure`, `httpOnly` | 对应 cookie 标志 |
| `partitionKey` | `{ topLevelSite, hasCrossSiteAncestor }`，`null` 表示未分区 |
| `expires` | Unix epoch 毫秒；`null` 表示 session cookie |
| `generation` | 产生该状态的响应世代，越大越新 |

`CookieTombstone` 表示被删除的 cookie。它保留身份与世代，导出快照时默认包含，防止旧快照把删除掉的 cookie 再导回来。

输入兼容 Chrome cookies API 风格：`expirationDate`（秒）、`sameSite: "no_restriction" | "unspecified"`、`hostOnly`、`session` 均可直接导入。其他浏览器字段会被忽略。

## 快速开始

```ts
import {
  CookieJar,
  importSnapshot,
  mergeSetCookieEvents,
} from "./index.ts";

const target = "https://app.example.com";

// 1. 导入快照：先按 top-level site 过滤，再按 generation 合并。
const imported = importSnapshot(
  {
    format: "cookie-snapshot/v1",
    generation: 3,
    topLevelSite: target,
    cookies: [
      {
        name: "sid",
        value: "abc",
        domain: ".example.com",
        path: "/",
        sameSite: "lax",
        secure: true,
        httpOnly: true,
        partitionKey: {
          topLevelSite: target,
          hasCrossSiteAncestor: false,
        },
        expires: 1_900_000_000_000,
        generation: 3,
      },
    ],
  },
  target,
);

// 分区 cookie 仍带 partitionKey，没有被降级为普通 cookie。
console.log(imported.cookies[0].partitionKey);

// 2. 并发响应按 generation 合并；旧响应晚到也不会覆盖新响应。
const merged = mergeSetCookieEvents([
  {
    header: "sid=new; Path=/; Max-Age=3600",
    generation: 8,
    topLevelSite: target,
    requestUrl: "https://example.com/",
  },
  {
    header: "sid=old; Path=/; Max-Age=3600",
    generation: 4,
    topLevelSite: target,
    requestUrl: "https://example.com/",
  },
]);
console.log(merged.cookies.find((cookie) => cookie.name === "sid")?.value); // new
```

需要增量处理响应时，使用有状态的 `CookieJar`：

```ts
const jar = new CookieJar();

jar.applyResponse(
  [
    "sid=new; Path=/; Max-Age=3600",
    "theme=dark; Path=/; Max-Age=3600",
  ],
  {
    generation: 8,
    topLevelSite: "https://app.example.com",
    requestUrl: "https://example.com/",
  },
);

// 更旧的响应晚到：sid 保持 new，但响应中独有的 cookie 仍可合并。
jar.applyResponse(["sid=stale; Path=/; Max-Age=3600"], {
  generation: 4,
  topLevelSite: "https://app.example.com",
  requestUrl: "https://example.com/",
});

const snapshot = jar.toSnapshot(); // 包含 tombstones
```

## API

- `importSnapshot(snapshot, optionsOrTopLevelSite?)`：单快照导入，返回过滤与合并后的 `CookieSnapshot`。
- `mergeSnapshots(snapshots, optionsOrTopLevelSite?)`：按世代合并多个快照；输入顺序不影响冲突结果。
- `filterSnapshotForTopLevelSite(snapshot, topLevelSite, { now? })`：纯筛选，不修改 partition key。
- `parseCookieSnapshot(snapshot, { now? })`：校验并规范化 JSON 字符串、数组或快照对象。
- `mergeSetCookieEvents(events, { now?, topLevelSite? })`：合并并发 `Set-Cookie` 事件。
- `applySetCookie(header, context)` / `applySetCookies(headers, context)`：无状态单响应辅助函数。
- `parseSetCookie(header, { now? })`：解析单个 `Set-Cookie` 头，`Max-Age` 优先于 `Expires`。
- `CookieJar`：有状态容器，支持 `import`、`importSnapshot`、`applySetCookie(s)`、`applyResponse`、`getCookies`、`getCookie`、`toSnapshot`/`export`。

`SetCookieContext` 的 `generation` 必须单调递增（数字或数字字符串）。同一世代内可用 `sequence` 区分头顺序；一般无需手动设置。

## 关键语义

- **筛选发生在合并之前。** `topLevelSite` 目标缺失时直接报错，不会在未指定目标的情况下导入。
- **未分区 cookie 是全局的**，可以导入任意目标；**分区 cookie** 只有 `partitionKey.topLevelSite` 与目标规范化后相等才导入。
- **绝不降级分区 cookie。** 不匹配的分区项被整体跳过；缺少 `partitionKey.topLevelSite` 的记录会抛错，而不是去掉 key 后当作普通 cookie。
- **`hasCrossSiteAncestor` 原样保留。** 同一站点但该标志不同的分区 cookie 仍是不同身份。
- **实例之间按 cookie 身份合并**：`(name, hostOnly, domain, path, partitionKey)`。同身份冲突时世代大者胜，同世代时删除（tombstone）胜。
- **过期即删除。** 导入时 `expires <= now` 的记录转为 tombstone；自然过期在读取/导出时同样转为 tombstone，因此旧快照无法复活。
- **域/path 规范化。** 域大小写、尾点、path 缺省 `/` 会规范化；domain cookie 的前导点保留。
- **站点规范化。** 忽略端口、path、query、fragment 与主机尾点；裸主机默认按 `https://` 处理。

## 测试

```sh
npm test        # 转译到 .test-dist 后运行 node:test
npm run typecheck
```

测试覆盖：分区分流、CHIPS `Partitioned` 不降级、乱序并发响应、删除 tombstone、过期删除、旧快照/旧响应回放、Chrome 风格字段与 `Max-Age` 优先级。
