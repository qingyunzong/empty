# 多表变更日志中的模式代际

数据采集宿主需要可导入的Go模式代际解码包，输入严格递增全局序号事件：schema(table,generation,有序列ID类型)、row(table,generation,值序列)和commit。row必须按所指代际映射稳定列ID，列重排不能串值；已提交同表代际严格递增，同批schema按全局序号出现且也递增，类型仅可空int64、字符串和布尔，未知代际先暂存但commit时未解决整批拒绝。schema与row在commit前私有，任一行类型错误撤销本批模式和数据。用交错表、先row后schema、重排及提交回滚测试。
