package q251

import (
	"sync"
	"time"
)

// Clock 抽象采样时钟，生产环境用 RealClock，测试用 FakeClock 手动推进。
type Clock interface {
	// Now 返回时钟起点至今的单调时长。
	Now() time.Duration
	// NewTimer 返回在 d 之后触发的定时器。
	NewTimer(d time.Duration) Timer
}

// Timer 是一次性定时器。
type Timer interface {
	C() <-chan time.Time
	Stop()
}

// RealClock 基于系统单调时钟。
type RealClock struct {
	base time.Time
}

func NewRealClock() *RealClock {
	return &RealClock{base: time.Now()}
}

func (c *RealClock) Now() time.Duration {
	return time.Since(c.base)
}

func (c *RealClock) NewTimer(d time.Duration) Timer {
	return realTimer{t: time.NewTimer(d)}
}

type realTimer struct {
	t *time.Timer
}

func (r realTimer) C() <-chan time.Time { return r.t.C }
func (r realTimer) Stop()               { r.t.Stop() }

// FakeClock 是可控时钟：时间只能通过 Advance 前进，定时器在到达
// 各自截止时间时触发。所有方法可并发调用。
type FakeClock struct {
	mu     sync.Mutex
	now    time.Duration
	timers map[*fakeTimer]struct{}
}

func NewFakeClock() *FakeClock {
	return &FakeClock{timers: make(map[*fakeTimer]struct{})}
}

func (c *FakeClock) Now() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *FakeClock) NewTimer(d time.Duration) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{at: c.now + d, c: make(chan time.Time), clock: c}
	if d <= 0 {
		t.fired = true
		close(t.c)
		return t
	}
	c.timers[t] = struct{}{}
	return t
}

// Advance 把时钟前进 d，并触发所有截止时间不晚于新时刻的定时器。
func (c *FakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now += d
	for t := range c.timers {
		if t.at <= c.now {
			delete(c.timers, t)
			t.fired = true
			close(t.c)
		}
	}
}

type fakeTimer struct {
	at    time.Duration
	c     chan time.Time
	fired bool
	clock *FakeClock
}

func (t *fakeTimer) C() <-chan time.Time { return t.c }

func (t *fakeTimer) Stop() {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	if !t.fired {
		delete(t.clock.timers, t)
		t.fired = true
	}
}
