package opctx

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var t0 = time.Unix(1_000_000, 0)

func TestChildInheritsAndTightensDeadline(t *testing.T) {
	clk := NewVirtualClock(t0)
	root := BackgroundWithClock(clk)
	parent, _ := WithDeadline(root, t0.Add(100*time.Second))
	tight, _ := WithDeadline(parent, t0.Add(50*time.Second))
	loose, _ := WithDeadline(parent, t0.Add(200*time.Second))

	if d, ok := tight.Deadline(); !ok || !d.Equal(t0.Add(50*time.Second)) {
		t.Fatalf("tight deadline = %v, %v; want %v, true", d, ok, t0.Add(50*time.Second))
	}
	if d, ok := loose.Deadline(); !ok || !d.Equal(t0.Add(100*time.Second)) {
		t.Fatalf("loose deadline = %v, %v; want inherited %v, true", d, ok, t0.Add(100*time.Second))
	}

	clk.AdvanceTo(t0.Add(50 * time.Second))
	if err := tight.Err(); err != DeadlineExceeded {
		t.Fatalf("tight err = %v; want DeadlineExceeded", err)
	}
	if parent.Err() != nil || loose.Err() != nil {
		t.Fatalf("parent/sibling canceled early: parent=%v loose=%v", parent.Err(), loose.Err())
	}

	clk.AdvanceTo(t0.Add(100 * time.Second))
	if err := parent.Err(); err != DeadlineExceeded {
		t.Fatalf("parent err = %v; want DeadlineExceeded", err)
	}
	if err := loose.Err(); err != DeadlineExceeded {
		t.Fatalf("loose err = %v; want propagated DeadlineExceeded", err)
	}
}

func TestParentCancelPropagatesOnce(t *testing.T) {
	root := BackgroundWithClock(NewVirtualClock(t0))
	p, cancel := WithCancel(root)
	b, _ := WithCancel(p)
	c, _ := WithCancel(p)
	d, _ := WithDeadline(b, t0.Add(time.Hour))

	fired := make(map[string]int)
	for name, ctx := range map[string]Context{"p": p, "b": b, "c": c, "d": d} {
		name := name
		ctx.OnCancel(func() { fired[name]++ })
	}

	cancel()
	cancel() // second call must be a no-op

	for _, name := range []string{"p", "b", "c", "d"} {
		if fired[name] != 1 {
			t.Fatalf("callback %s fired %d times; want exactly 1", name, fired[name])
		}
	}
	for name, ctx := range map[string]Context{"p": p, "b": b, "c": c, "d": d} {
		if ctx.Err() != Canceled {
			t.Fatalf("%s err = %v; want Canceled", name, ctx.Err())
		}
		select {
		case <-ctx.Done():
		default:
			t.Fatalf("%s Done not closed", name)
		}
	}
}

func TestChildCancelDoesNotAffectSiblings(t *testing.T) {
	root := BackgroundWithClock(NewVirtualClock(t0))
	p, _ := WithCancel(root)
	a, cancelA := WithCancel(p)
	b, _ := WithCancel(p)

	bFired := 0
	b.OnCancel(func() { bFired++ })

	cancelA()

	if a.Err() != Canceled {
		t.Fatalf("a err = %v; want Canceled", a.Err())
	}
	if p.Err() != nil || b.Err() != nil {
		t.Fatalf("sibling/parent affected: p=%v b=%v", p.Err(), b.Err())
	}
	if bFired != 0 {
		t.Fatalf("sibling callback fired %d times; want 0", bFired)
	}
	select {
	case <-b.Done():
		t.Fatal("sibling Done closed")
	default:
	}
}

func TestOnCancelRegisteredAfterCancelFiresImmediately(t *testing.T) {
	ctx, cancel := WithCancel(Background())
	cancel()
	fired := 0
	ctx.OnCancel(func() { fired++ })
	if fired != 1 {
		t.Fatalf("late-registered callback fired %d times; want 1 (must not be missed)", fired)
	}
}

func TestDeregisterPreventsCallback(t *testing.T) {
	ctx, cancel := WithCancel(Background())
	fired := 0
	deregister := ctx.OnCancel(func() { fired++ })
	deregister()
	deregister() // idempotent
	cancel()
	if fired != 0 {
		t.Fatalf("deregistered callback fired %d times; want 0", fired)
	}
}

func TestReleaseStopsTimerAndDropsCallbacks(t *testing.T) {
	clk := NewVirtualClock(t0)
	ctx, cancel := WithDeadline(BackgroundWithClock(clk), t0.Add(10*time.Second))
	fired := 0
	ctx.OnCancel(func() { fired++ })

	if !Release(ctx) {
		t.Fatal("Release on live context returned false")
	}
	if Release(ctx) {
		t.Fatal("second Release returned true")
	}
	clk.AdvanceTo(t0.Add(time.Hour))
	if fired != 0 {
		t.Fatalf("released callback fired %d times; want 0", fired)
	}
	if ctx.Err() != nil {
		t.Fatalf("released ctx err = %v; want nil", ctx.Err())
	}
	cancel() // cancel after release is a no-op
	if ctx.Err() != nil || fired != 0 {
		t.Fatalf("cancel after release took effect: err=%v fired=%d", ctx.Err(), fired)
	}
	if n := clk.Pending(); n != 0 {
		t.Fatalf("pending timers after release = %d; want 0", n)
	}
}

func TestReleaseDetachesFromParent(t *testing.T) {
	clk := NewVirtualClock(t0)
	parent, cancelParent := WithCancel(BackgroundWithClock(clk))
	child, _ := WithDeadline(parent, t0.Add(10*time.Second))
	fired := 0
	child.OnCancel(func() { fired++ })

	Release(child)
	cancelParent()

	if child.Err() != nil || fired != 0 {
		t.Fatalf("released child affected by parent cancel: err=%v fired=%d", child.Err(), fired)
	}
	if n := clk.Pending(); n != 0 {
		t.Fatalf("pending timers = %d; want 0", n)
	}
}

func TestDoneChannelOfBackgroundIsNil(t *testing.T) {
	if Background().Done() != nil {
		t.Fatal("Background Done must be nil")
	}
	if _, ok := Background().Deadline(); ok {
		t.Fatal("Background must have no deadline")
	}
}

// TestRegisterRacingCancelNeverMissed hammers the race between OnCancel
// and cancellation: every registered callback must fire exactly once.
func TestRegisterRacingCancelNeverMissed(t *testing.T) {
	const callbacks = 8
	for iter := 0; iter < 300; iter++ {
		ctx, cancel := WithCancel(Background())
		var counts [callbacks]int32
		var wg sync.WaitGroup
		for i := 0; i < callbacks; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				ctx.OnCancel(func() { atomic.AddInt32(&counts[i], 1) })
			}(i)
		}
		go cancel()
		wg.Wait()
		<-ctx.Done()
		deadline := time.Now().Add(5 * time.Second)
		for {
			total := int32(0)
			for i := 0; i < callbacks; i++ {
				total += atomic.LoadInt32(&counts[i])
			}
			if total == callbacks {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("iter %d: only %d/%d callbacks fired; registration was missed", iter, total, callbacks)
			}
			time.Sleep(time.Millisecond)
		}
		for i := 0; i < callbacks; i++ {
			if got := atomic.LoadInt32(&counts[i]); got != 1 {
				t.Fatalf("iter %d: callback %d fired %d times; want exactly 1", iter, i, got)
			}
		}
	}
}
