package resub

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

func testOpts() *Options { return &Options{RetryDelay: time.Millisecond} }

// recorder collects callback deliveries for assertions.
type recorder struct {
	mu    sync.Mutex
	calls []Event
}

func (r *recorder) callback(fail func(ev Event) bool) Callback {
	return func(ctx context.Context, ev Event) error {
		r.mu.Lock()
		r.calls = append(r.calls, ev)
		r.mu.Unlock()
		if fail != nil && fail(ev) {
			return errors.New("transient callback failure")
		}
		return nil
	}
}

func (r *recorder) forSeq(seq uint64) []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []Event
	for _, ev := range r.calls {
		if ev.Seq == seq {
			out = append(out, ev)
		}
	}
	return out
}

func assertLedger(t *testing.T, l *Ledger, n int) {
	t.Helper()
	if err := l.Verify(1); err != nil {
		t.Fatalf("ledger broken: %v", err)
	}
	entries := l.Entries()
	if len(entries) != n {
		t.Fatalf("ledger has %d entries, want %d", len(entries), n)
	}
	seen := map[string]bool{}
	for i, a := range entries {
		if a.Seq != uint64(i+1) {
			t.Fatalf("entry %d has seq %d, want %d", i, a.Seq, i+1)
		}
		if seen[a.ID] {
			t.Fatalf("result ID %s confirmed twice", a.ID)
		}
		seen[a.ID] = true
	}
}

func connectFroms(tr *ScriptedTransport) []uint64 {
	var out []uint64
	for _, c := range tr.Connects() {
		out = append(out, c.From)
	}
	return out
}

// 断线后从最后确认序号重连：周期性断线，恢复点必须等于已确认水位，确认账连续。
func TestReconnectResumesFromLastConfirmed(t *testing.T) {
	tr := NewScriptedTransport(Events(10))
	tr.DropEvery = 3 // 每条连接交付 3 个事件后断开
	sub := NewSubscriber(tr, func(context.Context, Event) error { return nil }, testOpts())

	if err := sub.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	assertLedger(t, sub.Ledger(), 10)

	want := []uint64{0, 3, 6, 9}
	got := connectFroms(tr)
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("resume points = %v, want %v", got, want)
	}
	// 确认账按代际分组：1-3 属 gen1，4-6 属 gen2，7-9 属 gen3，10 属 gen4。
	for i, a := range sub.Ledger().Entries() {
		wantGen := uint64(i/3 + 1)
		if a.Gen != wantGen {
			t.Fatalf("entry %d confirmed in gen %d, want gen %d", i, a.Gen, wantGen)
		}
	}
	t.Logf("confirmation ledger: %s", sub.Ledger())
}

// 回调失败不推进确认，事件以稳定的结果 ID 重复投递，确认账只记一次。
func TestCallbackFailureRedeliversWithStableID(t *testing.T) {
	tr := NewScriptedTransport(Events(5))
	rec := &recorder{}
	failed := false
	cb := rec.callback(func(ev Event) bool {
		if ev.Seq == 3 && !failed {
			failed = true
			return true
		}
		return false
	})
	sub := NewSubscriber(tr, cb, testOpts())

	if err := sub.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	assertLedger(t, sub.Ledger(), 5)

	// 事件 3 被投递两次，两次结果 ID 相同。
	d := rec.forSeq(3)
	if len(d) != 2 {
		t.Fatalf("seq 3 delivered %d times, want 2", len(d))
	}
	if d[0].ID != d[1].ID {
		t.Fatalf("redelivery changed result ID: %q then %q", d[0].ID, d[1].ID)
	}
	// 失败未推进确认：第二次连接从 2（最后确认序号）恢复。
	want := []uint64{0, 2}
	if got := connectFroms(tr); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("resume points = %v, want %v", got, want)
	}
	t.Logf("confirmation ledger: %s", sub.Ledger())
}

// 断线发生在交付与确认之间：事件未确认即断线，重连后按原序号、原 ID 重投，确认账不跳号。
func TestDisconnectBetweenDeliveryAndConfirmation(t *testing.T) {
	tr := NewScriptedTransport(Events(8))
	rec := &recorder{}
	dropped := map[uint64]bool{}
	opts := testOpts()
	// 在回调成功之后、写入确认账之前断开连接。
	opts.PreConfirm = func(ev Event) {
		if (ev.Seq == 2 || ev.Seq == 5) && !dropped[ev.Seq] {
			dropped[ev.Seq] = true
			tr.DropCurrent()
		}
	}
	sub := NewSubscriber(tr, rec.callback(nil), opts)

	if err := sub.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	assertLedger(t, sub.Ledger(), 8)

	// 断线点的事件各被投递两次，ID 稳定；其余事件只投递一次。
	for seq := uint64(1); seq <= 8; seq++ {
		d := rec.forSeq(seq)
		want := 1
		if seq == 2 || seq == 5 {
			want = 2
		}
		if len(d) != want {
			t.Fatalf("seq %d delivered %d times, want %d", seq, len(d), want)
		}
		for i := 1; i < len(d); i++ {
			if d[i].ID != d[0].ID {
				t.Fatalf("seq %d redelivery changed ID: %q then %q", seq, d[0].ID, d[i].ID)
			}
		}
	}
	// 断线后从最后确认序号恢复：seq2 断线 → 从 1 恢复；seq5 断线 → 从 4 恢复。
	want := []uint64{0, 1, 4}
	if got := connectFroms(tr); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("resume points = %v, want %v", got, want)
	}
	t.Logf("confirmation ledger: %s", sub.Ledger())
}

// 新代际取消旧连接：旧连接被围栏（fenced），Recv 报过期代际，代际号严格递增。
func TestNewGenerationCancelsOldConnection(t *testing.T) {
	tr := NewScriptedTransport(Events(6))
	tr.DropEvery = 2
	sub := NewSubscriber(tr, func(context.Context, Event) error { return nil }, testOpts())

	if err := sub.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	assertLedger(t, sub.Ledger(), 6)

	conns := tr.Conns()
	if len(conns) != 4 {
		t.Fatalf("opened %d connections, want 4", len(conns))
	}
	var prevGen uint64
	for i, c := range conns {
		if c.Gen() <= prevGen {
			t.Fatalf("generations not strictly increasing at conn %d: %d after %d", i, c.Gen(), prevGen)
		}
		prevGen = c.Gen()
		if c.Alive() {
			t.Fatalf("conn %d (gen %d) still alive after run", i, c.Gen())
		}
	}
	// 被取代的旧连接：Recv 必须报过期代际错误。
	if _, err := conns[0].Recv(context.Background()); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale conn Recv = %v, want ErrStaleGeneration", err)
	}
	if got := sub.Generation(); got != 4 {
		t.Fatalf("subscriber generation = %d, want 4", got)
	}
	t.Logf("confirmation ledger: %s", sub.Ledger())
}

// staticTransport 按脚本原样投递（不重排、不去重），用于构造异常服务器行为。
type staticTransport struct{ events []Event }

func (s *staticTransport) Connect(context.Context, uint64, uint64) (Conn, error) {
	return &staticConn{events: s.events}, nil
}

type staticConn struct {
	events []Event
	pos    int
}

func (c *staticConn) Recv(context.Context) (Event, error) {
	if c.pos >= len(c.events) {
		return Event{}, io.EOF
	}
	ev := c.events[c.pos]
	c.pos++
	return ev, nil
}

func (c *staticConn) Close() error { return nil }

// 已确认事件的重复投递被幂等跳过：不重复回调、不重复确认。
func TestDuplicateDeliveryNotConfirmedTwice(t *testing.T) {
	tr := &staticTransport{events: []Event{
		{Seq: 1, ID: "r-001"},
		{Seq: 1, ID: "r-001"}, // 服务器重投已确认事件
		{Seq: 2, ID: "r-002"},
	}}
	rec := &recorder{}
	sub := NewSubscriber(tr, rec.callback(nil), testOpts())

	if err := sub.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	assertLedger(t, sub.Ledger(), 2)
	if got := len(rec.calls); got != 2 {
		t.Fatalf("callback invoked %d times, want 2 (duplicate must be skipped)", got)
	}
}

// 服务器跳号属于协议违规：Run 返回错误，确认账停在缺口前。
func TestSequenceGapIsFatal(t *testing.T) {
	tr := &staticTransport{events: []Event{
		{Seq: 1, ID: "r-001"},
		{Seq: 3, ID: "r-003"},
	}}
	sub := NewSubscriber(tr, func(context.Context, Event) error { return nil }, testOpts())

	err := sub.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "gap") {
		t.Fatalf("Run = %v, want sequence gap error", err)
	}
	if got := sub.Ledger().Last(); got != 1 {
		t.Fatalf("ledger last = %d, want 1 (must stop before the gap)", got)
	}
}

// 上下文取消时 Run 退出。
func TestContextCancellationStopsRun(t *testing.T) {
	tr := NewScriptedTransport(Events(3))
	sub := NewSubscriber(tr, func(context.Context, Event) error { return nil }, testOpts())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := sub.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run = %v, want context.Canceled", err)
	}
}

// 确认账校验器能发现跳号与重复。
func TestLedgerVerifyDetectsBrokenChains(t *testing.T) {
	l := &Ledger{}
	l.append(Ack{Seq: 1, ID: "r-001"})
	l.append(Ack{Seq: 3, ID: "r-003"})
	if err := l.Verify(1); err == nil {
		t.Fatal("Verify accepted a ledger with a gap")
	}

	l2 := &Ledger{}
	l2.append(Ack{Seq: 1, ID: "r-001"})
	l2.append(Ack{Seq: 1, ID: "r-001"})
	if err := l2.Verify(1); err == nil {
		t.Fatal("Verify accepted a ledger with a duplicate")
	}

	l3 := &Ledger{}
	for i := 1; i <= 5; i++ {
		l3.append(Ack{Seq: uint64(i), ID: fmt.Sprintf("r-%03d", i)})
	}
	if err := l3.Verify(1); err != nil {
		t.Fatalf("Verify rejected a contiguous ledger: %v", err)
	}
}
