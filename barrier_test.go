package barrier

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"testing"
	"time"
)

func waitArrived(t *testing.T, b *Barrier, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for b.Arrived() != n {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for Arrived()==%d, got %d", n, b.Arrived())
		}
		time.Sleep(time.Millisecond)
	}
}

func waitGen(t *testing.T, b *Barrier, g uint64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for b.Generation() != g {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for Generation()==%d, got %d", g, b.Generation())
		}
		time.Sleep(time.Millisecond)
	}
}

func recvResult(t *testing.T, ch <-chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for Wait to return")
		return nil
	}
}

func goWait(b *Barrier, ctx context.Context) chan error {
	ch := make(chan error, 1)
	go func() { ch <- b.Wait(ctx) }()
	return ch
}

// 成员永久退出：本轮退出者计入已到达，下轮人数减少。
func TestLeaveCountsAsArrivedAndShrinksNextRound(t *testing.T) {
	b := New(3)
	ctx := context.Background()

	// Round 0: two members wait, the third leaves permanently.
	d1 := goWait(b, ctx)
	d2 := goWait(b, ctx)
	waitArrived(t, b, 2)
	b.Leave() // the departure counts as the third arrival -> releases round 0
	if err := recvResult(t, d1); err != nil {
		t.Fatalf("waiter 1: %v", err)
	}
	if err := recvResult(t, d2); err != nil {
		t.Fatalf("waiter 2: %v", err)
	}
	if got := b.Parties(); got != 2 {
		t.Fatalf("Parties()=%d, want 2 after one Leave", got)
	}
	waitGen(t, b, 1)

	// Round 1: only two members are needed now.
	d3 := goWait(b, ctx)
	waitArrived(t, b, 1)
	d4 := goWait(b, ctx)
	if err := recvResult(t, d3); err != nil {
		t.Fatalf("waiter 3: %v", err)
	}
	if err := recvResult(t, d4); err != nil {
		t.Fatalf("waiter 4: %v", err)
	}
	waitGen(t, b, 2)
}

// 取消等待只撤销本次到达，不能破坏其他轮。
func TestCancelRevokesOnlyThisArrival(t *testing.T) {
	b := New(2)
	bg := context.Background()

	// Round 0: one member arrives, then cancels.
	ctx1, cancel1 := context.WithCancel(bg)
	d1 := goWait(b, ctx1)
	waitArrived(t, b, 1)
	cancel1()
	if err := recvResult(t, d1); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled wait: got %v, want context.Canceled", err)
	}
	waitArrived(t, b, 0) // the arrival was revoked
	if got := b.Generation(); got != 0 {
		t.Fatalf("Generation()=%d, want 0: cancel must not release the round", got)
	}

	// The same round is still intact: two fresh arrivals release it.
	d2 := goWait(b, bg)
	waitArrived(t, b, 1)
	d3 := goWait(b, bg)
	if err := recvResult(t, d2); err != nil {
		t.Fatalf("waiter 2: %v", err)
	}
	if err := recvResult(t, d3); err != nil {
		t.Fatalf("waiter 3: %v", err)
	}
	waitGen(t, b, 1)

	// Later rounds are unaffected too.
	d4 := goWait(b, bg)
	d5 := goWait(b, bg)
	if err := recvResult(t, d4); err != nil {
		t.Fatalf("waiter 4: %v", err)
	}
	if err := recvResult(t, d5); err != nil {
		t.Fatalf("waiter 5: %v", err)
	}
	waitGen(t, b, 2)
}

// 每轮只释放一次：迟到者进入新一轮，不会重复触发上一轮。
func TestEachRoundReleasesExactlyOnce(t *testing.T) {
	b := New(2)
	bg := context.Background()

	d1 := goWait(b, bg)
	d2 := goWait(b, bg)
	recvResult(t, d1)
	recvResult(t, d2)
	waitGen(t, b, 1)
	waitArrived(t, b, 0)

	// A late arrival belongs to round 1 and must not re-release round 0.
	d3 := goWait(b, bg)
	waitArrived(t, b, 1)
	select {
	case err := <-d3:
		t.Fatalf("late waiter returned early with %v; round released twice", err)
	case <-time.After(20 * time.Millisecond):
	}
	if got := b.Generation(); got != 1 {
		t.Fatalf("Generation()=%d, want 1: round 0 released more than once", got)
	}

	d4 := goWait(b, bg)
	recvResult(t, d3)
	recvResult(t, d4)
	waitGen(t, b, 2)
}

// 屏障代际：旧轮的取消不能影响新一代的到达计数。
func TestGenerationIsolatesStaleWaiters(t *testing.T) {
	b := New(2)
	bg := context.Background()

	// Round 0 releases while a stale cancellable context still exists.
	ctxStale, cancelStale := context.WithCancel(bg)
	d1 := goWait(b, ctxStale)
	waitArrived(t, b, 1)
	d2 := goWait(b, bg)
	if err := recvResult(t, d1); err != nil {
		t.Fatalf("stale waiter must see its round released, got %v", err)
	}
	recvResult(t, d2)
	waitGen(t, b, 1)

	// Round 1: one arrival recorded.
	d3 := goWait(b, bg)
	waitArrived(t, b, 1)

	// Cancelling the stale (round 0) context must not touch round 1.
	cancelStale()
	time.Sleep(20 * time.Millisecond)
	if got := b.Arrived(); got != 1 {
		t.Fatalf("Arrived()=%d, want 1: stale cancellation leaked into new generation", got)
	}

	d4 := goWait(b, bg)
	recvResult(t, d3)
	recvResult(t, d4)
	waitGen(t, b, 2)
}

// model is a test oracle mirroring the specified barrier semantics.
type model struct {
	gen     uint64
	arrived int
	parties int
}

func (m *model) arrive() {
	m.arrived++
	if m.arrived == m.parties {
		m.arrived = 0
		m.gen++
	}
}

func (m *model) revoke() { m.arrived-- }

func (m *model) leave() {
	m.arrived++
	m.parties--
	if m.arrived >= m.parties {
		m.arrived = 0
		m.gen++
	}
}

// 枚举三成员历史：穷举三成员 {等待, 取消, 永久退出} 的全部 8x8 组合，
// 用模型预言机校验每一代的释放次数、到达计数与人数收缩。
func TestEnumerateThreeMemberHistories(t *testing.T) {
	for leaveMask := 0; leaveMask < 1<<3; leaveMask++ {
		for cancelMask := 0; cancelMask < 1<<3; cancelMask++ {
			leaveMask, cancelMask := leaveMask, cancelMask
			t.Run(fmt.Sprintf("leave=%03b_cancel=%03b", leaveMask, cancelMask), func(t *testing.T) {
				b := New(3)
				bg := context.Background()
				var oracle model
				oracle.parties = 3

				// Member roles: leave wins over cancel wins over wait.
				var normal []chan error
				var normalCancel []context.CancelFunc
				var cancellerResults []chan error
				var cancellerCancel []context.CancelFunc
				leavers := 0
				for i := 0; i < 3; i++ {
					switch {
					case leaveMask>>i&1 == 1:
						leavers++
					case cancelMask>>i&1 == 1:
						ctx, cancel := context.WithCancel(bg)
						cancellerCancel = append(cancellerCancel, cancel)
						cancellerResults = append(cancellerResults, goWait(b, ctx))
						oracle.arrive()
					default:
						ctx, cancel := context.WithCancel(bg)
						normalCancel = append(normalCancel, cancel)
						normal = append(normal, goWait(b, ctx))
						oracle.arrive()
					}
				}
				defer func() {
					for _, cancel := range normalCancel {
						cancel()
					}
				}()

				// Phase 1: all arrivals of waiters and cancellers register.
				// Wait for the generation first: if the round released,
				// Arrived() has already reset to 0.
				waitGen(t, b, oracle.gen)
				waitArrived(t, b, oracle.arrived)

				// Phase 2: cancellers cancel. If their round already
				// released, the cancel is a no-op and Wait returns nil;
				// otherwise only their own arrival is revoked.
				releasedBeforeCancel := oracle.gen > 0
				for _, cancel := range cancellerCancel {
					cancel()
				}
				for _, ch := range cancellerResults {
					err := recvResult(t, ch)
					if releasedBeforeCancel {
						if err != nil {
							t.Fatalf("canceller in released round: got %v, want nil", err)
						}
					} else if !errors.Is(err, context.Canceled) {
						t.Fatalf("canceller: got %v, want context.Canceled", err)
					}
				}
				if !releasedBeforeCancel {
					for range cancellerCancel {
						oracle.revoke()
					}
				}
				waitArrived(t, b, oracle.arrived)

				// Phase 3: leavers exit permanently, one by one.
				for i := 0; i < leavers; i++ {
					b.Leave()
					oracle.leave()
				}

				// Final state must match the oracle exactly.
				waitGen(t, b, oracle.gen)
				waitArrived(t, b, oracle.arrived)
				if got := b.Parties(); got != oracle.parties {
					t.Fatalf("Parties()=%d, want %d", got, oracle.parties)
				}

				// Round 0 waiters: released iff round 0 released (gen >= 1).
				roundReleased := oracle.gen > 0
				for _, ch := range normal {
					if roundReleased {
						if err := recvResult(t, ch); err != nil {
							t.Fatalf("waiter in released round: got %v, want nil", err)
						}
					} else {
						select {
						case err := <-ch:
							t.Fatalf("waiter returned %v though round 0 never released", err)
						default:
						}
					}
				}

				// History invariant: every generation released at most once,
				// so the generation counter never jumps by more than one per
				// release point observed above (checked via waitGen steps).
				t.Logf("history: gen=%d arrived=%d parties=%d", oracle.gen, oracle.arrived, oracle.parties)
			})
		}
	}
}

// 并发压力（取消）：取消只撤销本次到达，屏障必须持续完成每一轮。
func TestConcurrentStressCancel(t *testing.T) {
	for trial := 0; trial < 50; trial++ {
		b := New(3)
		bg := context.Background()

		var wg sync.WaitGroup
		for w := 0; w < 3; w++ {
			wrng := rand.New(rand.NewSource(int64(trial*8 + w)))
			wg.Add(1)
			go func() {
				defer wg.Done()
				for round := 0; round < 20; round++ {
					ctx := bg
					if wrng.Intn(4) == 0 {
						var cancel context.CancelFunc
						ctx, cancel = context.WithCancel(bg)
						delay := time.Duration(wrng.Intn(3)) * time.Millisecond
						go func() {
							time.Sleep(delay)
							cancel()
						}()
					}
					err := b.Wait(ctx)
					if err != nil && !errors.Is(err, context.Canceled) {
						t.Errorf("unexpected Wait error: %v", err)
						return
					}
					if err != nil {
						// Cancelled this arrival: re-arrive so the
						// member still joins its round.
						if err = b.Wait(bg); err != nil {
							t.Errorf("unexpected Wait error: %v", err)
							return
						}
					}
				}
			}()
		}
		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatalf("trial %d: barrier deadlocked without any Leave", trial)
		}
	}
}

// 并发压力（退出）：Leave 与 Wait/Cancel 并发时的线程安全性。
// 退出者的额外到达可能使个别成员错过一代而合法地阻塞，
// 因此等待带超时；这里校验不出现非法错误、人数正确收缩且屏障曾推进。
func TestConcurrentStressLeave(t *testing.T) {
	for trial := 0; trial < 30; trial++ {
		b := New(3)
		rng := rand.New(rand.NewSource(int64(trial)))
		bg := context.Background()

		var wg sync.WaitGroup
		for w := 0; w < 3; w++ {
			wrng := rand.New(rand.NewSource(int64(trial*8 + w)))
			wg.Add(1)
			go func() {
				defer wg.Done()
				for round := 0; round < 10; round++ {
					ctx, cancel := context.WithTimeout(bg, 200*time.Millisecond)
					if wrng.Intn(4) == 0 {
						delay := time.Duration(wrng.Intn(3)) * time.Millisecond
						go func() {
							time.Sleep(delay)
							cancel()
						}()
					}
					err := b.Wait(ctx)
					cancel()
					if err != nil &&
						!errors.Is(err, context.Canceled) &&
						!errors.Is(err, context.DeadlineExceeded) {
						t.Errorf("unexpected Wait error: %v", err)
						return
					}
				}
			}()
		}
		// One permanent exit at a random moment.
		time.Sleep(time.Duration(rng.Intn(5)) * time.Millisecond)
		b.Leave()
		wg.Wait()

		if got := b.Parties(); got != 2 {
			t.Fatalf("trial %d: Parties()=%d, want 2", trial, got)
		}
		if got := b.Generation(); got == 0 {
			t.Fatalf("trial %d: barrier never released a round", trial)
		}
	}
}

func TestWaitWithNoMembers(t *testing.T) {
	b := New(1)
	b.Leave() // last member exits
	if err := b.Wait(context.Background()); !errors.Is(err, ErrNoMembers) {
		t.Fatalf("got %v, want ErrNoMembers", err)
	}
}
