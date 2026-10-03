# quota-freeze

层级额度冻结请求库。Node.js 22 标准库实现（`node:fs` / `node:zlib` / `node:crypto` / `node:test`），单机离线，无第三方依赖。

## 模型

每个请求：`{ id, parentId, amount, quota, policyText, state, version }`，`state ∈ {active, expired}`。

- 子请求只能在父请求存活（`active`）时冻结，且沿父链每一层 `used + amount <= quota`。
- `used(id)` = 该节点自身 `amount` + 所有存活子孙的递归求和；expired 子树不计占用。
- 每次变更返回：每层冻结前/后余额（`levels`）、占用链（`occupancyChain`）、版本证书（`certificate`，SHA-256）。
- `update(id, expectedVersion, patch)` 乐观并发：版本不匹配抛 `StaleVersionError`，状态不变。
- `expire` 逻辑删除（可 `restore`）；`purge` 物理清除并把 gzip 压缩段合并为单段，不可恢复。

## 索引

`policyText` 分词（英文数字词 + 单字 CJK）后建位置倒排索引，持久化为 `segments/seg-NNNNNN.json.gz` 压缩段；
`query(phrase)` 做位置相交的精确短语匹配，仅返回存活文档。

## 库用法

```js
const { Store } = require('./src/store.js');
const store = new Store('./data');
store.freeze({ id: 'root', parentId: null, amount: 10, quota: 100, policyText: 'alpha beta' });
store.freeze({ id: 'leaf', parentId: 'root', amount: 15, quota: 30, policyText: 'beta gamma' });
store.query('beta gamma');        // => ['root', 'leaf']
store.expire('leaf');
store.restore('leaf');
store.update('leaf', 3, { quota: 40 });
store.purge();
```

## CLI

```sh
node bin/cli.js --data-dir ./data freeze  --id root --amount 10 --quota 100 --policy "alpha beta"
node bin/cli.js --data-dir ./data freeze  --id leaf --parent root --amount 15 --quota 30
node bin/cli.js --data-dir ./data query   --phrase "alpha beta"
node bin/cli.js --data-dir ./data expire  --id leaf
node bin/cli.js --data-dir ./data restore --id leaf
node bin/cli.js --data-dir ./data update  --id leaf --version 3 --quota 40
node bin/cli.js --data-dir ./data get     --id leaf
node bin/cli.js --data-dir ./data balance --id root
node bin/cli.js --data-dir ./data purge
```

所有命令输出 JSON；出错时写 stderr 并以退出码 1 结束。

## 测试

```sh
node --test
```

最近一次真实运行记录：

- 命令：`node --test`
- 退出码：`0`
- 通过：8 / 8（`tests 8, pass 8, fail 0`）
- 失败输出：无
