# 跨域 iframe 消息配对

嵌入式表单采集需要可直接接入 TypeScript postMessage 配对组件，校验 origin、source window、nonce 与消息阶段，把 iframe 就绪、字段请求和完成回执组成事务。frame 导航后旧 nonce 失效；乱序、重复和迟到消息幂等处理，不能把同源其他 frame 的响应串入。

## 协议

消息均带 `channel: 'embedded-form-bridge'`，事务按阶段推进：

1. `ready`（iframe → 宿主）：iframe 每次加载后广播随机 `bootId`。
2. `init`（宿主 → iframe）：宿主为该 `bootId` 签发一次性 `nonce`，建立会话。
3. `fields-request`（宿主 → iframe）：携带 `nonce` 与 `requestId`，下发字段规格。
4. `complete`（iframe → 宿主）：回显 `nonce` 与 `requestId`，附带采集值。

安全与幂等规则：

- 每条消息都校验 `origin`、`event.source`（必须是该 iframe 当前的 `contentWindow`）、`nonce` 与阶段顺序，任一不符即丢弃。
- iframe 导航（`load` 事件）作废旧 `nonce` 并等待新 `ready`；在途请求以 `BridgeNavigationError` 失败。
- 重复 `ready` 只重发 `init`；重复 `fields-request` 由 iframe 重发缓存回执（`onFields` 不重复执行）；重复 `complete` 只结算一次。
- 乱序 / 未知 `requestId` / 旧 `nonce` 的迟到消息一律忽略；同源其他 frame 因 `source` 不匹配无法串入。
- 事务整体超时（默认 30s）以 `BridgeTimeoutError` 拒绝。

## 用法

宿主侧（父页面）：

```ts
import { FormBridgeHost } from './index.ts';

const iframe = document.querySelector('iframe')!;
const host = new FormBridgeHost({
  eventTarget: window,
  getSourceWindow: () => iframe.contentWindow,
  expectedOrigin: 'https://form.example',
  iframe,
});
host.start();
const values = await host.collect([{ name: 'email', required: true }]);
```

iframe 侧（被嵌入页面）：

```ts
import { FormBridgeClient } from './index.ts';

const client = new FormBridgeClient({
  eventTarget: window,
  getParentWindow: () => window.parent,
  parentOrigin: 'https://host.example',
  onFields: async (fields) => collectValuesFromDom(fields),
});
client.start();
```

## 脚本

- `npm run typecheck`：对库源码做严格类型检查。
- `npm test`：编译到 `dist-test/` 后用 `node --test` 运行 `test/bridge.test.ts`（12 个场景，含伪造 origin/source、导航、乱序、重复、迟到）。
