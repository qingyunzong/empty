# multipart 上传清单采集

对象迁移工具的库层需要可导入 TypeScript multipart 状态组件，把 upload id、part number、ETag、size 和源对象版本持久化。并发重传同 part 只接受内容一致回执，complete 清单按序且完整；源版本变化中止旧 upload，恢复先回读服务端 parts 对账。
