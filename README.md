# 流量采集模板的消息内生效边界

## 交付物

- `ipfix/ipfix.go`：可导入的增量 IPFIX v10 接收包。
- `cmd/ipfix-collector/main.go`：采集宿主示例，每个 TCP 连接独立持有接收实例与模板作用域。
- `ipfix/*_test.go`：独立编码测试，内置小型编码器，不依赖外部抓包。

## 用法

```go
receiver := ipfix.NewReceiver(
    ipfix.ConnIdentity{LocalAddr: local, RemoteAddr: remote},
    ipfix.Limits{}, // 零值字段使用 Default* 预算
)

for {
    n, err := conn.Read(buf)
    if n > 0 {
        messages, decodeErr := receiver.Append(buf[:n])
        for _, msg := range messages {
            // msg.Sets[*].Records[*].Fields 保留原始字段字节、
            // enterprise/id 与字段次序。
            _ = msg
        }
        if decodeErr != nil {
            return // 接收实例已进入失败终态，不寻找下一帧
        }
    }
    if err == io.EOF {
        if eofErr := receiver.EndInput(); eofErr != nil {
            // 残头或残消息：此前已提交消息仍保留。
        }
        return
    }
}
```

## 语义要点

- 模板按连接身份加 observation domain 隔离，在消息内按 set 顺序生效；
  同消息“先数据后模板”拒绝，后续模板不追溯解码前面的 set。
- 序号按域校验：下一条消息序号等于上次序号加上次已解数据记录数的 uint32
  回绕值，模板记录不计入。
- 完整消息通过后才原子提交模板、序号与记录；任何坏字段、短数据或错误序号
  整消息回滚并把接收实例置为失败终态，后续 `Append` 一律拒绝。
- 变长字段支持短式（首字节 `<255`）与长式（首字节 `255` + uint16 长度），允许零长度。
- 仅接受 template set（ID 2）与数据 set（ID `>=256`）；Options（ID 3）及其它保留 ID 拒绝。
- 填充只允许末尾不足 4 字节且全零，且数据 set 中剩余字节短于最短记录时才认定；
  可解析的全零记录不会被当作填充。
- 预算项：`MaxMessageBytes`、`MaxTemplateFields`、`MaxTotalTemplates`、
  `MaxMessageRecords`，超限在按恶意声明分配前停止。

流量采集宿主通过有序TCP接收IPFIX，需要按模板当时的版本拆数据，后面的模板不能追溯解码前面的set。实现可导入Go增量接收包，只实现以下v10子集。消息头16字节大端：version uint16必须10、length uint16含头且至少16、exportTime uint32、sequence uint32、observationDomain uint32。消息内set头为uint16 ID和uint16 length，长度至少4且含set头，不得跨消息。ID2载模板记录：templateID uint16、fieldCount uint16，再接各字段id uint16及length uint16；id最高位为enterprise标志，置位后紧跟uint32 enterpriseNumber，真实id取低15位。字段长度1..65534为固定字节数、65535为变长；变长记录值以一字节n开始，n<255后跟n字节，n=255时再读uint16大端长度及正文，允许0长度。templateID须>=256，fieldCount正时安装或替换模板，0时撤回指定模板，不存在时也成功；templateID=2且fieldCount=0撤回该域全部模板，其他低ID拒绝。除ID2和ID>=256外的set均拒绝，包括本题不支持的Options ID3。仅ID>=256的数据set按对应模板依次解出记录，输出原字段字节及enterprise/id和字段次序，不查外部类型字典；未知模板使整消息失败，不暂用未来模板。每个模板至少有一个字段，最短记录长度为固定长度总和加变长字段个数；剩余字节少于此最短长度且至多3个并全零时才视为填充，否则必须继续解析完整记录，不能把可解析的全零记录当填充。模板set也仅允许不足4字节且全零的末填充。模板作用域为宿主传入的TCP连接身份和domain，按消息内set顺序生效，不同domain独立；连接重建换身份且不继承旧模板。每域第一消息接受任意sequence，后续须等于上次sequence加上次消息已解数据记录数的uint32回绕值，模板记录不计入，exportTime不决定顺序。完整消息通过后才提交模板、序号及记录；坏字段、短数据或错误序号整消息回滚，不发布半消息；任何错误将当前接收实例置为失败终态，后续追加拒绝，宿主需显式新建接收实例，不自行寻找下一帧；流输入在真实EOF处残头或残消息报截断并保留已提交消息。设置单消息字节、模板字段数、模板总数及单消息记录数预算，超限先停止不按恶意声明分配。交付采集宿主示例和独立编码测试，覆盖同消息先数据后模板的拒绝、替换前后两组数据、变长255分支、全零合法记录、撤回全部、domain隔离、序号回绕及所有切块点。
