# PostgreSQL logical slot 快照衔接

同步器需要可导入的 Go PostgreSQL 初始快照衔接组件，绑定 exported snapshot、consistent point、relation schema 与后续 WAL。快照行和变更按主键/LSN 去重，DDL relation 版本切换不能误解旧 tuple；只有 sink 确认后推进 flush LSN，并可从任意崩溃点恢复。
