# config-resolve

TypeScript 配置库：对字符串值中的 `${key}` 做递归展开，带版本化依赖缓存。

## 语义

- **递归展开**：`get(key)` 会递归展开值中所有 `${...}` 占位符。
- **缺键报错**：引用不存在的键抛出 `MissingKeyError`（消息含解析链），绝不替换为空串。
- **转义**：`\${key}` 保持字面量 `${key}`，不参与展开；其他字符前的 `\` 原样保留。
- **循环检测**：抛出 `CycleError`，`path` 与消息给出从请求键出发的完整路径，如 `a -> b -> c -> a`。
- **缓存**：每个键带单调递增版本号；缓存条目记录其全部传递依赖的版本快照。`set`/`delete`
  只 bump 该键版本，读取时校验依赖版本——仅依赖项失效重算，其余键直接命中缓存。
- **对照解析**：`resolveUncached(key)` 是不走缓存的参考实现，测试断言任意修改序列下
  `get` 与 `resolveUncached` 结果（含错误类型与消息）完全一致。

## API

```ts
import { ConfigStore } from "./src/config";

const cfg = new ConfigStore({ home: "/srv", conf: "${home}/app.conf" });
cfg.get("conf");            // "/srv/app.conf"
cfg.set("home", "/opt");    // 仅使依赖 home 的缓存失效
cfg.get("conf");            // "/opt/app.conf"
cfg.resolveUncached("conf"); // 无缓存对照解析
cfg.cachedKeys();            // 当前缓存的键（测试/调试用）
cfg.computeCounts;           // 每个键的实际计算次数（验证失效范围）
```

## 测试

```sh
npm test   # tsc 编译 + node --test 运行 dist/test/config.test.js
```
