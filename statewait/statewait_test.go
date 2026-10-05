package statewait

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// barrier 是一个可复用的会合屏障：n 个 goroutine 全部到达后
// 才一起放行，用于精确构造“登记先于/后于更新”的时序。
type barrier struct {
	n       int
	count   int
	mu      sync.Mutex
	release chan struct{}
}

func newBarrier(n int) *barrier {
	return &barrier{n: n, release: make(chan struct{})}
}

func (b *barrier) wait() {
	b.mu.Lock()
	b.count++
	if b.count == b.n {
		close(b.release)
	}
	b.mu.Unlock()
	<-b.release
}

func waitResult(t *testing.T, w *Waiter, ctx context.Context, threshold uint64) (uint64, error) {
	t.Helper()
	type res struct {
		v   uint64
		err error
	}
	done := make(chan res, 1)
	go func() {
		v, err := w.Wait(ctx, threshold)
		done <- res{v, err}
	}()
	select {
	case r := <-done:
		return r.v, r.err
	case <-time.After(2 * time.Second):
		t.Fatal("Wait 未在超时内返回")
		return 0, nil
	}
}

func TestWaitReturnsWhenVersionExceeds(t *testing.T) {
	w := New()
	defer w.Close()
	go w.Update(5)
	v, err := waitResult(t, w, context.Background(), 3)
	if err != nil || v != 5 {
		t.Fatalf("got (%d, %v), want (5, nil)", v, err)
	}
}

func TestWaitReturnsImmediatelyWhenAlreadyAhead(t *testing.T) {
	w := New()
	defer w.Close()
	w.Update(10)
	v, err := w.Wait(context.Background(), 4)
	if err != nil || v != 10 {
		t.Fatalf("got (%d, %v), want (10, nil)", v, err)
	}
}

func TestSameVersionDoesNotWake(t *testing.T) {
	w := New()
	defer w.Close()
	if !w.Update(7) {
		t.Fatal("首次 Update(7) 应推进版本")
	}
	if w.Update(7) {
		t.Fatal("重复 Update(7) 不应推进版本")
	}
	done := make(chan error, 1)
	go func() {
		_, err := w.Wait(context.Background(), 7)
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("同版本更新不应唤醒等待者, Wait 返回 %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if !w.Update(8) {
		t.Fatal("Update(8) 应推进版本")
	}
	if err := <-done; err != nil {
		t.Fatalf("Update(8) 后 Wait 应成功, got %v", err)
	}
}

func TestLowerVersionDoesNotWake(t *testing.T) {
	w := New()
	defer w.Close()
	w.Update(9)
	if w.Update(3) {
		t.Fatal("更低版本不应推进")
	}
	if got := w.Version(); got != 9 {
		t.Fatalf("版本应保持 9, got %d", got)
	}
}

func TestCancelBeforeUpdate(t *testing.T) {
	w := New()
	defer w.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := w.Wait(ctx, 1)
		done <- err
	}()
	time.Sleep(20 * time.Millisecond) // 确保已登记
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want context.Canceled", err)
	}
}

func TestCancelUpdateRaceFirstCompleterWins(t *testing.T) {
	for i := 0; i < 2000; i++ {
		w := New()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			_, err := w.Wait(ctx, 1)
			done <- err
		}()
		go w.Update(2)
		go cancel()
		select {
		case err := <-done:
			// 两种结局都合法：更新先完成（err == nil）或取消先完成
			// （context.Canceled），但不得出现其他错误或挂起。
			if err != nil && !errors.Is(err, context.Canceled) {
				t.Fatalf("iter %d: 意外错误 %v", i, err)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("iter %d: Wait 挂起", i)
		}
		w.Close()
	}
}

func TestCloseUnblocksWaitersImmediately(t *testing.T) {
	w := New()
	const n = 8
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = w.Wait(context.Background(), 100)
		}(i)
	}
	time.Sleep(20 * time.Millisecond) // 确保全部登记
	start := time.Now()
	w.Close()
	wg.Wait()
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("关闭后等待者应立即退出, 耗时 %v", elapsed)
	}
	for i, err := range errs {
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("waiter %d: got %v, want ErrClosed", i, err)
		}
	}
}

func TestWaitAndUpdateAfterClose(t *testing.T) {
	w := New()
	w.Close()
	if _, err := w.Wait(context.Background(), 0); !errors.Is(err, ErrClosed) {
		t.Fatalf("关闭后 Wait 应立即返回 ErrClosed, got %v", err)
	}
	if w.Update(1) {
		t.Fatal("关闭后 Update 不应生效")
	}
	w.Close() // 重复关闭安全
}

// TestBarrierNotifyBeforeAndAfterRegistration 用屏障穷举两类时序：
// 全部等待者在更新之前完成登记（更新必须逐个唤醒），以及全部
// 等待者在更新之后才登记（登记时必须立即观察到新版本），并覆盖
// 一半先登记、一半后登记的混合情形。
func TestBarrierNotifyBeforeAndAfterRegistration(t *testing.T) {
	const n = 16
	thresholds := []uint64{0, 1, 2, 5}

	cases := []struct {
		name        string
		beforeCount int // 在屏障前（更新前）完成登记的等待者数量
	}{
		{"all_registered_before_update", n},
		{"all_registered_after_update", 0},
		{"half_before_half_after", n / 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, th := range thresholds {
				t.Run(fmt.Sprintf("threshold_%d", th), func(t *testing.T) {
					w := New()
					defer w.Close()
					const newVersion = 10

					bar := newBarrier(tc.beforeCount + 1) // 先登记组 + 更新方
					results := make(chan error, n)

					waitFn := func() {
						v, err := w.Wait(context.Background(), th)
						if err != nil {
							results <- fmt.Errorf("Wait: %w", err)
							return
						}
						if v != newVersion {
							results <- fmt.Errorf("got version %d, want %d", v, newVersion)
							return
						}
						results <- nil
					}

					// 先登记组：过屏障后更新才发生，保证登记先于更新。
					for i := 0; i < tc.beforeCount; i++ {
						go func() {
							bar.wait()
							waitFn()
						}()
					}
					// 更新方：屏障确保先登记组已全部进入 Wait 的
					// 临界区之后再推进版本。
					go func() {
						bar.wait()
						w.Update(newVersion)
					}()
					// 后登记组：等更新完成后才发起 Wait。
					for i := tc.beforeCount; i < n; i++ {
						go func() {
							for w.Version() < newVersion {
								time.Sleep(time.Millisecond)
							}
							waitFn()
						}()
					}

					for i := 0; i < n; i++ {
						select {
						case err := <-results:
							if err != nil {
								t.Fatal(err)
							}
						case <-time.After(2 * time.Second):
							t.Fatal("存在等待者未被通知")
						}
					}
				})
			}
		})
	}
}

func TestConcurrentStress(t *testing.T) {
	w := New()
	const waiters = 64
	var wg sync.WaitGroup
	for i := 0; i < waiters; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			v, err := w.Wait(ctx, uint64(i%4))
			if err == nil && v <= uint64(i%4) {
				t.Errorf("返回版本 %d 未超过阈值 %d", v, i%4)
			}
		}(i)
	}
	for v := uint64(1); v <= 8; v++ {
		w.Update(v)
	}
	w.Close()
	wg.Wait()
}
