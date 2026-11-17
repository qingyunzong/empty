package formal_test

import (
	"context"
	"fmt"
	"time"

	"example.org/dlks/formal/q2563"
)

func ExampleMachine() {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	clock := formal.ClockFunc(func() time.Time { return now })
	store := formal.NewMemoryStore()
	cfg := formal.Config{
		Cluster:        "prod-east",
		LeaseName:      "controller",
		Holder:         "pod-a",
		LeaseDuration:  10 * time.Second,
		RenewInterval:  2 * time.Second,
		ClockSkewBound: time.Second,
	}

	a, _ := formal.New(cfg, store, clock)
	_ = a.Tick(context.Background())
	fmt.Println(a.IsLeader())

	cfg.Holder = "pod-b"
	b, _ := formal.New(cfg, store, clock)

	// At exactly expiry+skew b may not take over yet.
	now = now.Add(11 * time.Second)
	_ = b.Tick(context.Background())
	fmt.Println(b.IsLeader())

	now = now.Add(time.Nanosecond)
	_ = b.Tick(context.Background())
	fmt.Println(b.IsLeader())

	// Output:
	// true
	// false
	// true
}
