# audit-evidence-lib

审计库：将测试记录绑定 **源码内容哈希 + 命令 + 实际退出码**，只有同哈希记录
才能用于当前产物的判定——旧版本的"通过"与新版本的"失败"绝不被拼接。

## 核心语义

- `TestRecord` = `{ suite, command, exitCode, sourceHash, recordedAt }`，
  入库时校验（哈希须为 sha256、退出码须为整数）。
- `evaluateArtifact(log, currentHash, required)` 只采纳 `sourceHash === currentHash`
  的记录；其余全部列入 `excludedStale`，不参与判定。
- 判定优先级：`conflict`（同哈希同命令退出码不一致）> `fail`（存在非零退出码）
  > `incomplete`（必需套件缺失）> `pass`。
- 证据输出：`missing`（缺失）、`conflicts`（冲突）、`failures`（失败）、
  `excludedStale`（被排除的异哈希记录），`formatReport` 生成可读摘要。
- `verifySourceTree(dir, expectedHash, snapshot?)` 核验文件变更，返回实际哈希
  与变更路径列表；`runAndRecord` 先哈希源码树、再执行命令并记录真实退出码。

## 使用

```ts
import { AuditLog, evaluateArtifact, runAndRecord, verifySourceTree } from "./src";

const log = new AuditLog();
runAndRecord(log, "path/to/tree", "unit", "npm test");
const report = evaluateArtifact(log, currentHash, [
  { suite: "unit", command: "npm test" },
]);
```

## 测试

```sh
npm test   # tsc 编译 + node --test
```

覆盖：记录绑定与校验、同哈希判定、旧通过/新失败不拼接、缺失与冲突证据输出、
随机版本切换（种子化 PRNG，60 次随机检出下的不变量）、文件篡改/删除/恢复核验。

注：沙箱无网络，无法安装 `@types/node`，`types/node-shim.d.ts` 提供了本项目
用到的最小 Node API 声明；有网环境可 `npm i -D @types/node` 后删除该文件。
