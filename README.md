# 未知符号身份跨字典快照搬迁

归档接入管线拿到已解码的符号ID流，部分共享字典尚未下载；缺失文本不能统一改成空串或ID零，否则不同字段会被合并。开发Go可导入的字典上下文与符号搬迁包，不解析文件、不访问网络。宿主提供不可变目录，键为非空表名和正整数版本，值为字符串或unknown槽数组，字符串可为空、可重复；以及系统字典的固定字符串数组。上下文由系统区、按给定次序排列的共享导入区和本地槽区组成，SID从1顺次分配，0为localUnknown。导入给name、version和可选uint64 maxID：优先目录精确版本；精确缺失且未给maxID则拒绝；给了maxID时可退到同名最高版本，仍无表则全部unknown。每区长度严格取maxID，缺省时取精确表长；比实际表长大补unknown，小则截断。maxID=0可保留为零长区，累积SID溢出整次拒绝。禁止按maxID展开槽：导入长度可能为2^63，仅目录已有数组及区间元数据可占内存。解析SID返回带来源的不可变token：系统或本地已知槽和导入已知槽均为Known(text)，本地unknown与SID0均为LocalUnknown，导入未知槽为SharedUnknown(name,ordinal)，ordinal是该共享表中从1开始的位置，不是本地SID；此身份忽略版本，但两个不同表名或位置不能等同。越过当前最大SID报错，不能当未知槽。这里只实现本题公开的符号语义，不要求兼容某种完整序列化格式。新建上下文会替换旧导入及本地槽；AppendLocal只追加本地槽并保留先前全部SID，Reset仅恢复系统区。任何操作失败保持原快照；旧快照、已解析token和旧目录不能被新目录或追加操作改变，目录更新不追溯把既有unknown token变成已知文本。提供Equivalent，两个Known仅按完整UTF-8文本相等、两个LocalUnknown相等、两个SharedUnknown仅按name和ordinal相等，三类间不等；文本比较不做Unicode规范化。反查已知文本必须返回当前所有系统、导入及本地已知槽的最小SID，不能因后面的字典较新而优先；未知身份反查也必须找相同类身份的最小SID，包括同名表被多次导入、各导入可见长度不同的情形。搬迁接收任一旧快照的token序列与目标快照，先为全部Known查找目标最小SID，没有时按首次出现次序把文本追加到目标本地槽，同一文本只追加一次；LocalUnknown编码为0。SharedUnknown必须在目标找到仍解析为该未知身份的导入槽，不能用碰巧相同的数值SID、已知文本槽或新本地unknown替代；找不到时整次返回不可搬迁及第一个失败token下标，目标不变、无部分SID序列。全部可表示才交付新目标快照和SID序列，每个结果SID在新快照解析后须与源token Equivalent。目标当前无未知位置但未来目录可能下载不是成功依据。要求在真实宿主调用中混合字段名、注解和符号值搬迁；输入已是三类位置的token，三类位置使用相同身份规则，顺序不重排。提供独立小字典全展开参考，随机核对SID解析、最小反查、追加与全有或全无搬迁；覆盖空文本、重复文本与系统遮蔽、重复导入、相同name不同version的未知位置、目录缺失及补齐、截断和巨型补空区、localUnknown与sharedUnknown区别、先有可追加文本后遇到不可搬迁未知身份、重置后旧token仍有效。额外用两个长度2^63附近的导入检查总SID溢出，用单个巨大导入末端未知槽查询证明没有按区长度分配或遍历。

## API

```go
directory := dataeng.Directory{
    dataeng.Key{Name: "fields", Version: 1}: dataeng.TextTable([]string{"", "cust_id"}),
    dataeng.Key{Name: "notes", Version: 1}:  dataeng.UnknownTable(3),
}

context, err := dataeng.NewContext(
    []string{"annotation", "symbol"},
    []dataeng.Import{
        {Name: "fields", Version: 1},
        {Name: "notes", Version: 1},
        dataeng.ImportWithMax("missing", 7, 4),
    },
    directory,
)

token, err := context.Resolve(sid)       // 0 => LocalUnknown
sid, found := context.Lookup(token)      // minimum matching SID
next, err := context.AppendLocal("more") // new immutable snapshot
next = next.Reset()                      // system area only
```

`Relocate(tokens, target)` returns a new target snapshot and the SID sequence.
If any token cannot be represented, it returns a `*RelocationError` (also
`errors.Is(err, ErrNotRelocatable)`) with the first failing index; the target
and the partial SID sequence are never delivered.

`Table{Slots, UnknownLength}` and `UnknownSlots` describe unknown metadata
without allocating one slot per visible position. Exact-version lookup takes
precedence over fallback to the highest version with the same name. NewContext
snapshots the entries it uses, so later directory changes do not retroactively
turn existing shared-unknown tokens into known text.

The package has no file or network dependencies. `go test ./...` includes
deterministic semantic tests, an independent fully expanded reference model
with randomized checks, giant-import constant-space checks, and uint64 SID
overflow cases.
