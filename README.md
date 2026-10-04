# change-compress

变更库：压缩同一键上的连续操作，生成逆批次（undo），并在原值未知时报告需要基线。
纯 TypeScript，仅使用 Node.js 内置库（`node:test` / `node:assert`），无运行时依赖。

## 操作模型

```ts
type Op =
  | { kind: 'insert';  key: string; value: unknown }
  | { kind: 'delete';  key: string; oldValue?: unknown }
  | { kind: 'replace'; key: string; oldValue?: unknown; value: unknown };
```

`oldValue` 记录操作前的原值（基线）。`oldValue === undefined` 表示原值未知。

## 压缩规则（同键连续操作）

| 序列              | 压缩结果                                   |
| ----------------- | ------------------------------------------ |
| insert → delete   | 两者抵消，操作消失                         |
| delete → insert   | 成为 replace，保留 delete 记录的原值       |
| insert → replace  | 成为最终值的 insert                        |
| replace → replace | 保留首个 oldValue 与最终 value             |
| replace → delete  | 成为带原始 oldValue 的 delete              |

`compress(ops)` 返回 `{ ops, missingBaseline }`：压缩后的批次，以及净效果仍需要
原值（delete/replace）但未记录基线的键列表。

## 逆批次

`invert(ops)` 以相反顺序生成逆操作；应用后可恢复原状态。
若某 delete/replace 缺少 `oldValue`，抛出 `BaselineRequiredError`，
其 `keys` 字段列出所有需要基线的键。

## 测试

```sh
npm test   # tsc 编译后运行 dist/test 下的测试（node:test）
```

前提：环境中有 `tsc`（本仓库离线，未安装 @types/node，使用 `types/node-shim.d.ts`
声明所需的最小内置模块接口）。

### 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - insert then delete on same key disappears
ok 2 - delete then insert becomes replace and keeps the original value
ok 3 - unknown original value is reported as needing a baseline
ok 4 - insert then replace collapses to a single insert
ok 5 - replace chain keeps first oldValue and final value
ok 6 - replace then delete becomes delete with the original value
ok 7 - only consecutive same-key runs are compressed
ok 8 - inverse batch undoes a batch in reverse order
ok 9 - random ops: compression preserves result and undo restores state
# tests 9
# pass 9
# fail 0
```

第 9 项为属性测试：500 轮随机初始状态 + 随机合法操作序列（固定种子可复现），
验证压缩前后应用结果一致、原批次与压缩批次的逆批次均能恢复原状态，
且压缩后批次长度不超过原批次。
