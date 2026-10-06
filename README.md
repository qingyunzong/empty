# config-resolve

支持 `${key}` 递归展开的配置库（TypeScript）。

## 语义

- `${key}` 递归展开为对应配置项解析后的值。
- 引用的键不存在时抛出 `MissingKeyError`（而非替换为空串），错误携带解析路径。
- `\${key}` 为转义占位，输出字面量 `${key}`（反斜杠被消费）。
- 循环引用抛出 `CircularReferenceError`，路径从请求键开始，如 `a -> b -> c -> a`。
- 未闭合的 `${` 按字面量处理。

## 缓存

- 每个配置项 `set` 时递增版本号。
- 解析结果连同其依赖键的版本快照一起缓存；仅当任一依赖版本变化时该项失效，
  其余缓存保持新鲜（`isCacheFresh(key)` 可查询）。
- `getUncached(key)` 提供无缓存解析，用于与缓存结果对照。

## 使用

```ts
import { ConfigStore } from "./src/config.js";

const store = new ConfigStore();
store.set("host", "example.com").set("api", "http://${host}/v1");
store.get("api"); // "http://example.com/v1"
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```
