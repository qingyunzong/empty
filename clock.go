package causalmsg

// VectorClock 记录各节点已知的事件序号。比较只基于向量时钟，
// 库内不存在任何物理时间戳，消息不会因"时间更晚"被强行交付。
type VectorClock map[string]uint64

// Clone 返回向量时钟的深拷贝。
func (c VectorClock) Clone() VectorClock {
	out := make(VectorClock, len(c))
	for k, v := range c {
		out[k] = v
	}
	return out
}

// LessEqual 报告 c 是否在每个分量上都小于等于 o（缺失分量视为 0）。
func (c VectorClock) LessEqual(o VectorClock) bool {
	for k, v := range c {
		if o[k] < v {
			return false
		}
	}
	return true
}

// Equal 报告两个向量时钟是否在所有分量上相等（缺失分量视为 0）。
func (c VectorClock) Equal(o VectorClock) bool {
	return c.LessEqual(o) && o.LessEqual(c)
}

// merge 将 o 按分量取最大值合并进 c。
func (c VectorClock) merge(o VectorClock) {
	for k, v := range o {
		if c[k] < v {
			c[k] = v
		}
	}
}
