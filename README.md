# textstream

流式 UTF-8 文本解码与版本化增量编辑库，仅依赖 Go 标准库。

## 流式解码（decoder.go）

- 只接受 UTF-8 最短形式：拒绝过长编码（`C0/C1`、`E0 9F..`、`F0 8F..`）、
  代理区（`ED A0..BF`）与超界值（`F4 90..`、`F5..FF`）。
- 非法序列每次消费一个字节并产生一个 U+FFFD；尾部未完成的序列保留，
  等待下一块数据，`Close` 时按每字节一个 U+FFFD 冲刷。
- 每个输出码点记录其来源字节区间 `Mapping{Start, End}`，区间连续覆盖整个流。
- `Decoder.Write` 支持任意切块；`DecodeAll` 一次性解码完整输入。

## 版本化增量编辑（document.go）

- `Document` 持有不可变 `Version` 序列；读者可安全持有旧版本的码点与映射。
- `ApplyEdits(base, edits...)` 基于已提交版本应用字节编辑批次：
  - 批次内编辑区间重叠返回 `ErrOverlap`，越界返回 `ErrRange`；
  - `base` 不是最新版本时返回 `ErrVersionConflict`，批次不生效。
- 增量修复：左边缘按"证据可达范围"回退（无效字节的判定最多向前看 3 字节），
  右边缘在新旧解码的同步点汇合，只重解码最小受影响区间，跨编辑边缘的
  坏序列（如悬挂的前导字节被新字节补全）被正确修复。
- 返回 `Diff`：`NetRunes` 为新旧码点净差，`OldRunes/NewRunes/OldBytes/NewBytes`
  为受影响区间，`Migrate(oldIndex)` 给出旧码点下标到新版本的位置迁移
  （受影响区间内返回 -1）。

## 测试

- 全部 65536 个双字节序列：整体解码与任意切块解码一致，并与标准库语义对照。
- 重点四字节序列（最小/最大/emoji/过长/超界/非法前导/截断/坏续字节）枚举
  全部切分点组合核对。
- 随机编辑批次（500 轮）与全量重新解码逐码点、逐映射核对，并校验受影响
  区间贴着编辑范围（左 ≤7 字节、右 ≤8 字节）及位置迁移一致性。

## 实测结果

```
$ go test -count=1 ./...
ok  	textstream	0.078s
$ go test -count=1 -race ./...
ok  	textstream	1.369s
```

16 个测试全部通过（含 race 检测）。
