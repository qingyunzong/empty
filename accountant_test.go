package dataeng

import (
	"errors"
	"math"
	"sync"
	"testing"
	"time"
)

var testKey = Key{Dataset: "clicks", Domain: "eu-users", Mechanism: "laplace"}

func TestReserveCommitSettlesOnce(t *testing.T) {
	a := NewAccountant()
	if err := a.SetBudget(testKey, Budget{Epsilon: 1, Delta: 1e-5}); err != nil {
		t.Fatal(err)
	}
	res, err := a.Reserve(testKey, Cost{Epsilon: 0.4, Delta: 1e-6}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := res.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := res.Commit(); !errors.Is(err, ErrReservationClosed) {
		t.Fatalf("second commit: got %v, want ErrReservationClosed", err)
	}
	res.Release() // no-op after commit
	if got := a.Spent(testKey); got.Epsilon != 0.4 || got.Delta != 1e-6 {
		t.Fatalf("spent = %+v, want exactly one settlement of 0.4/1e-6", got)
	}
}

func TestReleaseThenCommitFails(t *testing.T) {
	a := NewAccountant()
	if err := a.SetBudget(testKey, Budget{Epsilon: 1}); err != nil {
		t.Fatal(err)
	}
	res, err := a.Reserve(testKey, Cost{Epsilon: 0.5}, 0)
	if err != nil {
		t.Fatal(err)
	}
	res.Release()
	res.Release() // idempotent
	if err := res.Commit(); !errors.Is(err, ErrReservationClosed) {
		t.Fatalf("commit after release: got %v, want ErrReservationClosed", err)
	}
	if got := a.Spent(testKey); !got.zero() {
		t.Fatalf("spent = %+v, want zero: failed query must not be published", got)
	}
	if got := a.Held(testKey); !got.zero() {
		t.Fatalf("held = %+v, want zero after release", got)
	}
}

func TestTimeoutReleasesBudget(t *testing.T) {
	a := NewAccountant()
	if err := a.SetBudget(testKey, Budget{Epsilon: 1}); err != nil {
		t.Fatal(err)
	}
	res, err := a.Reserve(testKey, Cost{Epsilon: 1}, 20*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	if err := res.Commit(); !errors.Is(err, ErrReservationExpired) {
		t.Fatalf("commit after timeout: got %v, want ErrReservationExpired", err)
	}
	res.Release() // no-op after expiry
	if got := a.Spent(testKey); !got.zero() {
		t.Fatalf("spent = %+v, want zero after timeout", got)
	}
	// Budget must be reusable after expiry.
	res2, err := a.Reserve(testKey, Cost{Epsilon: 1}, 0)
	if err != nil {
		t.Fatalf("reserve after expiry: %v", err)
	}
	if err := res2.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentReserveIsAtomic(t *testing.T) {
	a := NewAccountant()
	if err := a.SetBudget(testKey, Budget{Epsilon: 10}); err != nil {
		t.Fatal(err)
	}
	const goroutines = 64
	var wg sync.WaitGroup
	var mu sync.Mutex
	committed := 0
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := a.Reserve(testKey, Cost{Epsilon: 1}, 0)
			if err != nil {
				return
			}
			if err := res.Commit(); err == nil {
				mu.Lock()
				committed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if committed != 10 {
		t.Fatalf("committed = %d, want exactly 10", committed)
	}
	if got := a.Spent(testKey); got.Epsilon != 10 {
		t.Fatalf("spent epsilon = %v, want 10", got.Epsilon)
	}
	if _, err := a.Reserve(testKey, Cost{Epsilon: 0.001}, 0); !errors.Is(err, ErrInsufficientBudget) {
		t.Fatalf("reserve beyond budget: got %v, want ErrInsufficientBudget", err)
	}
}

func TestConcurrentCommitReleaseRace(t *testing.T) {
	// Hammer commit vs release vs expiry on the same reservations; settled
	// spend must never exceed one settlement per reservation.
	a := NewAccountant()
	if err := a.SetBudget(testKey, Budget{Epsilon: 1000}); err != nil {
		t.Fatal(err)
	}
	const n = 200
	reservations := make([]*Reservation, n)
	for i := range reservations {
		res, err := a.Reserve(testKey, Cost{Epsilon: 1}, 5*time.Millisecond)
		if err != nil {
			t.Fatal(err)
		}
		reservations[i] = res
	}
	var wg sync.WaitGroup
	for _, res := range reservations {
		wg.Add(3)
		go func(r *Reservation) { defer wg.Done(); r.Commit() }(res)
		go func(r *Reservation) { defer wg.Done(); r.Release() }(res)
		go func(r *Reservation) { defer wg.Done(); r.Commit() }(res)
	}
	wg.Wait()
	time.Sleep(10 * time.Millisecond)
	spent := a.Spent(testKey)
	settled := 0
	for _, res := range reservations {
		if res.State() == Committed {
			settled++
		}
	}
	if spent.Epsilon != float64(settled) {
		t.Fatalf("spent epsilon = %v, want %v (one settlement per committed reservation)", spent.Epsilon, settled)
	}
}

func TestRDPCompositionAndBestBound(t *testing.T) {
	a := NewAccountant()
	key := Key{Dataset: "events", Domain: "all", Mechanism: "gaussian"}
	if err := a.SetBudget(key, Budget{RDP: map[float64]float64{2: 4, 10: 12}}); err != nil {
		t.Fatal(err)
	}
	// Two queries composing at different orders.
	for _, c := range []Cost{
		{RDP: map[float64]float64{2: 0.5, 10: 1.5}},
		{RDP: map[float64]float64{2: 0.5, 10: 1.5}},
	} {
		res, err := a.Reserve(key, c, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err := res.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	spent := a.Spent(key)
	if spent.RDP[2] != 1 || spent.RDP[10] != 3 {
		t.Fatalf("composed RDP = %v, want {2:1, 10:3}", spent.RDP)
	}
	// delta = 1e-5, ln(1/delta) = 11.512925...
	// alpha=2:  1 + 11.512925/1 = 12.512925
	// alpha=10: 3 + 11.512925/9 = 4.279214  <- best bound
	eps, totalDelta, err := a.PublishedEpsilon(key, 1e-5)
	if err != nil {
		t.Fatal(err)
	}
	want := 3 + math.Log(1e5)/9
	if math.Abs(eps-want) > 1e-9 {
		t.Fatalf("epsilon = %v, want best bound %v", eps, want)
	}
	if totalDelta != 1e-5 {
		t.Fatalf("total delta = %v, want 1e-5", totalDelta)
	}
}

func TestFailedQueryNotPublished(t *testing.T) {
	a := NewAccountant()
	key := Key{Dataset: "events", Domain: "all", Mechanism: "gaussian"}
	if err := a.SetBudget(key, Budget{RDP: map[float64]float64{2: 4}}); err != nil {
		t.Fatal(err)
	}
	res, err := a.Reserve(key, Cost{RDP: map[float64]float64{2: 1}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	res.Release() // query failed: cancel the reservation
	if got := a.Spent(key); !got.zero() {
		t.Fatalf("spent = %+v, want zero for failed query", got)
	}
	if _, _, err := a.PublishedEpsilon(key, 1e-5); err != nil {
		t.Fatalf("published epsilon with no spend should be 0, got err %v", err)
	}
	rem, err := a.Remaining(key)
	if err != nil {
		t.Fatal(err)
	}
	if rem.RDP[2] != 4 {
		t.Fatalf("remaining RDP budget = %v, want 4 after release", rem.RDP[2])
	}
}

func TestReserveValidation(t *testing.T) {
	a := NewAccountant()
	if _, err := a.Reserve(testKey, Cost{Epsilon: 1}, 0); !errors.Is(err, ErrNoBudget) {
		t.Fatalf("reserve without budget: got %v, want ErrNoBudget", err)
	}
	if err := a.SetBudget(testKey, Budget{Epsilon: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Reserve(testKey, Cost{Epsilon: -1}, 0); !errors.Is(err, ErrInvalidCost) {
		t.Fatalf("negative cost: got %v, want ErrInvalidCost", err)
	}
	if _, err := a.Reserve(testKey, Cost{RDP: map[float64]float64{0.5: 1}}, 0); !errors.Is(err, ErrInvalidCost) {
		t.Fatalf("alpha <= 1: got %v, want ErrInvalidCost", err)
	}
	if _, err := a.Reserve(testKey, Cost{RDP: map[float64]float64{2: 1}}, 0); !errors.Is(err, ErrInsufficientBudget) {
		t.Fatalf("RDP spend without RDP budget: got %v, want ErrInsufficientBudget", err)
	}
}

func TestIndependentLedgers(t *testing.T) {
	a := NewAccountant()
	k1 := Key{Dataset: "a", Domain: "d", Mechanism: "m"}
	k2 := Key{Dataset: "a", Domain: "d", Mechanism: "m2"}
	if err := a.SetBudget(k1, Budget{Epsilon: 1}); err != nil {
		t.Fatal(err)
	}
	if err := a.SetBudget(k2, Budget{Epsilon: 1}); err != nil {
		t.Fatal(err)
	}
	res, err := a.Reserve(k1, Cost{Epsilon: 1}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := res.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Reserve(k1, Cost{Epsilon: 0.1}, 0); !errors.Is(err, ErrInsufficientBudget) {
		t.Fatalf("k1 should be exhausted, got %v", err)
	}
	if _, err := a.Reserve(k2, Cost{Epsilon: 1}, 0); err != nil {
		t.Fatalf("k2 must be independent, got %v", err)
	}
}
