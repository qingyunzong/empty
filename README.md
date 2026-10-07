# xborder-recon — 跨境收单对账(版本化时区表)

Node.js 22,仅标准库,`node:test`,单机离线。交易 UTC 时间、商户本地入账日、
费率生效区间分别按**各自固定的时区表版本**换算;表可热更新,但重算永远使用
入账时钉住(pin)的版本,禁止用当前表改历史。

## 核心概念

- **时区表(`TzRegistry`)**:每个版本 = 有序 UTC 分段(`utcStart`/`utcEnd`/
  `offsetSeconds`)+ 闰秒式边界的**显式映射**(`explicit`,如
  `"2024-06-30T23:59:60Z" -> "2024-07-01T07:59:60+08:00"`)。`registry.load()`
  热加载新版本;同版本不同内容会被拒绝(版本不可变),`registry.currentVersion`
  只影响新入账,不影响历史重算。
- **闰秒式边界**:`:60` 形式的时刻没有数值纪元,只能查当前表版本的显式映射;
  表缺该映射报 `E_TZVER`。
- **本地不存在/重复时间**:`localToUtc(local, table, policy)`,策略
  `strict`(抛 `E_AMBIG`)/`earlier`/`later`,解析结果(`ambiguous-earlier`、
  `nonexistent-later` 等)连同候选集写入**证书(attestation)**。
- **证书**:每笔 posting 记录 `tzVersion`、`policy`、`local`/`localDay`、
  `via`(`segment`/`explicit`)、`resolution`,是重算与审计的依据。
- **费率区间**:半开区间 `[startUtc, endUtc)`,按 `pair` 命中。
- **修正与重算影响集**:`applyCorrection` 以旧/新时刻构造窗口,仅重算与该窗口
  **相交**的费率区间及其命中的流水;重算使用证书里钉住的表版本。

## 错误码

| 码 | 含义 |
| --- | --- |
| `E_TZVER` | 未知/冲突的表版本、表未覆盖该时刻、缺闰秒显式映射 |
| `E_AMBIG` | `strict` 策略下本地时间重复(ambiguous)或不存在(nonexistent) |
| `E_POLICY` | 未知策略名、输入缺 `utc`/`local`、非法金额等输入问题 |
| `E_REPLAY` | 重复应用同一 correction id;或重算请求用非钉住版本改历史(未 `allowRepin`) |

## CLI(离线 JSON 输入)

```sh
# 1) 入账:热加载两个表版本,钉住 v1 过账
node cli.js post --txns examples/txns.json \
  --tz examples/tz-v1.json --tz examples/tz-v2.json \
  --tz-version v1 --policy strict --rates examples/rates.json \
  --out ledger.json

# 2) 对账:输出差异、汇率区间命中、证书
node cli.js reconcile --ledger ledger.json --settlement examples/settlement.json

# 3) 修正流水:只重算相交费率区间,输出影响集
node cli.js correct --ledger ledger.json --correction examples/correction.json \
  --tz examples/tz-v1.json --tz examples/tz-v2.json --rates examples/rates.json
```

差异类型:`MISSING_IN_SETTLEMENT`、`UNEXPECTED_IN_SETTLEMENT`、
`AMOUNT_MISMATCH`、`DAY_MISMATCH`、`NO_RATE`。

## 库 API

```js
const {
  TzRegistry, utcToLocal, localToUtc, localCandidates,
  normalizeRates, postLedger, applyCorrection, reconcile,
} = require('./index');
```

## 验收标准对应

1. 同一 UTC 在 v1/v2 落入不同本地日 → `test/tz.test.js` "acceptance 1"
   (`2024-06-15T16:30:00Z`:v1→`2024-06-16`,v2→`2024-06-15`)。
2. 重叠本地时间三策略可复现 → `test/tz.test.js` "acceptance 2"
   (fold 表 `2024-10-27T02:30:00`:strict 抛 `E_AMBIG`,earlier→`00:30Z`,
   later→`01:30Z`,重复执行结果 deepEqual)。
3. 修正只触发相交费率区间重算 → `test/ledger.test.js` "acceptance 3"
   (2 月内的修正只影响 `USD/CNY-2024-02`,1/3 月 posting 对象引用不变;
   另有跨边界修正扩展到两个区间的用例)。
4. 随机小样本 vs 逐分钟展开参考算法 → `test/fuzz.test.js`
   (种子化 mulberry32;参考实现独立、逐分钟暴力展开,500+500+300 个样本
   核对 `utcToLocal` 与 `localCandidates`,覆盖 gap/fold 边界)。

## 测试摘要(真实运行)

- 环境:Node.js v22.22.1,linux x64;运行日期 2026-10-07。
- 命令:`node --test`(亦逐文件 `node test/<file>` 复核子测试)。
- 结果:**4 个测试文件、19 个子测试,全部通过,0 失败**。
  - `test/tz.test.js`:7/7 通过
  - `test/ledger.test.js`:7/7 通过
  - `test/reconcile.test.js`:2/2 通过
  - `test/fuzz.test.js`:3/3 通过(含 1300 个随机样本核对)
- CLI 冒烟:`post` → `reconcile`(产出 2 匹配 + 3 差异)→ `correct`
  (影响集 = `USD/CNY-2024-02` + 2 笔 2 月流水)→ 重复 `correct` 返回
  `E_REPLAY`,退出码 1。
