package q150

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeStream 是可控的内存正文流，可阻塞读取并记录关闭行为。
type fakeStream struct {
	mu     sync.Mutex
	data   []byte
	closed bool
	readCh chan struct{} // 非 nil 时，Read 在数据耗尽后阻塞直到关闭
}

func newFakeStream(s string) *fakeStream {
	return &fakeStream{data: []byte(s)}
}

func (f *fakeStream) Read(p []byte) (int, error) {
	f.mu.Lock()
	if len(f.data) == 0 && f.readCh != nil && !f.closed {
		ch := f.readCh
		f.mu.Unlock()
		<-ch // 模拟服务端保持连接、读取阻塞
		f.mu.Lock()
	}
	defer f.mu.Unlock()
	if f.closed {
		return 0, io.ErrClosedPipe
	}
	if len(f.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, f.data)
	f.data = f.data[n:]
	return n, nil
}

func (f *fakeStream) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		if f.readCh != nil {
			close(f.readCh)
			f.readCh = nil
		}
	}
	return nil
}

func (f *fakeStream) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

// byteStream 每次 Read 最多返回一个字节，数据耗尽后阻塞直到关闭，
// 用于模拟极端切块边界。
type byteStream struct {
	mu     sync.Mutex
	data   []byte
	closed bool
	ch     chan struct{}
}

func newBlockingByteStream(s string) *byteStream {
	return &byteStream{data: []byte(s), ch: make(chan struct{})}
}

func (b *byteStream) Read(p []byte) (int, error) {
	b.mu.Lock()
	if len(b.data) == 0 && !b.closed {
		ch := b.ch
		b.mu.Unlock()
		<-ch
		b.mu.Lock()
	}
	defer b.mu.Unlock()
	if b.closed {
		return 0, io.ErrClosedPipe
	}
	if len(b.data) == 0 {
		return 0, io.EOF
	}
	p[0] = b.data[0]
	b.data = b.data[1:]
	return 1, nil
}

func (b *byteStream) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.closed {
		b.closed = true
		close(b.ch)
	}
	return nil
}

func (b *byteStream) isClosed() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.closed
}

// failingStore 在 fail 为 true 时令 Save 失败，并记录调用参数。
type failingStore struct {
	mu   sync.Mutex
	id   string
	ok   bool
	fail bool
}

func (s *failingStore) Load(_ context.Context) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.id, s.ok, nil
}

func (s *failingStore) Save(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("persistence unavailable")
	}
	s.id = id
	s.ok = id != ""
	return nil
}

func (s *failingStore) snapshot() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.id, s.ok
}

// dialScript 记录每次拨号的恢复 ID，并依次返回脚本中的流或错误。
type dialScript struct {
	mu      sync.Mutex
	gotIDs  []string
	streams []*fakeStream
	errs    []error
	calls   int
}

func (d *dialScript) dial(_ context.Context, lastEventID string) (Stream, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.gotIDs = append(d.gotIDs, lastEventID)
	idx := d.calls
	d.calls++
	if idx < len(d.errs) && d.errs[idx] != nil {
		return nil, d.errs[idx]
	}
	if idx >= len(d.streams) {
		return nil, errors.New("dial script exhausted")
	}
	return d.streams[idx], nil
}

func (d *dialScript) dialedIDs() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]string, len(d.gotIDs))
	copy(out, d.gotIDs)
	return out
}

func newTestSubscriber(t *testing.T, cfg Config) *Subscriber {
	t.Helper()
	if cfg.DefaultRetry == 0 {
		cfg.DefaultRetry = 50 * time.Millisecond
	}
	sub, err := NewSubscriber(cfg)
	if err != nil {
		t.Fatalf("NewSubscriber: %v", err)
	}
	return sub
}

func runInGoroutine(sub *Subscriber) <-chan error {
	done := make(chan error, 1)
	go func() { done <- sub.Run(context.Background()) }()
	return done
}

func waitUntil(t *testing.T, cond func() bool, timeout time.Duration, msg string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timeout: %s", msg)
}

// TestAckPersistenceFailure 验证持久化失败时事件保持待确认、不会被跳过。
func TestAckPersistenceFailure(t *testing.T) {
	store := &failingStore{fail: true}
	stream := newFakeStream("id: e1\ndata: alpha\n\n")
	dial := &dialScript{streams: []*fakeStream{stream}}
	sub := newTestSubscriber(t, Config{Store: store, Dial: dial.dial})
	runDone := runInGoroutine(sub)

	event, err := sub.Next(context.Background())
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	if event.Data != "alpha" || event.LastEventID != "e1" {
		t.Fatalf("unexpected event: %+v", event)
	}

	if err := sub.Ack(context.Background()); err == nil {
		t.Fatal("Ack should fail when persistence fails")
	}
	if id, ok := store.snapshot(); ok || id != "" {
		t.Fatalf("store must not change on failed Ack, got id=%q ok=%v", id, ok)
	}

	store.mu.Lock()
	store.fail = false
	store.mu.Unlock()
	if err := sub.Ack(context.Background()); err != nil {
		t.Fatalf("retry Ack: %v", err)
	}
	if id, ok := store.snapshot(); id != "e1" || !ok {
		t.Fatalf("store = %q,%v want e1,true", id, ok)
	}

	sub.Close()
	select {
	case err := <-runDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop after Close")
	}
	if !stream.isClosed() {
		t.Fatal("body stream not closed on shutdown")
	}
}

// TestReconnectUsesConfirmedIDAndRetry 验证断线重连携带已确认 ID，
// 沿用服务端 retry 建议，且未确认事件不会被跳过。
func TestReconnectUsesConfirmedIDAndRetry(t *testing.T) {
	store := &failingStore{}
	first := newFakeStream("retry: 77\nid: e1\ndata: one\n\nid: e2\ndata: two\n\n")
	second := newFakeStream("data: three\n\n")
	second.readCh = make(chan struct{})
	dial := &dialScript{streams: []*fakeStream{first, second}}

	var waits []time.Duration
	var waitMu sync.Mutex
	sub := newTestSubscriber(t, Config{
		Store: store,
		Dial:  dial.dial,
		onWait: func(d time.Duration) {
			waitMu.Lock()
			waits = append(waits, d)
			waitMu.Unlock()
		},
	})
	runDone := runInGoroutine(sub)

	if ev, err := sub.Next(context.Background()); err != nil || ev.Data != "one" {
		t.Fatalf("event one: %+v %v", ev, err)
	}
	if err := sub.Ack(context.Background()); err != nil {
		t.Fatalf("Ack one: %v", err)
	}

	evTwo, err := sub.Next(context.Background())
	if err != nil || evTwo.Data != "two" {
		t.Fatalf("event two: %+v %v", evTwo, err)
	}

	// 事件二确认前泵停在 ack 等待上，首连接即使 EOF 也不会被跳过；
	// 确认后才处理断线并按已确认 ID 重连。
	if err := sub.Ack(context.Background()); err != nil {
		t.Fatalf("Ack two: %v", err)
	}
	if id, _ := store.snapshot(); id != "e2" {
		t.Fatalf("store id = %q, want e2", id)
	}

	waitUntil(t, func() bool { return len(dial.dialedIDs()) >= 2 },
		2*time.Second, "reconnect did not happen")
	ids := dial.dialedIDs()
	if ids[0] != "" {
		t.Fatalf("initial dial id = %q, want empty", ids[0])
	}
	if ids[1] != "e2" {
		t.Fatalf("reconnect id = %q, want e2 (latest confirmed)", ids[1])
	}
	waitMu.Lock()
	lastWait := time.Duration(-1)
	if len(waits) > 0 {
		lastWait = waits[len(waits)-1]
	}
	waitMu.Unlock()
	if lastWait != 77*time.Millisecond {
		t.Fatalf("last reconnect wait = %v, want 77ms (server retry retained)", lastWait)
	}

	evThree, err := sub.Next(context.Background())
	if err != nil || evThree.Data != "three" {
		t.Fatalf("event three: %+v %v", evThree, err)
	}

	sub.Close()
	select {
	case <-runDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop")
	}
	if !first.isClosed() || !second.isClosed() {
		t.Fatalf("both streams must close: first=%v second=%v",
			first.isClosed(), second.isClosed())
	}
}

// TestCancelWhileReadBlocks 验证读取阻塞时取消能关闭正文流并停止，
// 且未确认事件不落盘。
func TestCancelWhileReadBlocks(t *testing.T) {
	store := &failingStore{}
	stream := newFakeStream("data: only\n\n")
	stream.readCh = make(chan struct{})
	dial := &dialScript{streams: []*fakeStream{stream}}
	sub := newTestSubscriber(t, Config{Store: store, Dial: dial.dial})
	runDone := runInGoroutine(sub)

	ev, err := sub.Next(context.Background())
	if err != nil || ev.Data != "only" {
		t.Fatalf("event: %+v %v", ev, err)
	}

	sub.Close()
	select {
	case err := <-runDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop on cancel during blocked read")
	}
	if !stream.isClosed() {
		t.Fatal("blocked body stream not closed on cancel")
	}
	if id, ok := store.snapshot(); ok || id != "" {
		t.Fatalf("unconfirmed event persisted: %q,%v", id, ok)
	}
}

// TestCancelDuringReconnectWait 验证取消与重连等待同时发生时立即返回。
func TestCancelDuringReconnectWait(t *testing.T) {
	store := &failingStore{}
	dial := &dialScript{errs: []error{errors.New("connection refused")}}
	sub := newTestSubscriber(t, Config{
		Store:        store,
		Dial:         dial.dial,
		DefaultRetry: 10 * time.Second,
	})
	runDone := runInGoroutine(sub)

	waitUntil(t, func() bool {
		return len(dial.dialedIDs()) >= 1
	}, 2*time.Second, "first dial never happened")
	sub.Close()
	start := time.Now()
	select {
	case err := <-runDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop during reconnect wait")
	}
	if time.Since(start) > time.Second {
		t.Fatal("cancel during reconnect wait did not return promptly")
	}
}

// TestEmptyIDAckClearsResumeMarker 验证空 id 的确认会清除恢复标记。
func TestEmptyIDAckClearsResumeMarker(t *testing.T) {
	store := &failingStore{id: "old", ok: true}
	stream := newFakeStream("id:\ndata: reset\n\n")
	stream.readCh = make(chan struct{})
	dial := &dialScript{streams: []*fakeStream{stream}}
	sub := newTestSubscriber(t, Config{Store: store, Dial: dial.dial})
	runDone := runInGoroutine(sub)

	ev, err := sub.Next(context.Background())
	if err != nil || ev.Data != "reset" || ev.LastEventID != "" {
		t.Fatalf("event: %+v %v", ev, err)
	}
	if err := sub.Ack(context.Background()); err != nil {
		t.Fatalf("Ack: %v", err)
	}
	if id, ok := store.snapshot(); id != "" || ok {
		t.Fatalf("resume marker not cleared: id=%q ok=%v", id, ok)
	}

	sub.Close()
	select {
	case <-runDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop")
	}
}

// TestChunkedDelivery 验证事件按序投递、UTF-8 正文正确、
// 且一次只有一个待确认事件。
func TestChunkedDelivery(t *testing.T) {
	store := &failingStore{}
	stream := newFakeStream("id: a\ndata: 第一行\ndata: 第二行\n\n" +
		"id: b\nevent: patch\ndata: 补丁\n\n")
	stream.readCh = make(chan struct{})
	dial := &dialScript{streams: []*fakeStream{stream}}
	sub := newTestSubscriber(t, Config{Store: store, Dial: dial.dial})
	runDone := runInGoroutine(sub)

	ev1, err := sub.Next(context.Background())
	if err != nil {
		t.Fatalf("Next 1: %v", err)
	}
	if ev1.Data != "第一行\n第二行" || ev1.LastEventID != "a" || ev1.Type != "message" {
		t.Fatalf("event1 mismatch: %+v", ev1)
	}
	select {
	case ev := <-sub.events:
		t.Fatalf("second event delivered before Ack: %+v", ev)
	case <-time.After(30 * time.Millisecond):
	}
	if err := sub.Ack(context.Background()); err != nil {
		t.Fatalf("Ack 1: %v", err)
	}

	ev2, err := sub.Next(context.Background())
	if err != nil {
		t.Fatalf("Next 2: %v", err)
	}
	if ev2.Type != "patch" || ev2.Data != "补丁" || ev2.LastEventID != "b" {
		t.Fatalf("event2 mismatch: %+v", ev2)
	}

	sub.Close()
	select {
	case <-runDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop")
	}
}

// TestResumeIDLoadedOnStart 验证启动时从存储加载恢复 ID 并用于首次拨号。
func TestResumeIDLoadedOnStart(t *testing.T) {
	store := &failingStore{id: "seed-9", ok: true}
	stream := newFakeStream("data: x\n\n")
	stream.readCh = make(chan struct{})
	dial := &dialScript{streams: []*fakeStream{stream}}
	sub := newTestSubscriber(t, Config{Store: store, Dial: dial.dial})
	runDone := runInGoroutine(sub)

	waitUntil(t, func() bool { return len(dial.dialedIDs()) >= 1 },
		2*time.Second, "dial never happened")
	if ids := dial.dialedIDs(); ids[0] != "seed-9" {
		t.Fatalf("first dial id = %q, want seed-9", ids[0])
	}

	sub.Close()
	select {
	case <-runDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop")
	}
}

// TestManagedStreamClosesOnce 验证正文流即使被取消协程与主流程并发
// 关闭，底层 Close 也只生效一次。
func TestManagedStreamClosesOnce(t *testing.T) {
	base := newFakeStream("data: x\n\n")
	managed := newManagedStream(base)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = managed.Close()
		}()
	}
	wg.Wait()
	if managed.closeCount() != 1 {
		t.Fatalf("close count = %d, want 1", managed.closeCount())
	}
	if !base.isClosed() {
		t.Fatal("underlying stream not closed")
	}
}

// TestByteAtATimeEndToEnd 验证逐字节切块时订阅器仍能完整投递事件，
// 且每个事件确认后才投递下一个。
func TestByteAtATimeEndToEnd(t *testing.T) {
	payload := "id: 1\ndata: alpha\n\nid: 2\ndata: beta\n\n"
	store := &failingStore{}
	stream := newBlockingByteStream(payload)
	var dialed []string
	sub := newTestSubscriber(t, Config{Store: store, Dial: func(ctx context.Context, id string) (Stream, error) {
		dialed = append(dialed, id)
		return stream, nil
	}})
	runDone := runInGoroutine(sub)

	for i, wantData := range []string{"alpha", "beta"} {
		ev, err := sub.Next(context.Background())
		if err != nil {
			t.Fatalf("Next %d: %v", i, err)
		}
		if ev.Data != wantData {
			t.Fatalf("event %d data = %q, want %q", i, ev.Data, wantData)
		}
		if err := sub.Ack(context.Background()); err != nil {
			t.Fatalf("Ack %d: %v", i, err)
		}
	}
	if len(dialed) != 1 || dialed[0] != "" {
		t.Fatalf("dialed ids = %v, want single initial empty id", dialed)
	}

	sub.Close()
	select {
	case <-runDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop")
	}
	if !stream.isClosed() {
		t.Fatal("stream not closed")
	}
}

// TestMemoryStoreClear 验证内置内存存储的空 ID 清除语义。
func TestMemoryStoreClear(t *testing.T) {
	store := NewMemoryStore()
	ctx := context.Background()
	if _, ok, err := store.Load(ctx); err != nil || ok {
		t.Fatalf("empty store ok=%v err=%v", ok, err)
	}
	if err := store.Save(ctx, "abc"); err != nil {
		t.Fatal(err)
	}
	if id, ok, err := store.Load(ctx); err != nil || !ok || id != "abc" {
		t.Fatalf("load = %q,%v,%v", id, ok, err)
	}
	if err := store.Save(ctx, ""); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := store.Load(ctx); err != nil || ok {
		t.Fatalf("marker not cleared: ok=%v err=%v", ok, err)
	}
}

// TestConfigValidation 覆盖配置校验。
func TestConfigValidation(t *testing.T) {
	if _, err := NewSubscriber(Config{}); err == nil {
		t.Fatal("expected error when Store is nil")
	}
	if _, err := NewSubscriber(Config{Store: NewMemoryStore()}); err == nil {
		t.Fatal("expected error when both URL and Dial are empty")
	}
	if _, err := NewSubscriber(Config{Store: NewMemoryStore(), Dial: func(context.Context, string) (Stream, error) {
		return nil, nil
	}}); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
}

// TestRunOnce 验证订阅器不可重复运行。
func TestRunOnce(t *testing.T) {
	stream := newFakeStream("")
	stream.readCh = make(chan struct{})
	dial := &dialScript{streams: []*fakeStream{stream}}
	sub := newTestSubscriber(t, Config{Store: NewMemoryStore(), Dial: dial.dial})
	runDone := runInGoroutine(sub)
	waitUntil(t, func() bool { return len(dial.dialedIDs()) >= 1 },
		2*time.Second, "dial never happened")
	sub.Close()
	<-runDone
	if err := sub.Run(context.Background()); !errors.Is(err, errAlreadyRun) {
		t.Fatalf("second Run err = %v, want errAlreadyRun", err)
	}
}

// errStore 的 Load 始终失败，用于验证启动期错误传播。
type errStore struct{}

func (errStore) Load(context.Context) (string, bool, error) {
	return "", false, errors.New("disk unavailable")
}
func (errStore) Save(context.Context, string) error { return nil }

// TestLoadErrorStopsRun 验证恢复 ID 加载失败时 Run 返回该错误。
func TestLoadErrorStopsRun(t *testing.T) {
	sub := newTestSubscriber(t, Config{
		Store: errStore{},
		Dial:  func(context.Context, string) (Stream, error) { return newFakeStream(""), nil },
	})
	err := sub.Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "disk unavailable") {
		t.Fatalf("Run err = %v, want load error", err)
	}
	if !isClosedDone(sub) {
		t.Fatal("Done channel not closed after load error")
	}
	if sub.Err() == nil {
		t.Fatal("Err() should report the terminal error")
	}
}

func isClosedDone(sub *Subscriber) bool {
	select {
	case <-sub.Done():
		return true
	default:
		return false
	}
}

// TestNextAndAckAfterRunEnds 验证运行结束后 Next/Ack 返回终止错误，
// 且带取消的调用在等待时立即返回 ctx 错误。
func TestNextAndAckAfterRunEnds(t *testing.T) {
	stream := newFakeStream("")
	stream.readCh = make(chan struct{})
	dial := &dialScript{streams: []*fakeStream{stream}}
	sub := newTestSubscriber(t, Config{Store: NewMemoryStore(), Dial: dial.dial})
	runDone := runInGoroutine(sub)
	waitUntil(t, func() bool { return len(dial.dialedIDs()) >= 1 },
		2*time.Second, "dial never happened")
	sub.Close()
	<-runDone

	if _, err := sub.Next(context.Background()); !errors.Is(err, context.Canceled) {
		t.Fatalf("Next after end err = %v, want context.Canceled", err)
	}
	if err := sub.Ack(context.Background()); !errors.Is(err, context.Canceled) {
		t.Fatalf("Ack after end err = %v, want context.Canceled", err)
	}

	// 运行中对 Next 使用已取消 ctx，应立即返回而不吞掉事件状态。
	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()
	other := newTestSubscriber(t, Config{
		Store: NewMemoryStore(),
		Dial:  func(context.Context, string) (Stream, error) { return newFakeStream(""), nil },
	})
	otherDone := runInGoroutine(other)
	if _, err := other.Next(canceledCtx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Next with canceled ctx err = %v", err)
	}
	other.Close()
	<-otherDone
}

// TestRetryOverflowIgnored 验证溢出的 retry 值被忽略。
func TestRetryOverflowIgnored(t *testing.T) {
	dec, _, retries := collectDecoder()
	big := "retry: 999999999999999999999999999999\nretry: 42\n"
	if _, err := dec.Write([]byte(big)); err != nil {
		t.Fatal(err)
	}
	if dec.RetryMillis() != 42 {
		t.Fatalf("RetryMillis = %d, want 42", dec.RetryMillis())
	}
	if len(*retries) != 1 || (*retries)[0] != 42 {
		t.Fatalf("retries = %v, want [42]", *retries)
	}
}
