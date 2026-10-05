# cert-chain-verify

离线证书链验证 CLI：读取本地证书关系图（JSON），在**不访问网络**的前提下，
从指定叶子证书出发构建并验证证书链，并与简单路径枚举的结果交叉核对。

## 验证规则

- 路径中每张证书在 `--at` 时刻有效（`notBefore <= at <= notAfter`）
- 路径上所有证书的用途交集包含请求用途 `--usage`
- 链的根证书在图的 `trustedRoots` 中
- 链长最多 12 张证书
- 选链规则：先选最短链，长度相同按证书 ID 序列字典序
- 失败时给出每条候选路径的具体失败原因
- 交叉核对：BFS 选链结果必须与全量简单路径枚举的最优解一致

## 图格式（fixtures/graph.json）

```json
{
  "certs": [
    {
      "id": "leafA",
      "issuer": "inter1",
      "notBefore": "2020-01-01T00:00:00Z",
      "notAfter": "2030-01-01T00:00:00Z",
      "usages": ["serverAuth"]
    }
  ],
  "trustedRoots": ["rootA"]
}
```

`issuer` 可以是字符串、`null`（自签根）或字符串数组（多个候选签发者）。

## 使用

```sh
npm run build
node dist/src/cli.js --graph fixtures/graph.json --leaf leafA \
  --usage serverAuth --at 2025-06-01T00:00:00Z \
  --expect-ok --expect-chain leafA,inter1,rootA
```

- `--expect-ok` / `--expect-fail`：显式声明预期验证结果
- `--expect-chain id1,id2,...`：显式声明预期链
- 输出 JSON 报告（链、失败原因、交叉核对、预期比对）；实际结果与显式
  预期不符或交叉核对不一致时退出码为 1，参数/图错误为 2

## 测试

```sh
npm test   # tsc 编译后运行 node:test
```

实际运行结果（2026-10-05，Node v22.22.1，TypeScript 7.0.2）：

```
ok 1 - valid chain: leaf -> intermediate -> trusted root
ok 2 - selection prefers the shortest chain
ok 3 - ties on length are broken by id-sequence order
ok 4 - expired intermediate fails with an explicit reason
ok 5 - requested usage must be in the chain usage intersection
ok 6 - untrusted root fails with an explicit reason
ok 7 - chains longer than 12 certs are rejected
ok 8 - unknown leaf reports a failure reason
ok 9 - cross-check: BFS selection matches simple-path enumeration on all leaves
ok 10 - compareIdSeq orders element by element
ok 11 - cli: verifies a chain and matches an explicit expectation
ok 12 - cli: exit 1 when explicit expectation mismatches
ok 13 - cli: failing verification reports reasons and matches expect-fail
ok 14 - cli: invalid arguments exit with code 2
# tests 14
# pass 14
# fail 0
```

说明：环境离线，无法安装 `@types/node`，`src/node-shims.d.ts` 提供了
本项目用到的 Node 内置模块的最小类型声明，仅使用 Node 内置库。
