# cal-lab — 仪器校准证书判定库与 CLI

Node.js 22,仅标准库,测试使用 `node:test`。

## 模型

- 实体:标准器(`standard`)、被校件(`uut`)、测量点(`point`)。
- 域:量程档 `rangeClass`、等级 `grade`、环境档 `envClass`(精确匹配)。
- 约束:溯源链无环、标准器不确定度优于被校(逐级严格递减,首级以测量点
  预算为界)、环境窗覆盖实测读数、有效期覆盖出证日期、同标准器并发占用
  (reserve/release 成对)。

## 判定语义(`certify`)

- `CERT`:存在有效溯源链、证据齐全、合成不确定度(RSS)稳妥落入预算
  (`u < budget*(1-margin)`)。证书含链、合成不确定度、输入快照与 SHA-256 哈希。
- `REFUTE`:已证伪(断链/环/不确定度倒挂/超期/域不匹配/环境超窗/预算明显
  超出 `budget*(1+margin)`),附带删除极小的反证核心。
- `INSUFFICIENT_EVIDENCE`:证据未齐(无测量、无环境窗、无环境读数、无溯源
  链、悬挂链接),绝不当 `REFUTE`。
- `PENDING`:预算边界带内(`budget*(1±margin)`,默认 margin=0.05)或所有
  合格链的标准器被租用,绝不当 `REFUTE`。

## 命令

```
node cli.js [--dir DIR] add_artifact|link|unlink|measure|reserve|release|certify|audit
```

- `release` 失败(未租用/持有人会不符)返回 `LEASE_STATE`。
- `unlink` 仅当无未决测量(已测量未出证)时允许,否则 `UNLINK_BLOCKED`。
- `audit` 三层校验:哈希完整性(`TAMPERED`)、推导重放(`REPLAY_MISMATCH`)、
  出证后实验记录比对(`STATE_DIVERGED`)。

## 持久化

仅 `measure` 落盘:帧式追加日志(`measure.journal`,magic+len+payload+CRC32,
append+fsync)。崩溃恢复时截断撕裂尾部,绝不出现半条 measure。其余状态经
`state.json` 原子替换(tmp+fsync+rename+dir fsync)。

## 测试

```
node --test
```

真实结果见 `RESULTS.md`。
