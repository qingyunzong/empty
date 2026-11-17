package formal_test

import (
	"testing"
	"time"

	formal "example.org/dlks/formal/q10166"
)

// WithMaxNegativeTTL 可把否定缓存 TTL 封顶到实现策略值。
func TestNegativeTTLCap(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(10000, 0))
	cache := formal.NewCache(
		formal.WithClock(clock),
		formal.WithMaxNegativeTTL(10*time.Second),
	)

	cache.Store(&formal.Message{
		Name:      "cap.example.",
		QType:     formal.TypeA,
		RCode:     formal.RCodeNXDomain,
		Authority: []formal.RR{soaRR("example.", 600, 300)},
	})
	msg := assertHit(t, cache.Lookup("cap.example.", formal.TypeA))
	if msg.Authority[0].TTL != 10 {
		t.Fatalf("否定 TTL 应被封顶为 10s，实际 %d", msg.Authority[0].TTL)
	}
	clock.Advance(10 * time.Second)
	assertMiss(t, cache.Lookup("cap.example.", formal.TypeA))
}

// CNAME 自环不会让查找陷入死循环，超限后按未命中处理以便重新查询。
func TestCNAMELoopDoesNotHang(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(11000, 0))
	cache := formal.NewCache(formal.WithClock(clock))

	cache.Store(&formal.Message{
		Name:   "loop.example.",
		QType:  formal.TypeA,
		RCode:  formal.RCodeOK,
		Answer: []formal.RR{cnameRR("loop.example.", 60, "loop.example.")},
	})

	done := make(chan struct{})
	go func() {
		defer close(done)
		if msg := cache.Lookup("loop.example.", formal.TypeA); msg != nil {
			t.Errorf("自环链无法到达末端，应按未命中返回 nil，实际 %+v", msg)
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("CNAME 环导致查找未在限定跳数内终止")
	}
}

// 同一 (名称, 类型) 下多条记录以组内最小 TTL 统一到期。
func TestRRSetUsesMinimumTTL(t *testing.T) {
	clock := formal.NewVirtualClock(time.Unix(12000, 0))
	cache := formal.NewCache(formal.WithClock(clock))

	cache.Store(&formal.Message{
		Name:  "multi.example.",
		QType: formal.TypeA,
		RCode: formal.RCodeOK,
		Answer: []formal.RR{
			aRR("multi.example.", 100, "192.0.2.1"),
			aRR("multi.example.", 40, "192.0.2.2"),
		},
	})

	msg := assertHit(t, cache.Lookup("multi.example.", formal.TypeA))
	if len(msg.Answer) != 2 {
		t.Fatalf("两条 A 记录应作为一个 RRSet 缓存，实际 %d 条", len(msg.Answer))
	}
	if msg.Answer[0].TTL != 40 || msg.Answer[1].TTL != 40 {
		t.Fatalf("组内 TTL 应统一为最小值 40，实际 %d/%d", msg.Answer[0].TTL, msg.Answer[1].TTL)
	}
	clock.Advance(40 * time.Second)
	assertMiss(t, cache.Lookup("multi.example.", formal.TypeA))
}
