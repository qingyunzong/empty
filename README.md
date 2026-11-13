# S3 多段上传采集提交

对象采集器需要可导入的 Go 多段上传协调库，把采集会话、part number、ETag、校验和与最终对象世代绑定。重复 part 内容必须一致，complete 与 abort 竞争只能产生一个终态；恢复时核对远端 part 清单，不能把其他 upload id 的分片拼入结果。
