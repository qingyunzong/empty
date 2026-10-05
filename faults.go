package numalloc

import "sync"

// 故障注入点。
const (
	FaultAllocWrite = "alloc.write" // 分配器日志落盘失败(提交前崩溃)
	FaultAllocAck   = "alloc.ack"   // 区间分配已提交, 但应答丢失
	FaultCloseAck   = "close.ack"   // 关闭旧代已提交, 但应答丢失
	FaultGrantAck   = "grant.ack"   // 尾部授予已提交, 但应答丢失
	FaultNodeWrite  = "node.write"  // 节点状态落盘失败(提交前崩溃)
	FaultNodeAck    = "node.ack"    // 游标已落盘, 但发出的号码丢失(产生空洞)
)

// Faults 是一组可开关的故障注入点, 并发安全。nil *Faults 表示无故障。
type Faults struct {
	mu    sync.Mutex
	armed map[string]bool
}

func NewFaults() *Faults { return &Faults{armed: make(map[string]bool)} }

func (f *Faults) Enable(points ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range points {
		f.armed[p] = true
	}
}

func (f *Faults) Disable(points ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range points {
		delete(f.armed, p)
	}
}

func (f *Faults) Clear() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.armed = make(map[string]bool)
}

func (f *Faults) injected(point string) bool {
	if f == nil {
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.armed[point]
}
