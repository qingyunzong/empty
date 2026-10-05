package reservation

import (
	"errors"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func at(sec int) time.Time { return t0.Add(time.Duration(sec) * time.Second) }

func seeded(t *testing.T, batches map[string]int) *Store {
	t.Helper()
	s := NewStore()
	ids := []string{"A", "B", "C"}
	for _, id := range ids {
		if q, ok := batches[id]; ok {
			if err := s.Stock(at(0), id, q); err != nil {
				t.Fatalf("stock %s: %v", id, err)
			}
		}
	}
	return s
}

func mustConserve(t *testing.T, s *Store) {
	t.Helper()
	if err := s.CheckConservation(); err != nil {
		t.Fatalf("conservation violated: %v", err)
	}
}

// 预留跨多个批次的货位。
func TestReserveSpansMultipleBatches(t *testing.T) {
	s := seeded(t, map[string]int{"A": 5, "B": 5})
	r, err := s.Reserve(at(1), "req-1", map[string]int{"A": 4, "B": 3}, at(100))
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if r.State != Active || r.Generation != 1 {
		t.Fatalf("unexpected reservation: %+v", r)
	}
	if got := s.Batch("A").Available; got != 1 {
		t.Fatalf("A available = %d, want 1", got)
	}
	if got := s.Batch("B").Available; got != 2 {
		t.Fatalf("B available = %d, want 2", got)
	}
	mustConserve(t, s)
}

// 预留是原子的：任一批次不足则整体失败，不扣减任何货位。
func TestReserveAtomicAcrossBatches(t *testing.T) {
	s := seeded(t, map[string]int{"A": 5, "B": 2})
	_, err := s.Reserve(at(1), "req-1", map[string]int{"A": 4, "B": 3}, at(100))
	if !errors.Is(err, ErrInsufficientStock) {
		t.Fatalf("err = %v, want ErrInsufficientStock", err)
	}
	if got := s.Batch("A").Available; got != 5 {
		t.Fatalf("A available = %d, want 5 (no partial deduction)", got)
	}
	mustConserve(t, s)
}

// 过期时刻含截止：t == ExpireAt 已过期，t < ExpireAt 仍可确认。
func TestExpiryInstantIncludesDeadline(t *testing.T) {
	s := seeded(t, map[string]int{"A": 10})
	r, err := s.Reserve(at(1), "req-1", map[string]int{"A": 4}, at(50))
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if _, err := s.Confirm(at(49), "req-c1", r.ID); err != nil {
		t.Fatalf("confirm before deadline should succeed: %v", err)
	}

	r2, err := s.Reserve(at(2), "req-2", map[string]int{"A": 4}, at(50))
	if err != nil {
		t.Fatalf("reserve2: %v", err)
	}
	if _, err := s.Confirm(at(50), "req-c2", r2.ID); !errors.Is(err, ErrExpired) {
		t.Fatalf("confirm at deadline: err = %v, want ErrExpired", err)
	}
	if r2.State != Expired {
		t.Fatalf("r2 state = %s, want expired", r2.State)
	}
	if got := s.Batch("A").Available; got != 6 {
		t.Fatalf("A available = %d, want 6 after expiry release", got)
	}
	mustConserve(t, s)
}

// 确认须一次转移全批：跨批次预留确认后所有货位一次性转出。
func TestConfirmTransfersWholeBatchSetAtomically(t *testing.T) {
	s := seeded(t, map[string]int{"A": 5, "B": 5, "C": 5})
	r, err := s.Reserve(at(1), "req-1", map[string]int{"A": 2, "B": 3, "C": 4}, at(100))
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	if _, err := s.Confirm(at(2), "req-c", r.ID); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	for id, want := range map[string]int{"A": 2, "B": 3, "C": 4} {
		b := s.Batch(id)
		if b.Confirmed != want || b.Reserved != 0 {
			t.Fatalf("batch %s: confirmed=%d reserved=%d, want confirmed=%d reserved=0",
				id, b.Confirmed, b.Reserved, want)
		}
	}
	mustConserve(t, s)
}

// 到期、确认和撤销按事件序决胜：先发生的事件生效，后到的事件失败。
func TestEventOrderDecidesConflicts(t *testing.T) {
	// 撤销在前，确认在后 -> 确认失败。
	s := seeded(t, map[string]int{"A": 10})
	r, _ := s.Reserve(at(1), "req-1", map[string]int{"A": 4}, at(100))
	if _, err := s.Cancel(at(2), "req-x", r.ID); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := s.Confirm(at(3), "req-c", r.ID); !errors.Is(err, ErrNotActive) {
		t.Fatalf("confirm after cancel: err = %v, want ErrNotActive", err)
	}
	mustConserve(t, s)

	// 确认在前，撤销在后 -> 撤销失败。
	s2 := seeded(t, map[string]int{"A": 10})
	r2, _ := s2.Reserve(at(1), "req-1", map[string]int{"A": 4}, at(100))
	if _, err := s2.Confirm(at(2), "req-c", r2.ID); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if _, err := s2.Cancel(at(3), "req-x", r2.ID); !errors.Is(err, ErrNotActive) {
		t.Fatalf("cancel after confirm: err = %v, want ErrNotActive", err)
	}
	mustConserve(t, s2)

	// 到期事件在前，确认在后 -> 确认失败；事件序号严格递增。
	s3 := seeded(t, map[string]int{"A": 10})
	r3, _ := s3.Reserve(at(1), "req-1", map[string]int{"A": 4}, at(10))
	s3.ExpireDue(at(10))
	if _, err := s3.Confirm(at(11), "req-c", r3.ID); !errors.Is(err, ErrExpired) {
		t.Fatalf("confirm after expiry: err = %v, want ErrExpired", err)
	}
	log := s3.Log()
	for i := 1; i < len(log); i++ {
		if log[i].Seq != log[i-1].Seq+1 {
			t.Fatalf("event seq not strictly increasing: %+v", log)
		}
	}
	mustConserve(t, s3)
}

// 请求ID绑定参数：同参重试幂等返回原结果，异参冲突报错。
func TestRequestIDBinding(t *testing.T) {
	s := seeded(t, map[string]int{"A": 10})
	r1, err := s.Reserve(at(1), "req-1", map[string]int{"A": 4}, at(100))
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	// 同 ID 同参数：幂等，不重复扣减。
	r1b, err := s.Reserve(at(2), "req-1", map[string]int{"A": 4}, at(100))
	if err != nil || r1b.ID != r1.ID {
		t.Fatalf("idempotent retry: r=%+v err=%v", r1b, err)
	}
	if got := s.Batch("A").Available; got != 6 {
		t.Fatalf("A available = %d, want 6 (no double deduction)", got)
	}
	// 同 ID 异参数：冲突。
	if _, err := s.Reserve(at(3), "req-1", map[string]int{"A": 5}, at(100)); !errors.Is(err, ErrRequestConflict) {
		t.Fatalf("different params: err = %v, want ErrRequestConflict", err)
	}
	if _, err := s.Reserve(at(3), "req-1", map[string]int{"A": 4}, at(200)); !errors.Is(err, ErrRequestConflict) {
		t.Fatalf("different expiry: err = %v, want ErrRequestConflict", err)
	}
	// 确认操作同样幂等。
	if _, err := s.Confirm(at(4), "req-c", r1.ID); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	rc, err := s.Confirm(at(5), "req-c", r1.ID)
	if err != nil || rc.State != Confirmed {
		t.Fatalf("idempotent confirm retry: r=%+v err=%v", rc, err)
	}
	if n := countKind(s.Log(), EventConfirm); n != 1 {
		t.Fatalf("confirm events = %d, want 1", n)
	}
	mustConserve(t, s)
}

// 失败结果也绑定请求ID：相同参数重试得到相同错误。
func TestRequestIDBindingOnFailure(t *testing.T) {
	s := seeded(t, map[string]int{"A": 3})
	_, err1 := s.Reserve(at(1), "req-1", map[string]int{"A": 9}, at(100))
	_, err2 := s.Reserve(at(2), "req-1", map[string]int{"A": 9}, at(100))
	if !errors.Is(err1, ErrInsufficientStock) || !errors.Is(err2, ErrInsufficientStock) {
		t.Fatalf("err1=%v err2=%v, want both ErrInsufficientStock", err1, err2)
	}
	mustConserve(t, s)
}

// 重新领取有新代：过期/撤销后再次预留获得更大的代次。
func TestReacquireGetsNewGeneration(t *testing.T) {
	s := seeded(t, map[string]int{"A": 10})
	r1, _ := s.Reserve(at(1), "req-1", map[string]int{"A": 4}, at(10))
	s.ExpireDue(at(10))
	r2, err := s.Reserve(at(11), "req-2", map[string]int{"A": 4}, at(100))
	if err != nil {
		t.Fatalf("re-reserve: %v", err)
	}
	if r2.Generation <= r1.Generation {
		t.Fatalf("re-acquire generation %d, want > %d", r2.Generation, r1.Generation)
	}
	if _, err := s.Cancel(at(12), "req-x", r2.ID); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	r3, _ := s.Reserve(at(13), "req-3", map[string]int{"A": 4}, at(200))
	if r3.Generation <= r2.Generation {
		t.Fatalf("generation after cancel %d, want > %d", r3.Generation, r2.Generation)
	}
	mustConserve(t, s)
}

// 事件重放对照：重放日志得到相同状态，且每个事件后逐批守恒。
func TestReplayMatchesLiveAndConserves(t *testing.T) {
	s := seeded(t, map[string]int{"A": 8, "B": 6, "C": 4})
	r1, err := s.Reserve(at(1), "req-1", map[string]int{"A": 3, "B": 2}, at(50))
	if err != nil {
		t.Fatalf("reserve1: %v", err)
	}
	r2, err := s.Reserve(at(2), "req-2", map[string]int{"B": 2, "C": 4}, at(10))
	if err != nil {
		t.Fatalf("reserve2: %v", err)
	}
	if _, err := s.Confirm(at(3), "req-c1", r1.ID); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	s.ExpireDue(at(10)) // r2 到期
	r3, err := s.Reserve(at(11), "req-3", map[string]int{"A": 1, "C": 4}, at(100))
	if err != nil {
		t.Fatalf("reserve3: %v", err)
	}
	if _, err := s.Cancel(at(12), "req-x3", r3.ID); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	_ = r2
	mustConserve(t, s)

	replayed, err := Replay(s.Log())
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if live, again := s.Snapshot(), replayed.Snapshot(); live != again {
		t.Fatalf("replay mismatch:\nlive:\n%s\nreplayed:\n%s", live, again)
	}
	mustConserve(t, replayed)
}

// 篡改的日志（重复确认同一预留）在重放时必须被拒绝。
func TestReplayRejectsCorruptLog(t *testing.T) {
	s := seeded(t, map[string]int{"A": 5})
	r, _ := s.Reserve(at(1), "req-1", map[string]int{"A": 2}, at(100))
	if _, err := s.Confirm(at(2), "req-c", r.ID); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	log := s.Log()
	log = append(log, Event{Kind: EventConfirm, Time: at(3), ReservationID: r.ID})
	if _, err := Replay(log); !errors.Is(err, ErrLogCorrupt) {
		t.Fatalf("replay of corrupt log: err = %v, want ErrLogCorrupt", err)
	}
}

func countKind(log []Event, k Kind) int {
	n := 0
	for _, e := range log {
		if e.Kind == k {
			n++
		}
	}
	return n
}

func TestSnapshotStable(t *testing.T) {
	s := seeded(t, map[string]int{"A": 1})
	if !strings.Contains(s.Snapshot(), "batch A init=1") {
		t.Fatalf("snapshot missing batch line: %q", s.Snapshot())
	}
}
