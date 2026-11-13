# WARC 并发记录配对与修订

网页归档器需要可嵌入的 C++ WARC 组装库，将 request、response、revisit、metadata 和 continuation 记录按 record id 与 concurrent-to 关系配对。分段正文严格验证总长度和摘要；revisit 只能引用已知载荷。缺链输出可修复清单，不得伪造完整交换。
