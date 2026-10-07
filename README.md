# config-migrator

桌面程序配置迁移库。按版本图选择迁移路径，每步携带可逆补丁，失败时按反序
回滚，回滚失败保留续恢复位置。仅使用 TypeScript + Node.js 内置库，运行时
零依赖。

## 设计

- **版本图选路**（`src/graph.ts`）：`findPath` 在 `from -> to` 的有向图上做
  字典序 Dijkstra：先比步数，步数相同再逐位比较迁移 ID 序列，结果与注册
  顺序无关。
- **可逆步骤**（`src/types.ts`）：每个 `Migration` 带 `up` / `down` 两个补丁。
- **迁移与回滚**（`src/migrator.ts`）：
  - 每步提交点 = 配置文件写入（含 `version` 字段），同时维护
    `<config>.journal` 日志（起点、目标、路径、阶段）。
  - 某步 `up` 抛错 → 切到 `rolling-back`，已应用的步骤按反序用 `down` 撤销。
  - 某步 `down` 抛错 → 返回 `rollback-paused`，日志保留在磁盘上，
    续恢复位置由「日志路径 + 配置文件中的 version」共同确定。
  - `recover()` 读取日志并用当前 version 对账出实际进度，从中断点继续
    回滚；无日志时是 no-op，可重复调用。
  - 适配器错误（如断电）直接向上传播，模拟进程死亡。
- **内存文件适配器**（`src/memory-adapter.ts`）：`MemoryFileAdapter` 实现
  `FileAdapter`，支持 `crashAfterWrites(n)` 注入断电（之后的写抛出
  `PowerCutError`，所有操作拒绝服务直到 `reboot()`），已写入的"磁盘"内容
  在重启后保留。

## 使用

```ts
import { Migrator, MemoryFileAdapter } from "./src/index";

const adapter = new MemoryFileAdapter(); // 或任何 FileAdapter 实现
const migrator = new Migrator({ adapter, configPath: "/app/config.json", migrations });
const result = migrator.migrate("3");      // 缺省目标 = 版本图唯一汇点
if (result.status === "rollback-paused") migrator.recover();
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

实际结果（Node v22.22.1，tsc 7.0.2）：**15 个测试全部通过**。

- `test/graph.test.ts`（6 通过）：步数优先、ID 序列逐位 tie-break、序列按
  元素比较而非拼接字符串、与注册顺序无关、同版本空路径、无路报错。
- `test/migrator.test.ts`（9 通过）：跨图迁移到推断的最新版本、分支图走
  短路径、无需迁移、前向失败反序回滚且配置逐字节复原、逆向补丁失败保留
  续恢复位置并由 `recover()` 完成、迁移中断电后回滚到起点、回滚中断电后
  从记录位置续恢复、重复 `recover()` 幂等、干净状态下 `recover()` 为
  no-op。

```
# tests 15
# pass 15
# fail 0
```

注：本环境 npm registry 不可达且全局未装 `@types/node`，故
`types/node.d.ts` 内置了 `node:test` / `node:assert/strict` 的最小类型声明；
有网络时可替换为 `@types/node`。
