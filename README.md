# WARC revisit 载荷解析

网页档案服务需要可导入的 Go WARC 记录关系库，把 response、request、revisit、conversion 与 continuation 通过 record id 和 refers-to 连接。revisit payload digest 只能引用已验证原记录，循环或跨集合缺失明确失败；分段记录按 segment number/total length 无缝重组。
