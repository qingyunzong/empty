# IMAP UIDVALIDITY 邮件增量归档

邮件归档服务需要可导入的 Go IMAP 增量状态库，联合 UIDVALIDITY、UID、MODSEQ、EXPUNGE 与正文摘要维护邮箱快照。UIDVALIDITY 变化触发新世代重扫，不能沿用旧 UID 游标；QRESYNC 乱序事件经重放后与完整列表一致，并保留删除证据。
