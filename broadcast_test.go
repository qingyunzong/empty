package broadcast

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// recvN 从订阅接收恰好 n 条消息，超时即失败。
func recvN[T any](t *testing.T, s *Subscription[T], n int) []Message[T] {
	t.Helper()
	out := make([]Message[T], 0, n)
	for i := 0; i < n; i++ {
		select {
		case m, ok := <-s.C():
			if !ok {
				t.Fatalf("channel closed after %d messages, want %d", i, n)
			}
			out = append(out, m)
		case <-time.After(2 * time.Second):
			t.Fatalf("timeout waiting for message %d of %d", i+1, n)
		}
	}
	return out
}

// drain 读取直到通道关闭，返回全部消息。
func drain[T any](t *testing.T, s *Subscription[T]) []Message[T] {
	t.Helper()
	var out []Message[T]
	for {
		select {
		case m, ok := <-s.C():
			if !ok {
				return out
			}
			out = append(out, m)
		case <-time.After(2 * time.Second):
			t.Fatal("timeout waiting for channel close")
		}
	}
}

// wantSeqs 断言消息序号恰为 1..len(msgs) 的连续前缀。
func wantSeqs[T any](t *testing.T, msgs []Message[T]) {
	t.Helper()
	for i, m := range msgs {
		if m.Seq != uint64(i+1) {
			t.Fatalf("message %d has seq %d, want %d (prefix broken)", i, m.Seq, i+1)
		}
	}
}

// 满额时仅淘汰该订阅：被淘汰者对本批一条不收（无部分广播），
// 存活订阅整批收到；终止原因为 ErrSlowConsumer。

func TestEvictOnlyFullSubscriber(t *testing.T) {
	b := New[int](4)
	fast := b.Subscribe()
	slow := b.Subscribe()

	if err := b.Publish(1, 2); err != nil {
		t.Fatal(err)
	}
	recvN(t, fast, 2) // fast 取空缓冲；slow 一条不取，缓冲占 2/4

	if err := b.Publish(3, 4, 5); err != nil {
		t.Fatal(err)
	}

	// slow：只持有 [1,2]，批次 {3,4,5} 一条未投，随后被淘汰。
	got := drain(t, slow)
	wantSeqs(t, got)
	if len(got) != 2 {
		t.Fatalf("slow got %d messages, want 2 (partial batch leaked)", len(got))
	}
	if !errors.Is(slow.Err(), ErrSlowConsumer) {
		t.Fatalf("slow.Err() = %v, want ErrSlowConsumer", slow.Err())
	}

	// fast：整批收到，序号为 3,4,5（紧接此前的 1,2，连续）。
	got = recvN(t, fast, 3)
	for i, v := range []int{3, 4, 5} {
		if got[i].Seq != uint64(v) {
			t.Fatalf("fast message %d has seq %d, want %d", i, got[i].Seq, v)
		}
		if got[i].Value != v {
			t.Fatalf("fast message %d = %d, want %d", i, got[i].Value, v)
		}
	}

	// slow 已被移除，后续发布只投给 fast。
	if err := b.Publish(6); err != nil {
		t.Fatal(err)
	}
	b.Close()
	got = drain(t, fast)
	if len(got) != 1 || got[0].Seq != 6 || got[0].Value != 6 {
		t.Fatalf("fast tail = %+v, want [{Seq:6 Value:6}]", got)
	}
	if !errors.Is(fast.Err(), ErrClosed) {
		t.Fatalf("fast.Err() = %v, want ErrClosed", fast.Err())
	}
}

// 批长大于缓冲容量时所有订阅被淘汰，批次对任何人都不投递（全失败）。
func TestOversizedBatchEvictsAll(t *testing.T) {
	b := New[int](2)
	s1 := b.Subscribe()
	s2 := b.Subscribe()

	if err := b.Publish(1, 2, 3); err != nil {
		t.Fatal(err)
	}
	for i, s := range []*Subscription[int]{s1, s2} {
		if got := drain(t, s); len(got) != 0 {
			t.Fatalf("sub %d received %d messages from undeliverable batch", i, len(got))
		}
		if !errors.Is(s.Err(), ErrSlowConsumer) {
			t.Fatalf("sub %d Err() = %v, want ErrSlowConsumer", i, s.Err())
		}
	}
}

// 关闭后发布被拒绝（全失败），且不再有任何投递。
func TestPublishAfterClose(t *testing.T) {
	b := New[int](4)
	s := b.Subscribe()
	if err := b.Publish(1); err != nil {
		t.Fatal(err)
	}
	b.Close()
	b.Close() // 幂等

	if err := b.Publish(2, 3); !errors.Is(err, ErrClosed) {
		t.Fatalf("Publish after Close = %v, want ErrClosed", err)
	}
	got := drain(t, s)
	wantSeqs(t, got)
	if len(got) != 1 {
		t.Fatalf("got %d messages, want 1 (post-close publish leaked)", len(got))
	}

	// 关闭后再订阅：立即以 ErrClosed 终止。
	late := b.Subscribe()
	if got := drain(t, late); len(got) != 0 {
		t.Fatalf("late subscriber got %d messages, want 0", len(got))
	}
	if !errors.Is(late.Err(), ErrClosed) {
		t.Fatalf("late.Err() = %v, want ErrClosed", late.Err())
	}
}

// 关闭与发布并发交错：每个订阅收到的序号必须是 1..k 连续前缀，
// 且终止原因非空。
func TestContiguousPrefixUnderConcurrency(t *testing.T) {
	b := New[int](8)

	const numSubs = 16
	subs := make([]*Subscription[int], numSubs)
	for i := range subs {
		subs[i] = b.Subscribe()
	}

	var wg sync.WaitGroup

	// 一半订阅持续消费（快慢不一），另一半故意不消费以触发淘汰。
	for i := 0; i < numSubs/2; i++ {
		wg.Add(1)
		go func(s *Subscription[int], slow bool) {
			defer wg.Done()
			for range s.C() {
				if slow {
					time.Sleep(time.Millisecond)
				}
			}
		}(subs[i], i%4 == 0)
	}

	// 多个发布者并发发批，批长 1~3。
	const numPub = 8
	const batches = 100
	for p := 0; p < numPub; p++ {
		wg.Add(1)
		go func(p int) {
			defer wg.Done()
			for i := 0; i < batches; i++ {
				batch := make([]int, 1+i%3)
				for j := range batch {
					batch[j] = p*1000 + i
				}
				if err := b.Publish(batch...); err != nil && !errors.Is(err, ErrClosed) {
					t.Errorf("unexpected publish error: %v", err)
					return
				}
			}
		}(p)
	}

	// 发布中途关闭广播器，制造关闭与发布的交错。
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(5 * time.Millisecond)
		b.Close()
	}()

	wg.Wait()
	b.Close() // 若上面的 goroutine 尚未触发，这里兜底

	for i, s := range subs {
		got := drain(t, s)
		wantSeqs(t, got)
		if err := s.Err(); err == nil {
			t.Fatalf("sub %d: terminated with nil reason", i)
		} else if !errors.Is(err, ErrClosed) && !errors.Is(err, ErrSlowConsumer) {
			t.Fatalf("sub %d: unexpected reason %v", i, err)
		}
	}
}

// 主动退订：通道关闭、不再接收，后续发布不受影响。
func TestUnsubscribe(t *testing.T) {
	b := New[int](2)
	s1 := b.Subscribe()
	s2 := b.Subscribe()

	s1.Unsubscribe()
	if got := drain(t, s1); len(got) != 0 {
		t.Fatalf("unsubscribed got %d messages, want 0", len(got))
	}
	if s1.Err() != nil {
		t.Fatalf("unsubscribed Err() = %v, want nil", s1.Err())
	}

	if err := b.Publish(1); err != nil {
		t.Fatal(err)
	}
	b.Close()
	got := drain(t, s2)
	wantSeqs(t, got)
	if len(got) != 1 {
		t.Fatalf("s2 got %d messages, want 1", len(got))
	}
}

// 序号全局单调递增，跨批次连续。
func TestSeqMonotonicAcrossBatches(t *testing.T) {
	b := New[string](16)
	s := b.Subscribe()
	for i := 0; i < 5; i++ {
		if err := b.Publish(fmt.Sprintf("batch-%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	b.Close()
	got := drain(t, s)
	wantSeqs(t, got)
	if len(got) != 5 {
		t.Fatalf("got %d messages, want 5", len(got))
	}
}
