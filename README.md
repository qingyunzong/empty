# 注塑机 MES 离线缓存事件包

Node.js 22、仅标准库(`node:crypto` / `node:fs` / `node:test`)、单机离线。
对经不可靠链路到达(可重复、乱序、迟到)的注塑机事件做离线缓存、去重重排、
缺失 NAK 与 gap 标记,并按 lot 重建单位产品追溯链、导出不可变质量证书。

## 运行

```sh
node cli.js events.jsonl --now 5000          # 默认 --deadline 1000
node cli.js events.jsonl --now 5000 --deadline 2000
node --test                                  # 或 npm test
```

退出码:`0` 成功;`2` 输入非法(JSON 解析失败 / 字段缺失或非法 / 参数非法);`4` 守恒破坏。

## 事件模型

每行一个 JSON 对象,字段严格为(多字段、缺字段、类型错均 exit 2):

| 字段 | 约束 |
| --- | --- |
| `lot` / `mold` / `station` / `hash` | 非空字符串 |
| `seq` | 整数 ≥ 1,流内序号 |
| `ts` | 整数 ≥ 0,事件时间戳 |
| `kind` | `produce` / `consume` / `split` / `merge` / `seal` |
| `qty` | 整数 ≥ 0;非 `seal` 必须 > 0 |

## 语义约定

- **去重**:事件键为 `(lot, mold, station, seq)`;同键同 `hash` 为重复,丢弃并计数。
- **迟到更正**:同键不同 `hash` 视为更正。仅当被替换事件 `future=false`
  (即 `ts <= now`)时替换生效;`future=true` 事件的更正被拒绝并计数。
- **虚拟时钟与 deadline**:`--now` 为当前虚拟时间。流(同 lot/mold/station)内缺失
  `seq` 的参考时间 `ref` = 后继已收事件的最小 `ts`(无后继取前驱最大 `ts`);
  `now - ref >= deadline`(边界含等号)标记 **gap**,否则进入 **NAK** 重传请求表。
  gap 不阻塞:canonical 链与证书导出都跳过缺口继续。
- **canonical 链**:同 `lot` 同 `mold` 的事件按有效 seq 拓扑排序
  (`seq, station, hash` 升序),输出逐事件余额 `balance`。
- **守恒**:`produce`/`merge` 为 `+qty`,`consume`/`split` 为 `-qty`;
  canonical 顺序上任一前缀余额为负即守恒破坏(exit 4)。
- **证书**:某 `lot` 的所有链均含 `seal` 且无未过期缺失(gap 不阻塞)时导出证书,
  `digest = sha256(稳定序列化(链内容 + gap 表))`。已导出证书不可变:内容因迟到
  更正变化时,向 `revocations` 追加吊销记录并导出 `version+1` 的新证书。

## 输出

`chains`(canonical 链 + 余额)、`gaps`(gap 表)、`naks`(重传请求)、
`certificates`(追加式证书日志)、`revocations`(吊销记录)、`stats`(计数)。

## 真实运行结果

`node cli.js events.jsonl --now 5000`(exit 0)。样例含乱序、1 个重复、
1 个迟到更正、1 个恰好压 deadline 边界的 gap、1 个未过期 NAK。关键输出:

```json
"gaps": [
  { "lot": "L001", "mold": "M1", "station": "INJ-01", "seq": 3,
    "refTs": 4000, "age": 1000, "deadline": 1000 }
],
"naks": [
  { "lot": "L002", "mold": "M2", "station": "INJ-02", "seq": 2,
    "refTs": 4900, "age": 100, "deadline": 1000 }
],
"certificates": [
  { "lot": "L001", "version": 1,
    "digest": "d39b02efd700e4279054fa5e1e6e53105b319e98a6821378981df0eb84433866", "at": 5000 },
  { "lot": "L001", "version": 2,
    "digest": "b49ff09ef2b77d30fa445756350bbf0f0a210673e7a3dd56521a3314e7b99952", "at": 5000 }
],
"revocations": [
  { "lot": "L001", "version": 1,
    "digest": "d39b02efd700e4279054fa5e1e6e53105b319e98a6821378981df0eb84433866",
    "reason": "superseded-by-correction", "at": 5000 }
],
"stats": { "received": 8, "stored": 6, "duplicates": 1, "corrections": 1,
  "rejected": 0, "gaps": 1, "naks": 1, "certificates": 2, "revocations": 1 }
```

`node --test` 真实结果(9/9 通过,含 4 条验收):

```
ok 1 - 1: out-of-order + duplicates match sorted reference
ok 2 - 2: late correction revokes old certificate and changes digest
ok 3 - 2b: correction of future event is rejected
ok 4 - 3: deadline boundary event expires exactly at deadline
ok 5 - 4: all 40320 permutations of seq 1..8 dedupe to identical chain
ok 6 - conservation: negative prefix balance throws and CLI exits 4
ok 7 - conservation: balanced split/merge chain passes
ok 8 - invalid input exits 2
ok 9 - cli happy path exits 0 with canonical chain, gaps, certificates
# pass 1 / fail 0(node --test 汇总)
```

验收 3 的边界用例:缺失 seq 的后继参考 `ts=4000`、`deadline=1000`,
`now=5000` 时 `age=1000` 恰好超时记 gap,`now=4999` 时仍为 NAK。
