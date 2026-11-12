# 增量抓取的地址缓存补丁窗口

采集SDK接收供应商差分窗口以重建新版资源，请实现可导入Go补丁应用包，格式完全以本题为准，不需要联网。输入由调用方给出不可变基准ReaderAt、基准长度及预期SHA256，应用前流式核验整个基准指纹及窗口序列，窗口ID唯一且按输入顺序形成资源；每窗口声明基准区间起点和长度S、目标长度T、指令列表及该窗口目标字节的期望SHA256。指令为ADD原始字节、RUN字节和次数、COPY长度和地址模式；目标从空开始，逻辑字典是基准区间后接本窗口已生成目标。COPY的SELF地址为给定非负数，HERE地址为S加当前目标长减给定数，NEAR模式0至3地址为near槽加给定数，SAME模式0至2按给定0至255索引取same槽。near为4个整数的环，same为3乘256表，每窗初始全0；成功COPY确定地址a后写下一个near槽并推进环，再将same按行优先视为768项，写same[a mod 768]=a。每次COPY先固定地址，逐字节从逻辑字典读，因此源落入当前目标时允许重叠自复制，不能把整段源提前切片或限制到复制前长度；每个被读取位置当时必须已存在，基准区间外、负地址和零长度指令拒绝。每窗输出须恰T字节且摘要一致才提交给宿主，不完整或错误窗口不贡献部分资源。宿主提供事务性windowStore，提交结果不明先查该窗口ID与内容摘要，已提交不得重复应用；同ID不同指令或基准指纹拒绝。后续窗口不能读取其他窗口输出，缓存每窗重置。调用方限制T与整次输出总量，所有地址和长度用精确整数先校验溢出；超限停止。交付独立朴素逐字节解释器测试近地址环回、same碰撞、HERE基准与目标交界、重叠复制生成长重复、空目标和故障后恢复，确认SDK最终资源由已提交窗口按序连接而成。

## 用法

包路径为模块根包 `dataeng`（`example.org/dataeng/q0266`）。

```go
app := &dataeng.Applier{
    Baseline: dataeng.Baseline{
        ReaderAt: bytes.NewReader(baseBytes),
        Length:   int64(len(baseBytes)),
        SHA256:   sha256.Sum256(baseBytes),
    },
    Store:  dataeng.NewMemoryStore(),
    Limits: dataeng.Limits{MaxWindowBytes: 1 << 20, MaxTotalBytes: 16 << 20},
}
result, err := app.Apply(ctx, []dataeng.Window{window1, window2})
// result.Resource 为已提交窗口按输入顺序拼接的最终资源。
```

## 语义要点

- `Apply` 先流式 SHA256 核验整个基准，再一次性校验窗口序列（唯一 ID、区间范围、指令形状、精确 T、限额、溢出）。
- 指令：`Add` 追加原始字节；`Run` 按字节重复；`Copy` 按 `CopySelf`/`CopyHere`/`CopyNear`/`CopySame` 解析地址。
- 每窗独立重建：near 环（4 槽）与 same 表（3x256，按行优先视作 768 项）初始全零；成功 COPY 先固定地址、推进 near 环并写 `same[a mod 768] = a`，再逐字节读取逻辑字典（基准区间后接本窗口已生成目标），因此支持重叠自复制。
- 窗口输出恰好为 T 且 SHA256 匹配才经 `WindowStore` 事务提交；失败窗口不留部分资源。
`Commit` 结果不明时按 ID 与内容摘要 `Lookup` 恢复；同 ID 但指令或基准指纹不同返回 `ErrConflict`，已提交窗口幂等跳过、不重复解释。
- 错误以哨兵值暴露（如 `ErrAddress`、`ErrOverflow`、`ErrLimit`、`ErrTargetDigest`、`ErrAmbiguousCommit`），用 `errors.Is` 判断。
- `EncodeWindow`/`DecodeWindow` 提供自描述的窗口线格式，指令摘要由窗口声明的确定性编码得出。
