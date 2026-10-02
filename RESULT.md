# RESULT

提交前真实测试结果。

## 环境

- Node.js: v22.22.1
- 平台: linux x64, 单机离线, 仅标准库
- 日期 (UTC): 2026-10-02

## 命令与结果

```
$ node --test
# tests 5        (5 个测试文件)
# pass 5
# fail 0
exit code: 0
```

逐文件子测试（`node <file>` 直接运行统计 TAP `ok` 行）：

| 文件 | 子测试 | 结果 | 覆盖验收点 |
|---|---|---|---|
| test/policy.test.js | 5 | 全部通过 | 组织→角色→个人继承；分类标签强制升级；未知分类 exit 28 |
| test/views.test.js | 4 | 全部通过 | A: 供应商∩总部交集 + 监管字段例外；C: 个人信息边界置空（含源数据空值） |
| test/revocation.test.js | 7 | 全部通过 | B: 撤销后旧视图保留哈希、标记 expired 且可校验，新视图不含被撤字段；exit 28/29/30；happy path |
| test/audit.test.js | 4 | 全部通过 | 每个输出字段的授权路径校验；供应商视图泄露配方的最小字段集反例 |
| test/enumeration.test.js | 1 | 全部通过 | D: 15 个字段枚举全部 2^15=32768 个子集 × 3 个受众，引擎与独立暴力校验器逐项对照（共 98304 个视图） |

合计 21 个子测试，全部通过。

## CLI 冒烟运行（fixtures/ 示例数据）

```
$ node src/cli.js
views: 8 current (8 new, 0 expired); audit ok -> leak-audit.jsonl
```

生成 8 个视图文件（2 份报告 × operator/supplier/hq/joint）与 leak-audit.jsonl（8 行，全部 ok）。
joint 视图内容为交集 + 监管例外 + 个人信息置空，例如 r-001：

```json
{"line_id":"L3","downtime_minutes":47,"operator_name":null,"operator_id":null,"safety_interlock_status":"OK"}
```

（`root_cause` 仅总部可见 → 交集剔除；`safety_interlock_status` 无任何授权但监管强制可见。）
