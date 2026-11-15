# HTTP Link 分页循环

REST 连接器需要可导入的 TypeScript Link header 分页组件，正确解析 quoted-string、相对 URI、多 rel 和逗号歧义。next URL 规范化后纳入访问集合，循环返回路径；跨 origin next 按白名单拒绝。当前页落库确认后才提交下一链接恢复点。

## 模块

- `src/link-header.ts` — RFC 8288 Link header 解析器（`parseLinkHeader` / `findLink`）。
  正确处理 quoted-string（含转义与内部逗号/分号）、`<...>` 内 URI 的逗号、
  单条 `rel="next prev"` 多关系值、token 形式参数值，并容忍空列表项。
- `src/paginator.ts` — 分页循环（`paginate` / `normalizeUrl`）。
- `index.ts` — 统一导出入口。

## 用法

```ts
import { paginate } from './index.ts';

const result = await paginate({
  startUrl: 'https://api.example.com/items',
  fetchPage: async (url) => {
    const res = await fetch(url);
    return { body: await res.json(), linkHeader: res.headers.get('link') };
  },
  sink: async (page) => {
    await db.insert(page); // 必须落库确认后再 resolve
  },
  allowedOrigins: ['https://cdn.example.com'], // 跨 origin next 白名单
  checkpointStore: {
    commit: async ({ nextUrl }) => {
      await store.saveResumePoint(nextUrl); // 仅在 sink 确认后调用
    },
  },
  resumeFrom: await store.loadResumePoint(), // 断点恢复
});
// result.path    — 规范化后的访问路径（按抓取顺序）
// result.status  — 'completed' | 'cycle-detected' | 'max-pages-reached'
```

行为保证：

- next URL 先相对当前页解析并规范化（小写 scheme/host、去默认端口、去 fragment），
  纳入访问集合；命中已访问 URL 时判定循环，返回已采集路径。
- next 的 origin 不在白名单（起始 origin 默认包含）时抛出 `CrossOriginNextError`，
  且该 URL 不会被提交为恢复点。
- 每页严格按 fetch → 校验 next → `sink` 落库 → 提交恢复点 的顺序执行；
  `sink` 失败时不会提交任何恢复点。

## 测试

```sh
npm test        # tsc 编译到 dist/ 后运行 node:test（本机 Node 未内置类型剥离）
npm run typecheck
```
