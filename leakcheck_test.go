package formal

import (
	"context"
	"runtime"
	"testing"
	"time"
)

func TestNoGoroutineLeakWhenQuorumFails(t *testing.T) {
	_, transport, cfg := newGroup(t, 3, 2, 2)
	coord := NewCoordinator(cfg, transport)
	transport.Partition("r2")
	transport.Partition("r3")

	before := runtime.NumGoroutine()
	for i := 0; i < 20; i++ {
		_, _ = coord.Put(context.Background(), testKey, []byte("x"))
		_, _, _ = coord.Get(context.Background(), testKey)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if runtime.NumGoroutine() <= before+2 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("goroutines leaked: before=%d after=%d", before, runtime.NumGoroutine())
}
