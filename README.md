# q213 XML 消息验签组件

可嵌入 Go 服务的 XML 消息网关验签组件。调用方注入单个 Ed25519 公钥，
组件完成结构校验、二进制规范化、SHA-256 摘要与 Ed25519 验签，验签通过后
只把被引用的业务 Payload 节点交给处理器。

## 消息结构

信封命名空间为 `urn:gsb:xmlmsg:v1`，根元素下恰好有两个元素子节点：

```xml
<Envelope xmlns="urn:gsb:xmlmsg:v1">
  <Order Id="order-1" xmlns="urn:shop"><Item qty="2">tea</Item></Order>
  <Signature>
    <Reference URI="#order-1">
      <DigestValue>base64(sha256(canonical(Order)))</DigestValue>
    </Reference>
    <SignatureValue>base64(ed25519-sign(priv, sha256(canonical(Order))))</SignatureValue>
  </Signature>
</Envelope>
```

- 标识符是任意元素上无前缀的 `Id` 属性，全文档必须唯一。
- 恰好一个 `Signature`，且不得位于业务 Payload 内部。
- `Reference` 只有一个 `URI="#ID"` 片段，解析到的节点必须就是唯一 Payload。

## 验收管线

`Verifier.Verify` 按顺序执行，任一环节失败即返回哨兵错误且不调用处理器：

1. 受限 XML 子集解析：拒绝 DTD/指令（`ErrDTD`）、注释（`ErrComment`）、
   处理指令（`ErrProcessingInstruction`，仅允许文档开头的 XML 声明），
   严格模式且不展开未知实体。
2. 全树 `Id` 唯一性检查（`ErrDuplicateID`）。
3. 信封拆分：恰好一个 Signature 与一个 Payload，签名不在 Payload 内
   （`ErrSignatureStructure` / `ErrPayloadStructure`）。
4. 引用解析：`#ID` 必须存在且指向该 Payload，杜绝签名包裹
   （`ErrReference`）。
5. 规范化 Payload 并比对 32 字节 SHA-256 摘要（`ErrDigest`）。
6. 对摘要做 Ed25519 验签（`ErrSignature`）。
7. 仅把引用的 `*Node` 传给 `Handler`，处理器无法接触任何其他节点。

## 规范化流（前缀不参与）

- 元素：`E` + 展开名 + 属性数（uint32 大端）+ 各属性 + 规范化子节点 + `Z`。
- 属性：展开名 + uint32 大端长度前缀的 UTF-8 值；属性按展开名
  （命名空间 URI、本地名）排序。
- 文本：`T` + uint32 大端长度前缀的 UTF-8 内容。
- 展开名：命名空间 URI 与本地名两个长度串（各为 uint32 大端长度 + UTF-8）。
- `xmlns` 命名空间声明与前缀被丢弃，因此前缀改名不改变规范流。
- 签名覆盖的是 32 字节摘要，而不是规范流本身。

## 用法

```go
verifier, err := q213.NewVerifier(publicKey)
if err != nil {
    return err
}
err = verifier.Verify(message, func(payload *q213.Node) error {
    // 只有验签成功且 Reference 指向的节点会到达这里。
    id, _ := payload.Attribute("", "Id")
    return process(id, payload.TextContent())
})
```

`Verifier` 内部只持有公钥副本，可并发使用。测试覆盖签名包裹攻击、
同 ID 复制、前缀改名、文本/属性变动与受限子集违规。
