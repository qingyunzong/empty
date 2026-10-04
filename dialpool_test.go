package dialpool

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// outcome 可控拨号器支持的结果枚举。
type outcome int

const (
	outcomeSuccess outcome = iota // 成功：立即交付新连接
	outcomeTimeout                // 超时：拨号悬置，由测试稍后手动了结（迟到）
	outcomeClosed                 // 关闭：拨号失败，返回错误
)

// fakeConn 记录关闭次数，用于核对销毁语义与唯一交付。
type fakeConn struct {
	id     int
	closes int32
}

func (f *fakeConn) Close() error { atomic.AddInt32(&f.closes, 1); return nil }

func (f *fakeConn) closeCount() int { return int(atomic.LoadInt32(&f.closes)) }

// dialCall 代表一次进行中的拨号，测试通过 resolve 了结它。
type dialCall struct {
	result chan dialResult
}

// controlledDialer 让测试完全控制每次拨号的时机与结果。
type controlledDialer struct {
	calls   chan *dialCall
	nextID  int32
	dialed  int32
	mu      sync.Mutex
	created []*fakeConn
}

func newControlledDialer() *controlledDialer {
	return &controlledDialer{calls: make(chan *dialCall, 128)}
}

func (d *controlledDialer) dial(ctx context.Context) (io.Closer, error) {
	c := &dialCall{result: make(chan dialResult, 1)}
	atomic.AddInt32(&d.dialed, 1)
	d.calls <- c
	res := <-c.result
	return res.conn, res.err
}

func (d *controlledDialer) dialCount() int { return int(atomic.LoadInt32(&d.dialed)) }

// newConn 登记一个新连接，便于最终核对“创建即销毁或交付一次”。
func (d *controlledDialer) newConn() *fakeConn {
	id := int(atomic.AddInt32(&d.nextID, 1))
	c := &fakeConn{id: id}
	d.mu.Lock()
	d.created = append(d.created, c)
	d.mu.Unlock()
	return c
}

// resolve 按给定结果了结一次拨号；outcomeTimeout 时由测试随后调用
// resolveLate 手动了结，模拟“迟到”的连接。
func (d *controlledDialer) resolve(c *dialCall, o outcome) {
	switch o {
	case outcomeSuccess:
		c.result <- dialResult{conn: d.newConn()}
	case outcomeClosed:
		c.result <- dialResult{err: errors.New("dialer closed")}
	default:
		panic("resolve: use resolveLate for outcomeTimeout")
	}
}

func (d *controlledDialer) resolveLate(c *dialCall) {
	c.result <- dialResult{conn: d.newConn()}
}

// waitDial 等待一次拨号开始。
func (d *controlledDialer) waitDial(t *testing.T) *dialCall {
	t.Helper()
	select {
	case c := <-d.calls:
		return c
	case <-time.After(2 * time.Second):
		t.Fatal("expected a dial to start")
		return nil
	}
}

// expectNoDial 断言短时间内没有新拨号发生（容量核对）。
func (d *controlledDialer) expectNoDial(t *testing.T) {
	t.Helper()
	select {
	case <-d.calls:
		t.Fatal("unexpected dial: capacity not enforced")
	case <-time.After(100 * time.Millisecond):
	}
}

func eventually(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(msg)
}

// TestDialOutcomes 枚举可控拨号器的三种结果：成功、超时（迟到）、关闭。
func TestDialOutcomes(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		d := newControlledDialer()
		p := New(1, d.dial)
		defer p.Close()
		res := make(chan io.Closer, 1)
		go func() {
			c, err := p.Get(context.Background())
			if err != nil {
				t.Errorf("Get: %v", err)
			}
			res <- c
		}()
		d.resolve(d.waitDial(t), outcomeSuccess)
		if c := <-res; c == nil {
			t.Fatal("expected a connection")
		}
	})

	t.Run("timeout", func(t *testing.T) {
		d := newControlledDialer()
		p := New(1, d.dial)
		defer p.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		done := make(chan error, 1)
		go func() {
			_, err := p.Get(ctx)
			done <- err
		}()
		call := d.waitDial(t)
		if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("expected deadline exceeded, got %v", err)
		}
		// 迟到连接必须归池，而不是交给过期票据。
		d.resolveLate(call)
		eventually(t, func() bool {
			_, idle, _ := p.Stats()
			return idle == 1
		}, "late conn should be recycled to idle")
		c, err := p.Get(context.Background())
		if err != nil {
			t.Fatalf("Get recycled conn: %v", err)
		}
		if d.dialCount() != 1 {
			t.Fatalf("expected conn reuse without new dial, dialed %d", d.dialCount())
		}
		p.Put(c)
	})

	t.Run("closed", func(t *testing.T) {
		d := newControlledDialer()
		p := New(1, d.dial)
		defer p.Close()
		done := make(chan error, 1)
		go func() {
			_, err := p.Get(context.Background())
			done <- err
		}()
		d.resolve(d.waitDial(t), outcomeClosed)
		if err := <-done; err == nil || errors.Is(err, ErrClosed) {
			t.Fatalf("expected dial error, got %v", err)
		}
		eventually(t, func() bool {
			open, _, _ := p.Stats()
			return open == 0
		}, "failed dial must release its reserved slot")
	})
}

// TestLateConnDestroyedAfterClose 池关闭后，迟到结果一律销毁。
func TestLateConnDestroyedAfterClose(t *testing.T) {
	d := newControlledDialer()
	p := New(1, d.dial)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := p.Get(ctx)
		done <- err
	}()
	call := d.waitDial(t)
	if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", err)
	}
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	d.resolveLate(call)
	eventually(t, func() bool {
		d.mu.Lock()
		defer d.mu.Unlock()
		return len(d.created) == 1 && d.created[0].closeCount() == 1
	}, "late conn must be destroyed after close")
	eventually(t, func() bool {
		open, _, _ := p.Stats()
		return open == 0
	}, "slot must be released")
	if _, err := p.Get(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("Get after close: expected ErrClosed, got %v", err)
	}
}

// TestCapacityEnforced 容量满时不允许多余拨号，等待者超时退出。
func TestCapacityEnforced(t *testing.T) {
	d := newControlledDialer()
	p := New(2, d.dial)
	defer p.Close()

	got := make(chan io.Closer, 2)
	for i := 0; i < 2; i++ {
		go func() {
			c, err := p.Get(context.Background())
			if err != nil {
				t.Errorf("Get: %v", err)
				return
			}
			got <- c
		}()
	}
	calls := []*dialCall{d.waitDial(t), d.waitDial(t)}

	// 容量已满：第三个 Get 只能等待，不得触发新拨号。
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := p.Get(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected waiter timeout at full capacity, got %v", err)
	}
	d.expectNoDial(t)
	if n := d.dialCount(); n != 2 {
		t.Fatalf("expected 2 dials at capacity, got %d", n)
	}

	for _, c := range calls {
		d.resolve(c, outcomeSuccess)
	}
	for i := 0; i < 2; i++ {
		if c := <-got; c == nil {
			t.Fatal("expected connection")
		}
	}
}

// TestUniqueDelivery 同一连接只交付给一个等待者。
func TestUniqueDelivery(t *testing.T) {
	d := newControlledDialer()
	p := New(1, d.dial)
	defer p.Close()

	first := make(chan io.Closer, 1)
	go func() {
		c, err := p.Get(context.Background())
		if err != nil {
			t.Errorf("Get: %v", err)
			return
		}
		first <- c
	}()
	d.resolve(d.waitDial(t), outcomeSuccess)
	c := <-first

	const waiters = 4
	results := make(chan io.Closer, waiters)
	for i := 0; i < waiters; i++ {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			defer cancel()
			if c, err := p.Get(ctx); err == nil {
				results <- c
			}
		}()
	}
	eventually(t, func() bool {
		_, _, w := p.Stats()
		return w == waiters
	}, "waiters should be queued")

	p.Put(c) // 只能唤醒一个等待者
	select {
	case got := <-results:
		if got != c {
			t.Fatal("delivered conn differs from the one Put")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected exactly one waiter to receive the conn")
	}
	select {
	case extra := <-results:
		t.Fatalf("conn delivered twice: %v", extra)
	case <-time.After(400 * time.Millisecond):
	}
}

// TestConcurrentStress 并发压力 + 竞态：核对容量上限、唯一交付、
// 以及每个创建的连接最终恰好销毁一次。
func TestConcurrentStress(t *testing.T) {
	d := newControlledDialer()
	const capacity = 4
	p := New(capacity, d.dial)

	// 拨号结果仲裁：随机延迟后成功或失败，制造大量“迟到”。
	stop := make(chan struct{})
	var resolver sync.WaitGroup
	resolver.Add(1)
	go func() {
		defer resolver.Done()
		for {
			select {
			case call := <-d.calls:
				time.Sleep(time.Duration(time.Now().UnixNano()%3) * time.Millisecond)
				if time.Now().UnixNano()%5 == 0 {
					call.result <- dialResult{err: errors.New("boom")}
				} else {
					call.result <- dialResult{conn: d.newConn()}
				}
			case <-stop:
				return
			}
		}
	}()

	// inUse 核对唯一交付：同一连接同一时刻至多一个持有者。
	var inUse sync.Map // conn id -> bool
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				ctx, cancel := context.WithTimeout(context.Background(),
					time.Duration(1+(i+j)%7)*time.Millisecond)
				c, err := p.Get(ctx)
				cancel()
				if err != nil {
					continue
				}
				fc := c.(*fakeConn)
				if _, loaded := inUse.LoadOrStore(fc.id, true); loaded {
					t.Errorf("conn %d delivered to two holders at once", fc.id)
				}
				time.Sleep(time.Duration(j%3) * time.Millisecond)
				inUse.Delete(fc.id)
				p.Put(c)
			}
		}(i)
	}
	wg.Wait()
	close(stop)
	resolver.Wait()
	p.Close()

	open, _, _ := p.Stats()
	if open > capacity {
		t.Fatalf("open slots %d exceed capacity %d", open, capacity)
	}
	// 所有已创建连接：要么被销毁恰好一次，要么正被借出（此处已全部归还）。
	eventually(t, func() bool {
		d.mu.Lock()
		defer d.mu.Unlock()
		for _, c := range d.created {
			if c.closeCount() != 1 {
				return false
			}
		}
		return true
	}, "every created conn must be closed exactly once after Close")
}
