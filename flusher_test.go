package groupflush

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- 可控文件器 ----------

// event 记录文件器上发生的一次可观测动作。
type event struct {
	kind string // "write" 或 "sync"
	n    int    // write: 本次写入字节数；sync: 此刻累计已写字节数
}

// syncCall 代表一次被闸门拦下的 Sync，测试通过 release 决定其结果。
type syncCall struct {
	release chan error
}

// controlledFiler 是一个可控的 Filer：Write 立即成功并记录，
// Sync 阻塞直到测试放行（可注入错误）。
type controlledFiler struct {
	mu     sync.Mutex
	buf    []byte
	events []event
	syncs  chan *syncCall
	// writeErr 非 nil 时 Write 返回该错误（用于注入写失败）。
	writeErr error
}

func newControlledFiler() *controlledFiler {
	return &controlledFiler{syncs: make(chan *syncCall, 16)}
}

func (f *controlledFiler) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	f.buf = append(f.buf, p...)
	f.events = append(f.events, event{kind: "write", n: len(p)})
	return len(p), nil
}

func (f *controlledFiler) Sync() error {
	c := &syncCall{release: make(chan error, 1)}
	f.mu.Lock()
	f.events = append(f.events, event{kind: "sync", n: len(f.buf)})
	f.mu.Unlock()
	f.syncs <- c
	return <-c.release
}

// nextSync 等待下一次 Sync 到达闸门。
func (f *controlledFiler) nextSync(t *testing.T) *syncCall {
	t.Helper()
	select {
	case c := <-f.syncs:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("等待 Sync 超时")
		return nil
	}
}

// assertNoSync 断言闸门后没有新的 Sync。
func (f *controlledFiler) assertNoSync(t *testing.T) {
	t.Helper()
	select {
	case <-f.syncs:
		t.Fatal("出现了预期之外的 Sync")
	case <-time.After(50 * time.Millisecond):
	}
}

func (f *controlledFiler) snapshot() ([]event, []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ev := append([]event(nil), f.events...)
	buf := append([]byte(nil), f.buf...)
	return ev, buf
}

// ---------- 测试工具 ----------

// appendAsync 在后台调用 Append，返回结果通道。
func appendAsync(fl *Flusher, ctx context.Context, data string) chan error {
	ch := make(chan error, 1)
	go func() { ch <- fl.Append(ctx, []byte(data)) }()
	return ch
}

// waitPending 等待未封口批次里的请求数达到 n。
func waitPending(t *testing.T, fl *Flusher, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		fl.mu.Lock()
		got := len(fl.cur)
		fl.mu.Unlock()
		if got == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("等待未封口批次达到 %d 个请求超时，当前 %d", n, got)
		}
		time.Sleep(time.Millisecond)
	}
}

// mustBlock 断言 ch 在一小段时间内没有结果。
func mustBlock(t *testing.T, ch chan error, what string) {
	t.Helper()
	select {
	case err := <-ch:
		t.Fatalf("%s 不应提前返回，得到 %v", what, err)
	case <-time.After(50 * time.Millisecond):
	}
}

func mustOK(t *testing.T, ch chan error, what string) {
	t.Helper()
	select {
	case err := <-ch:
		if err != nil {
			t.Fatalf("%s 应为 nil，得到 %v", what, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("等待 %s 超时", what)
	}
}

func mustErr(t *testing.T, ch chan error, want error, what string) {
	t.Helper()
	select {
	case err := <-ch:
		if !errors.Is(err, want) {
			t.Fatalf("%s 应为 %v，得到 %v", what, want, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("等待 %s 超时", what)
	}
}

// ---------- 验收测试 ----------

// 多个并发调用共享一次 fsync：同批 N 个追加只产生一次 Sync。
func TestSharedFsyncBatchesCallers(t *testing.T) {
	f := newControlledFiler()
	fl := New(f)
	defer fl.Close()

	a := appendAsync(fl, context.Background(), "A")
	sync1 := f.nextSync(t) // 批次 1 = {A}，Sync 被闸门拦下

	// 闸门拦住期间，B/C/D 依次进入同一个未封口批次 2。
	b := appendAsync(fl, context.Background(), "B")
	waitPending(t, fl, 1)
	c := appendAsync(fl, context.Background(), "C")
	waitPending(t, fl, 2)
	d := appendAsync(fl, context.Background(), "D")
	waitPending(t, fl, 3)

	sync1.release <- nil
	mustOK(t, a, "A")
	// B/C/D 属于批次 2，尚未刷盘，不能返回。
	mustBlock(t, b, "B")
	mustBlock(t, c, "C")
	mustBlock(t, d, "D")

	sync2 := f.nextSync(t) // 批次 2 = {B,C,D}，共享这一次 Sync
	sync2.release <- nil
	mustOK(t, b, "B")
	mustOK(t, c, "C")
	mustOK(t, d, "D")

	f.assertNoSync(t) // 4 次追加总共恰好 2 次 Sync

	_, buf := f.snapshot()
	if got := string(buf); got != "ABCD" {
		t.Fatalf("落盘内容应为 ABCD，得到 %q", got)
	}
}

// 批次边界：批次在写入前封口，后来追加不能借旧 fsync 提前确认。
func TestLateAppendNotConfirmedByOldSync(t *testing.T) {
	f := newControlledFiler()
	fl := New(f)
	defer fl.Close()

	a := appendAsync(fl, context.Background(), "A")
	sync1 := f.nextSync(t)

	// 批次 1 已封口且 Sync 被拦住，D 只能进入批次 2。
	d := appendAsync(fl, context.Background(), "D")
	waitPending(t, fl, 1)

	sync1.release <- nil
	mustOK(t, a, "A")
	// 关键断言：旧批次的 fsync 已完成，但 D 不能被它确认。
	mustBlock(t, d, "D（借旧 fsync 提前确认）")

	sync2 := f.nextSync(t)
	sync2.release <- nil
	mustOK(t, d, "D")

	// 事件序列必须严格为：写A、sync、写D、sync ——
	// 即 D 的字节在第一次 Sync 之后才开始写入。
	events, _ := f.snapshot()
	var kinds []string
	for _, e := range events {
		kinds = append(kinds, fmt.Sprintf("%s(%d)", e.kind, e.n))
	}
	want := "write(1),sync(1),write(1),sync(2)"
	if got := strings.Join(kinds, ","); got != want {
		t.Fatalf("事件序列应为 %s，得到 %s", want, got)
	}
}

// 一次同步失败只影响该批及更早未确认者，新批次允许重试。
func TestSyncFailureOnlyFailsThatBatch(t *testing.T) {
	f := newControlledFiler()
	fl := New(f)
	defer fl.Close()

	errBoom := errors.New("磁盘抖动")

	a := appendAsync(fl, context.Background(), "A")
	sync1 := f.nextSync(t)

	// B、C 进入批次 2，与批次 1 的失败无关。
	b := appendAsync(fl, context.Background(), "B")
	waitPending(t, fl, 1)
	c := appendAsync(fl, context.Background(), "C")
	waitPending(t, fl, 2)

	// 批次 1 失败：只有 A 收到错误。
	sync1.release <- errBoom
	mustErr(t, a, errBoom, "A")
	mustBlock(t, b, "B")
	mustBlock(t, c, "C")

	// 批次 2 也失败：同批的 B、C 都收到同一个错误。
	sync2 := f.nextSync(t)
	sync2.release <- errBoom
	mustErr(t, b, errBoom, "B")
	mustErr(t, c, errBoom, "C")

	// 失败不传染：新批次照常重试并成功。
	d := appendAsync(fl, context.Background(), "D")
	sync3 := f.nextSync(t)
	sync3.release <- nil
	mustOK(t, d, "D（失败后的新批次）")
}

// 写入失败同样只影响当前批次。
func TestWriteFailureOnlyFailsThatBatch(t *testing.T) {
	f := newControlledFiler()
	fl := New(f)
	defer fl.Close()

	errBoom := errors.New("写失败")
	f.mu.Lock()
	f.writeErr = errBoom
	f.mu.Unlock()

	a := appendAsync(fl, context.Background(), "A")
	mustErr(t, a, errBoom, "A")
	f.assertNoSync(t) // 写失败不应再触发 Sync

	f.mu.Lock()
	f.writeErr = nil
	f.mu.Unlock()

	b := appendAsync(fl, context.Background(), "B")
	sync1 := f.nextSync(t)
	sync1.release <- nil
	mustOK(t, b, "B（写失败后的新批次）")
}

// 取消独立：取消一个调用方不影响同批其他人，也不取消共享的 fsync。
func TestCancellationIndependence(t *testing.T) {
	f := newControlledFiler()
	fl := New(f)
	defer fl.Close()

	a := appendAsync(fl, context.Background(), "A")
	sync1 := f.nextSync(t)

	ctxB, cancelB := context.WithCancel(context.Background())
	b := appendAsync(fl, ctxB, "B")
	waitPending(t, fl, 1)
	c := appendAsync(fl, context.Background(), "C")
	waitPending(t, fl, 2)

	// B 取消：自己拿到 context.Canceled，但批次照常推进。
	cancelB()
	mustErr(t, b, context.Canceled, "B")

	sync1.release <- nil
	mustOK(t, a, "A")

	// 共享的 fsync 没有因 B 取消而跳过：C 仍由批次 2 的 Sync 确认。
	sync2 := f.nextSync(t)
	sync2.release <- nil
	mustOK(t, c, "C（同批取消的幸存者）")

	// B 的数据仍随批次落盘（取消只影响返回值，不回滚写入）。
	_, buf := f.snapshot()
	if got := string(buf); got != "ABC" {
		t.Fatalf("落盘内容应为 ABC，得到 %q", got)
	}
}

// Close 会把在途批次刷完，之后拒绝新追加。
func TestCloseFlushesPending(t *testing.T) {
	f := newControlledFiler()
	fl := New(f)

	a := appendAsync(fl, context.Background(), "A")
	sync1 := f.nextSync(t)

	closed := make(chan error, 1)
	go func() { closed <- fl.Close() }()

	sync1.release <- nil
	mustOK(t, a, "A")
	mustOK(t, closed, "Close")

	if err := fl.Append(context.Background(), []byte("X")); !errors.Is(err, ErrClosed) {
		t.Fatalf("关闭后 Append 应返回 ErrClosed，得到 %v", err)
	}
	if err := fl.Close(); !errors.Is(err, ErrClosed) {
		t.Fatalf("重复 Close 应返回 ErrClosed，得到 %v", err)
	}
}
