# DOM 增量快照应用

结构化网页采集器要可直接接入 TypeScript DOM 增量快照组件，应用 node insert/remove、attribute、text 与 shadow root 事件。操作引用不存在节点时缓存到有界等待区，删除父树使后续旧事件失效；每个版本可生成确定哈希，并与同版本完整快照对照。
