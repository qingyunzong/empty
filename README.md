TLS采集服务需要可导入的Go名称约束组件，接收已验证签名的证书链、各CA的permitted与excluded约束以及叶证书SAN。叶证书每个SAN都须通过，仅支持DNS与IP，DNS限ASCII且转小写并去单个末尾点，不允许通配SAN：DNS约束example.test匹配自身及子域，前导点只匹配子域，IP用任意连续掩码前缀；同CA允许集合取并，不同CA取交，排除集合累积取并，未列出的类型不受该CA限制。非末端自颁发证书跳过名称检查但继续施加约束，末端不能跳过。提供握手适配器和逐CA参考实现，测试交集为空、多个SAN、混合地址族、末尾点与前导点边界，失败不得发送应用数据。

## nameconstraints

`nameconstraints` 是可导入的 Go 组件，对已完成签名验证的证书链施加名称约束。

- 仅支持 DNS 与 IP 两类 SAN，其余类型忽略。
- DNS SAN 必须为 ASCII，统一转小写、去除单个末尾点，拒绝通配 SAN。
- DNS 约束 `example.test` 匹配自身与所有子域；`.example.test` 仅匹配子域。
- IP 约束为任意连续掩码前缀的 CIDR，IPv4 与 IPv6 独立参与计算。
- 同一 CA 的 permitted 取并集，不同 CA 取交集，excluded 累积取并；某 CA
  未列出的类型不受该 CA 限制。
- 非末端自颁发证书跳过自身名称检查但继续施加约束；末端证书不可跳过。

入口：

- `NewSet` / `Set.AddCA` / `Set.CheckNames`：累积约束引擎。
- `NewReferenceValidator` / `EvaluateChain`：逐 CA 参考实现。
- `NewVerifier`：TLS 握手适配器，实现 `tls.Config.VerifyConnection` 与
  `VerifyPeerCertificate`；校验失败会中止握手，不发送应用数据。
