# MIME 多层附件流式提取

邮件采集管线要嵌入可嵌入的 C++ MIME 流解析库，处理嵌套 multipart、折叠头、boundary 跨块、base64/quoted-printable 和 RFC 2231 文件名。限制嵌套深度与解码膨胀；损坏附件精确标记原字节范围，其他 sibling 仍可交付。
