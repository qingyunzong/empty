# FTPS 被动数据通道配对

遗留采集代理要可嵌入 C++ FTPS 会话组件，把控制响应、多行回复、EPSV/PASV 数据通道和 TLS 会话绑定到同一传输事务。服务器返回私网 PASV 地址时按策略改写，但不得跨主机；ABOR、超时与迟到226竞争时产生唯一文件终态。

## 组件结构（dataeng.hpp / dataeng.cpp）

- `ReplyParser`：增量解析控制通道，支持 RFC 959 多行回复（`nnn-` … `nnn `）。
- `parse_pasv_reply` / `parse_epsv_reply`：解析 227 / 229 应答得到数据通道端点。
- `resolve_data_endpoint`：PASV 私网地址（RFC1918/环回/链路本地）按 `PasvAddressPolicy`
  改写为控制连接对端主机；公网地址原样使用，改写永不跨主机。
- `TransferTransaction`：每个文件一个事务；226、ABOR、超时、TLS 会话不匹配中
  先到者确定唯一终态（`kCompleted`/`kAborted`/`kTimedOut`/`kFailed`），
  迟到的 226/426 被排空，终态回调恰好触发一次。
- `Session`：持有控制对端身份与 TLS 会话 ID，为每次传输派生绑定同一
  TLS 会话的事务；EPSV 数据通道始终使用控制对端主机。

## 构建与测试

```sh
cmake -S . -B build && cmake --build build
cd build && ctest --output-on-failure
```
