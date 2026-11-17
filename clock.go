package formal

import "time"

// Clock 抽象时间来源，使缓存 TTL 可以在测试中用虚拟时钟精确驱动。
type Clock interface {
	Now() time.Time
}

// SystemClock 使用真实墙上时间。
type SystemClock struct{}

// Now 返回当前真实时间。
func (SystemClock) Now() time.Time { return time.Now() }

// VirtualClock 是可手动推进的测试时钟。
type VirtualClock struct {
	now time.Time
}

// NewVirtualClock 以 t 为起点创建虚拟时钟；t 为零值时使用当前真实时间。
func NewVirtualClock(t time.Time) *VirtualClock {
	if t.IsZero() {
		t = time.Now()
	}
	return &VirtualClock{now: t}
}

// Now 返回虚拟当前时间。
func (c *VirtualClock) Now() time.Time { return c.now }

// Advance 将虚拟时钟向前推进 d。
func (c *VirtualClock) Advance(d time.Duration) { c.now = c.now.Add(d) }

// Set 直接设置虚拟当前时间。
func (c *VirtualClock) Set(t time.Time) { c.now = t }
