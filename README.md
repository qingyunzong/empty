# 隐式数据集合的界定标记

影像采集调用可导入的Go包读取隐式值表示的数据集合，不渲染图像。未定义长度的序列靠项界定和序列界定结束，界定标记不属于数据。项长度已知时，数据中的界定字节不再具有结束含义。嵌套序列的界定只关闭最内层。同一层里私有元素必须出现在它的创建者标签之后。总长度受宿主上限约束。用独立界定栈核对已知长度中的假界定、私有顺序和嵌套关闭，期望不得由被测包生成。

## 使用

```go
import "example.org/dataeng13/q0031"

ds, err := dataeng.Parse(data)
if err != nil {
    // errors.Is(err, dataeng.ErrTooLarge) 等
}
for _, elem := range ds.Elements {
    if elem.IsSequence() {
        for _, item := range elem.Items {
            _ = item.Elements
        }
    } else {
        _ = elem.Value
    }
}
```

也可以使用 `ReadDataSet(r io.Reader)`、`ParseWithLimit` 或
`ParseWithOptions`。`Options.MaxBytes` 设置总输入上限（默认
`DefaultMaxBytes`），`Options.MaxDepth` 设置嵌套上限。

## 解析规则

- 隐式 VR 元素为 4 字节标签加 4 字节长度。长度为 `0xFFFFFFFF` 时按未定义长度序列读取。
- 未定义长度序列由 `(FFFE,E000)` 项、`(FFFE,E00D)` 项界定和 `(FFFE,E0DD)` 序列界定组成；界定标记不进入结果。
- 项长度已知时按长度跳过其数据，值内部的界定字节只是普通数据。
- 每个序列界定只关闭当前最内层序列；解析以帧边界和独立层作用域约束，不能越出外层。
- 私有创建者 `(gggg,0010)`–`(gggg,00FF)` 只授权同一层的 `(gggg,10yy)`–`(gggg,FFyy)` 数据块。默认严格检查，可用 `AllowUnorderedPrivate` 关闭。
- 隐式 VR 不携带 VR，因此已知长度的序列需要调用者通过 `Options.SequenceTags` 提供字典信息；未定义长度序列自动识别。

测试 `parser_test.go` 中的夹具由字面十六进制字节构成，期望树是字面结构；
`auditDelimiters` 是测试专用的独立界定栈，不调用被测解析器。
