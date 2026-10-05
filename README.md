# persistent-mode-array

TypeScript 库：可持久化（版本化）整数数组，支持范围众数查询。零依赖，仅使用 Node.js 内置模块。

## 功能契约

- **可变整数数组**：构造时给定初始数组（版本 0），元素必须为整数。
- **块更新原子性**：`replaceRange(version, start, end, value)` 把 `[start, end)` 整体置为 `value`，
  生成一个全新版本并返回其 id；更新先完整落地再发布，源版本不被修改。
- **旧版本可查询**：所有版本为不可变快照，任何历史版本随时可查询。
- **范围众数**：`queryMode(version, start, end)` 返回 `{ value, count }` ——
  出现次数最多者胜，次数并列取数值较小者；`count` 即为频次证据。空范围返回 `null`。
- 非法范围 / 未知版本 / 非整数输入抛出异常。

## 核对模型

`src/model.ts` 提供独立的排序计数参考模型 `sortedCountMode`：拷贝切片排序后统计等值游程，
升序排列 + 严格更长才替换最优，天然实现"频次优先、并列取小"。
随机化测试（固定种子 mulberry32，60 轮）对随机替换、随机历史版本、随机范围（含空范围）
逐一比对库结果与模型结果，并对频次证据做直接重计核对。

## 运行

```sh
npm test   # tsc 编译 + node --test 运行
```

实际结果记录在 `RESULTS.md`。
