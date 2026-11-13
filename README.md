# MIME 邮箱增量游标

邮件归档连接器需要可直接接入的 Go 增量状态组件，协调 UIDVALIDITY、UID、MODSEQ 与 VANISHED。UIDVALIDITY 变化开启新邮箱世代，QRESYNC 响应只作用于请求快照；移动导致的新 UID 与原 Message-ID 不自动视作同一记录。恢复点提交和消息落库必须具备原子接口。
