# clearing-review

商户结算批次复核库与 CLI(Node.js 22,仅标准库,零依赖,离线可运行)。

## 用法

```sh
node cli.js policy.jsonl events.jsonl out/
# 成功:写出 out/decisions.jsonl 与 out/audit.json,退出码 0
# 失败:stderr 输出 {"error":{"code":"<CODE>","line":<N>}},退出码 1,不写输出文件
node --test   # 运行全部测试
```

## 输入格式

`policy.jsonl`,每行一条记录:

```json
{"type":"role","role":"auditor","inherits":["senior"]}
{"type":"rule","id":"r1","role":"base","resource":"merchant:*","effect":"allow"}
{"type":"revoke","role":"auditor","at":"2026-02-01T00:00:00Z"}
```

`events.jsonl`,每行一笔授权事件:

```json
{"type":"authorize","id":"e1","role":"auditor","resource":"merchant:42","at":"2026-01-10T09:00:00Z"}
```

资源模式支持精确匹配、`前缀*` 通配与 `*` 全匹配。

## 裁决语义

- 角色按 `inherits` 构成 DAG;出现循环(含自继承)报 `E_CYCLE`。
- 候选规则 = 事件角色及其全部祖先角色上、匹配该资源的规则(撤销时间
  及以后的祖先不参与)。
- 优先级:显式 deny > allow → 更近祖先(跳数少)> 更远祖先 → 规则 id 字典序。
- 无任何匹配规则时默认拒绝(`no_matching_rule`)。
- `revoke` 只影响撤销时间(`at`)及以后的授权;之前的历史裁决不变。
- 事件引用未定义角色时拒绝(`unknown_role`);策略内引用未定义角色报
  `E_UNKNOWN_ROLE`。

## 输出

`decisions.jsonl` 每行一笔裁决:

```json
{"id":"e1","role":"auditor","resource":"merchant:42","at":"...","decision":"allow","rule":"r1","path":["auditor","senior","base"],"reason":"allowed by rule r1"}
```

`path` 为从事件角色到胜出规则所在角色的最短继承路径;存在竞争规则时附
`conflicts`(其余候选规则 id)。

`audit.json` 为 sha256 哈希链:`hash[i] = sha256(hash[i-1] + "\n" + decisions.jsonl第i行)`,
创世哈希为 64 个 `0`。历史条目不可篡改——改动任何一行都会使其后全部哈希失效。

## 错误码

| code | 含义 |
|---|---|
| `E_PARSE` | JSONL 行不是合法 JSON |
| `E_SCHEMA` | 记录结构/字段不合法或类型未知 |
| `E_CYCLE` | 角色继承出现循环 |
| `E_DUP_ROLE` | 角色重复定义 |
| `E_UNKNOWN_ROLE` | 策略引用了未定义的角色 |
| `E_IO` | 文件读写失败 |

## 库 API

- `require('./lib/policy')`:`loadPolicy(text)`、`computeAncestors(policy, role)`、`isRevokedAt(policy, role, epochMs)`
- `require('./lib/evaluate')`:`parseEvents(text)`、`decide(policy, event)`、`resourceMatches(pattern, resource)`
- `require('./lib/audit')`:`buildAudit(decisions)`、`chainHash(prev, line)`、`GENESIS`
- `require('./cli')`:`run(argv, deps)`(可注入 stderr/fs,便于在进程内测试)
