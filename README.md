# redact-history

单机离线（Node.js 22，仅标准库）的历史脱敏重写库与 CLI。将仓库历史中匹配规则的敏感值替换为稳定令牌，并按规范重算全部提交哈希，同时产出旧历史失效证明与重写映射。

## 数据格式

仓库为单个 JSON 文件：

```json
{
  "initial": "初始文件内容（字符串）",
  "commits": [
    {
      "id": "旧提交 id（任意字符串，重写后作废）",
      "parent": "父提交 id 或 null",
      "author": "作者",
      "note": "备注（命中值同样会被替换）",
      "patch": {
        "file": "data.csv",
        "hunks": [
          { "before": "上文", "remove": "删除段", "add": "新增段", "after": "下文" }
        ]
      }
    }
  ]
}
```

补丁应用方式：在当前内容中定位 `before + remove + after`（必须唯一），替换为 `before + add + after`。上下文找不到或出现多次即中止。

规则文件：`{ "rules": [{ "pattern": "SECRET-[A-Z]+-[0-9]+", "flags": "g" }] }`。

## 哈希规范

- `contentHash = sha256(提交应用后的完整内容)`（UTF-8 十六进制）。
- `commit.id = sha256(canonicalJSON({ parent, author, note, patch, contentHash }))`，
  其中 canonicalJSON 为键排序的确定性序列化。
- 重写时无论是否命中敏感值，所有提交的 `contentHash` 与 `id` 都按上述规范重算，
  `parent` 链接到重写后的前一提交 id。

## 令牌与一致性

- 令牌：`REDACTED-<sha256(原值) 前 N 位十六进制>`，默认 `N = 12`（`--token-length` 可调）。
- 同一原值在初始内容、任意提交补丁、备注中出现的所有位置使用同一令牌（跨版本稳定）。
- 值 → 令牌必须为双射：两个不同原值得到同一令牌时中止，退出码 2，不写任何输出。
- 重写后逐版本重放的最终内容必须等于原最终内容的脱敏投影，否则中止（退出码 2）。

## 失效证明与重写映射

成功时输出 proof JSON：

- `oldHead` / `newHead`：旧/新头提交 id。
- `invalidatedHistoryHash`：`sha256(canonicalJSON(原 commits))`，旧历史据此作废。
- `commitMap`：逐提交的旧 id → 新 id 映射。
- `tokens`：每个令牌及其原值的 `sha256`（不含原值本身，用于审计对照）。

## CLI

```sh
node bin/redact-history.js rewrite \
  --repo repo.json --rules rules.json \
  --out rewritten.json --proof proof.json [--token-length 12]
```

退出码：`0` 成功；`1` 用法/IO 错误；`2` 中止（令牌冲突、补丁上下文无法定位或投影不一致），中止时不写任何输出文件、不改动输入。

## 库 API

```js
const { rewriteHistory, AbortRewrite } = require('./src/redact');
const result = rewriteHistory(repo, rules, { tokenLength: 12 });
// result.repo / result.proof / result.tokenMap / result.originalFinal / result.rewrittenFinal
```

`AbortRewrite` 携带 `reason`（`token-collision` / `context-not-found` / `context-ambiguous` / `projection-mismatch`）与 `exitCode = 2`。

## 测试

```sh
node --test
```

覆盖：多版本一致替换与投影相等、冲突令牌中止（退出码 2）、无敏感值时哈希仍按规范重算、
补丁上下文无法定位时中止且输入不变、CLI 端到端成功与中止；并以不超过 3 个值的
替换双射枚举作为对照。
