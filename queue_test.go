package offlineq

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

var base = time.Unix(1_700_000_000, 0)

func openTemp(t *testing.T) (*Queue, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "events.log")
	q, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return q, path
}

func TestClaimIncrementsGeneration(t *testing.T) {
	q, _ := openTemp(t)
	defer q.Close()
	if err := q.Add("t1", base); err != nil {
		t.Fatal(err)
	}
	l1, err := q.Claim("t1", "alice", base, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if l1.Generation != 1 {
		t.Fatalf("first claim generation = %d, want 1", l1.Generation)
	}
	// 租约到期后重新领取，世代递增。
	l2, err := q.Claim("t1", "bob", base.Add(time.Second), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if l2.Generation != 2 {
		t.Fatalf("second claim generation = %d, want 2", l2.Generation)
	}
	// 未到期时他人不能领取。
	if _, err := q.Claim("t1", "carol", base.Add(time.Second+time.Millisecond), time.Second); !errors.Is(err, ErrTaskLeased) {
		t.Fatalf("claim while leased err = %v, want ErrTaskLeased", err)
	}
}

func TestOldAckRejectedAfterTimeoutReclaim(t *testing.T) {
	q, _ := openTemp(t)
	defer q.Close()
	if err := q.Add("t1", base); err != nil {
		t.Fatal(err)
	}
	l1, err := q.Claim("t1", "alice", base, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	// 超时后 bob 重新领取。
	l2, err := q.Claim("t1", "bob", base.Add(2*time.Second), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	// 旧世代 ACK 必须拒绝。
	if err := q.Ack("t1", "alice", l1.Generation, base.Add(2*time.Second+time.Millisecond)); err == nil {
		t.Fatal("stale ACK accepted, want rejection")
	}
	// 当前世代 ACK 接受。
	if err := q.Ack("t1", "bob", l2.Generation, base.Add(2*time.Second+time.Millisecond)); err != nil {
		t.Fatalf("current-generation ACK rejected: %v", err)
	}
}

func TestDeadlineBoundaryNowEqualsDeadline(t *testing.T) {
	q, _ := openTemp(t)
	defer q.Close()
	if err := q.Add("t1", base); err != nil {
		t.Fatal(err)
	}
	l, err := q.Claim("t1", "alice", base, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	deadline := base.Add(time.Second)
	if l.Deadline != deadline {
		t.Fatalf("deadline = %v, want %v", l.Deadline, deadline)
	}
	// now == deadline 即失效：ACK 拒绝。
	if err := q.Ack("t1", "alice", l.Generation, deadline); err == nil {
		t.Fatal("ACK at deadline accepted, want rejection")
	}
	// now == deadline 即失效：延长拒绝。
	if _, err := q.Extend("t1", "alice", l.Generation, deadline, time.Second); err == nil {
		t.Fatal("Extend at deadline accepted, want rejection")
	}
	// now == deadline 时他人可立即重新领取。
	if _, err := q.Claim("t1", "bob", deadline, time.Second); err != nil {
		t.Fatalf("claim at deadline rejected: %v", err)
	}
	// 恰好在 deadline 前一纳秒仍有效。
	if err := q.Ack("t1", "bob", 2, deadline.Add(time.Second).Add(-time.Nanosecond)); err != nil {
		t.Fatalf("ACK one ns before new deadline rejected: %v", err)
	}
}

func TestExtendOnlyAcceptsCurrentGeneration(t *testing.T) {
	q, _ := openTemp(t)
	defer q.Close()
	if err := q.Add("t1", base); err != nil {
		t.Fatal(err)
	}
	l1, err := q.Claim("t1", "alice", base, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	// 当前世代可延长，deadline 相应后移。
	nd, err := q.Extend("t1", "alice", l1.Generation, base.Add(500*time.Millisecond), 2*time.Second)
	if err != nil {
		t.Fatalf("Extend current generation: %v", err)
	}
	if want := base.Add(3 * time.Second); !nd.Equal(want) {
		t.Fatalf("new deadline = %v, want %v", nd, want)
	}
	// 到期重领后，旧世代延长拒绝。
	l2, err := q.Claim("t1", "bob", base.Add(3*time.Second), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.Extend("t1", "alice", l1.Generation, base.Add(3*time.Second+time.Millisecond), time.Second); err == nil {
		t.Fatal("Extend with stale generation accepted, want rejection")
	}
	// 新持有者的当前世代延长接受。
	if _, err := q.Extend("t1", "bob", l2.Generation, base.Add(3*time.Second+time.Millisecond), time.Second); err != nil {
		t.Fatalf("Extend with current generation rejected: %v", err)
	}
}

func TestPersistenceReplay(t *testing.T) {
	q, path := openTemp(t)
	if err := q.Add("t1", base); err != nil {
		t.Fatal(err)
	}
	if err := q.Add("t2", base); err != nil {
		t.Fatal(err)
	}
	l1, err := q.Claim("t1", "alice", base, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.Claim("t2", "alice", base, time.Second); err != nil {
		t.Fatal(err)
	}
	if err := q.Ack("t2", "alice", 1, base.Add(time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if err := q.Close(); err != nil {
		t.Fatal(err)
	}

	// 重新打开并重放事件日志。
	q2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer q2.Close()
	// 未到期租约仍然有效。
	holder, gen, ok := q2.CurrentHolder("t1", base.Add(time.Minute))
	if !ok || holder != "alice" || gen != l1.Generation {
		t.Fatalf("CurrentHolder after replay = (%q, %d, %v), want (alice, %d, true)", holder, gen, ok, l1.Generation)
	}
	// 世代在重启后继续递增，不复位。
	l2, err := q2.Claim("t1", "bob", base.Add(2*time.Hour), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if l2.Generation != l1.Generation+1 {
		t.Fatalf("generation after replay = %d, want %d", l2.Generation, l1.Generation+1)
	}
	// 已 ACK 任务不可再领取。
	if _, err := q2.Claim("t2", "bob", base.Add(2*time.Hour), time.Hour); !errors.Is(err, ErrTaskAcked) {
		t.Fatalf("claim acked task err = %v, want ErrTaskAcked", err)
	}
	// 事件历史完整重放（5 条历史 + 重开后 bob 的 1  次领取）。
	if n := len(q2.Events()); n != 6 {
		t.Fatalf("replayed %d events, want 6", n)
	}
}

func TestVerifySingleHolder(t *testing.T) {
	q, _ := openTemp(t)
	defer q.Close()
	if err := q.Add("t1", base); err != nil {
		t.Fatal(err)
	}
	if err := q.Add("t2", base); err != nil {
		t.Fatal(err)
	}
	// t1: alice 领取 -> 到期 -> bob 重领 -> 延长 -> ACK。
	if _, err := q.Claim("t1", "alice", base, time.Second); err != nil {
		t.Fatal(err)
	}
	l2, err := q.Claim("t1", "bob", base.Add(time.Second), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.Extend("t1", "bob", l2.Generation, base.Add(time.Second), time.Second); err != nil {
		t.Fatal(err)
	}
	if err := q.Ack("t1", "bob", l2.Generation, base.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	// t2: 并发尝试下仍只有 alice 持有。
	if _, err := q.Claim("t2", "alice", base, time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Claim("t2", "bob", base.Add(time.Minute), time.Hour); !errors.Is(err, ErrTaskLeased) {
		t.Fatalf("concurrent claim err = %v, want ErrTaskLeased", err)
	}
	if err := q.VerifySingleHolder(); err != nil {
		t.Fatalf("VerifySingleHolder: %v", err)
	}
	// 当前只有 t2 的 alice 一个持有者。
	if h, _, ok := q.CurrentHolder("t2", base.Add(time.Minute)); !ok || h != "alice" {
		t.Fatalf("CurrentHolder(t2) = (%q, %v), want (alice, true)", h, ok)
	}
	if _, _, ok := q.CurrentHolder("t1", base.Add(time.Minute)); ok {
		t.Fatal("t1 should have no current holder after ACK")
	}
}
