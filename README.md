浏览器采集插件需要可嵌入的TypeScript消息桥组件，只接收指定origin与当前窗口对象的消息。握手生成会话nonce，后续消息带nonce、递增序号及操作参数；重复序号只重发已缓存结果，异内容重复拒绝，窗口内乱序先缓冲并按连续序号执行，超过窗口拒绝。导航更换窗口后旧会话立即失效，旧异步操作完成不得向新窗口回信。提供可注入随机源及窗口适配器，用来源伪造、重放、导航与完成竞态测试，参数验证在任何宿主操作之前执行。

## 用法

```ts
import { IframeWindowAdapter, MessageBridge, createSystemRandomSource } from './src/index.js';

const adapter = new IframeWindowAdapter(window, iframe);
const bridge = new MessageBridge({
  allowedOrigin: 'https://collector.example',
  adapter,
  random: createSystemRandomSource(),
  windowSize: 8,
  operations: {
    collect: {
      validate(params) {
        if (typeof params !== 'object' || params === null) throw new Error('bad params');
        return params;
      },
      async execute(params, ctx) {
        // 宿主操作；ctx.isSessionCurrent() 可查询会话是否仍有效
        return params;
      },
    },
  },
});
```

## 协议

- 客户端 → 宿主：`{ kind: 'bridge.handshake' }`；宿主回复 `{ kind: 'bridge.handshake.ack', nonce, windowSize }`。
- 客户端 → 宿主：`{ kind: 'bridge.op', nonce, seq, op, params }`，`seq` 从 1 开始递增。
- 宿主 → 客户端：`{ kind: 'bridge.result', nonce, seq, ok, value | error }`。

## 语义

- 仅处理 `origin` 匹配且 `source` 等于当前窗口对象的消息，其余静默丢弃。
- `seq < nextSeq`：内容一致则重发已缓存结果，不一致回复 `seq-replay-conflict`。
- `nextSeq <= seq < nextSeq + windowSize`：先缓冲，按连续序号依次执行。
- `seq >= nextSeq + windowSize`：回复 `seq-out-of-window` 拒绝。
- 导航（窗口对象变更）立即使旧会话失效；未完成异步操作的结果在会话失效后不再发送。
- `validate(params)` 永远先于 `execute(...)` 等任何宿主操作执行。

## 构建与测试

```sh
npm run build   # 编译 src/ 到 dist/
npm test        # 编译并运行 node:test 测试（伪造来源、重放、乱序、导航、完成竞态）
```
