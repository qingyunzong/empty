package resourceblock

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// recorder 是受控回调验收用的记录器。
type recorder struct{ order []string }

func (r *recorder) cleanup(name string) CleanupFunc {
	return func(context.Context, *Scope) error {
		r.order = append(r.order, name)
		return nil
	}
}

func releaseOrder(events []Event) []string {
	var got []string
	for _, e := range events {
		if e.Kind == EventRelease {
			got = append(got, e.Name)
		}
	}
	return got
}

// 正常 return：LIFO 清理，事件轨迹完整有序。
func TestNormalReturnLIFO(t *testing.T) {
	var r recorder
	events, err := RunTraced(context.Background(), func(s *Scope) error {
		for _, name := range []string{"a", "b", "c"} {
			if err := s.Defer(name, r.cleanup(name)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if want := []string{"c", "b", "a"}; !reflect.DeepEqual(r.order, want) {
		t.Fatalf("cleanup order = %v, want %v", r.order, want)
	}
	var kinds []string
	for _, e := range events {
		kinds = append(kinds, fmt.Sprintf("%d:%s:%s", e.Seq, e.Kind, e.Name))
	}
	want := []string{
		"0:acquire:a", "1:acquire:b", "2:acquire:c",
		"3:release:c", "4:release:b", "5:release:a",
	}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("trace = %v, want %v", kinds, want)
	}
	for _, e := range events {
		t.Log(e)
	}
}

// 返回错误：主错误原样保留，清理照常执行。
func TestErrorReturn(t *testing.T) {
	primary := errors.New("boom")
	var r recorder
	err := Run(context.Background(), func(s *Scope) error {
		_ = s.Defer("a", r.cleanup("a"))
		_ = s.Defer("b", r.cleanup("b"))
		return primary
	})
	if !errors.Is(err, primary) || err.Error() != primary.Error() {
		t.Fatalf("err = %v, want primary preserved", err)
	}
	if want := []string{"b", "a"}; !reflect.DeepEqual(r.order, want) {
		t.Fatalf("cleanup order = %v, want %v", r.order, want)
	}
}

// panic：清理照常执行，原 panic 值继续抛出。
func TestPanicStillCleansUp(t *testing.T) {
	var r recorder
	defer func() {
		p := recover()
		if p != "kaboom" {
			t.Fatalf("panic value = %v, want kaboom", p)
		}
		if want := []string{"b", "a"}; !reflect.DeepEqual(r.order, want) {
			t.Fatalf("cleanup order = %v, want %v", r.order, want)
		}
	}()
	_ = Run(context.Background(), func(s *Scope) error {
		_ = s.Defer("a", r.cleanup("a"))
		_ = s.Defer("b", r.cleanup("b"))
		panic("kaboom")
	})
}

// 取消：ctx 取消成为主错误，清理仍执行且清理 ctx 未被取消。
func TestCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var cleaned []string
	err := Run(ctx, func(s *Scope) error {
		_ = s.Defer("a", func(cctx context.Context, _ *Scope) error {
			if cctx.Err() != nil {
				t.Errorf("cleanup ctx should be detached from cancellation, got %v", cctx.Err())
			}
			cleaned = append(cleaned, "a")
			return nil
		})
		return nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if len(cleaned) != 1 {
		t.Fatalf("cleaned = %v, want cleanup ran", cleaned)
	}
}

// 清理失败：保留主错误并附从错误，errors.Is 对两者都生效。
func TestCleanupFailureAttachesToPrimary(t *testing.T) {
	primary := errors.New("main failure")
	cleanErr := errors.New("cleanup failed")
	events, err := RunTraced(context.Background(), func(s *Scope) error {
		_ = s.Defer("ok", func(context.Context, *Scope) error { return nil })
		_ = s.Defer("bad", func(context.Context, *Scope) error { return cleanErr })
		return primary
	})
	var exitErr *ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("err type = %T, want *ExitError", err)
	}
	if !errors.Is(err, primary) || !errors.Is(err, cleanErr) {
		t.Fatalf("err = %v, want both primary and cleanup error visible", err)
	}
	if exitErr.Primary != primary || len(exitErr.Cleanup) != 1 {
		t.Fatalf("ExitError = %+v", exitErr)
	}
	if got := releaseOrder(events); !reflect.DeepEqual(got, []string{"ok"}) {
		t.Fatalf("successful releases = %v", got)
	}
	var failed bool
	for _, e := range events {
		if e.Kind == EventReleaseFailed && e.Name == "bad" && errors.Is(e.Err, cleanErr) {
			failed = true
		}
	}
	if !failed {
		t.Fatalf("trace missing release-failed event: %v", events)
	}
}

// 仅清理失败（无主错误）：Primary 为 nil，从错误仍在。
func TestCleanupFailureWithoutPrimary(t *testing.T) {
	cleanErr := errors.New("cleanup failed")
	err := Run(context.Background(), func(s *Scope) error {
		_ = s.Defer("bad", func(context.Context, *Scope) error { return cleanErr })
		return nil
	})
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Primary != nil {
		t.Fatalf("err = %v, want ExitError with nil Primary", err)
	}
	if !errors.Is(err, cleanErr) {
		t.Fatalf("err = %v, want cleanup error visible", err)
	}
}

// 清理中再建资源：本块退出前按 LIFO 一并清理。
func TestResourceCreatedDuringCleanup(t *testing.T) {
	var r recorder
	events, err := RunTraced(context.Background(), func(s *Scope) error {
		_ = s.Defer("outer", func(_ context.Context, s *Scope) error {
			r.order = append(r.order, "outer")
			return s.Defer("inner", r.cleanup("inner"))
		})
		_ = s.Defer("last", r.cleanup("last"))
		return nil
	})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	// 弹出顺序：last -> outer；outer 清理时登记 inner，inner 在本块退出前清理。
	if want := []string{"last", "outer", "inner"}; !reflect.DeepEqual(r.order, want) {
		t.Fatalf("cleanup order = %v, want %v", r.order, want)
	}
	if got := releaseOrder(events); !reflect.DeepEqual(got, r.order) {
		t.Fatalf("trace releases = %v, want %v", got, r.order)
	}
}

// 清理回调 panic：转为从错误，不中断其余清理。
func TestCleanupPanicBecomesSecondaryError(t *testing.T) {
	var r recorder
	err := Run(context.Background(), func(s *Scope) error {
		_ = s.Defer("a", r.cleanup("a"))
		_ = s.Defer("panicky", func(context.Context, *Scope) error { panic("oops") })
		return nil
	})
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || len(exitErr.Cleanup) != 1 {
		t.Fatalf("err = %v, want one cleanup failure", err)
	}
	if !strings.Contains(exitErr.Cleanup[0].Error(), "panic: oops") {
		t.Fatalf("cleanup error = %v, want panic captured", exitErr.Cleanup[0])
	}
	if want := []string{"a"}; !reflect.DeepEqual(r.order, want) {
		t.Fatalf("cleanup after panic did not run: %v", r.order)
	}
}

// 受控回调验收：nil 回调被拒；块退出后登记被拒。
func TestControlledCallbackAcceptance(t *testing.T) {
	var captured *Scope
	err := Run(context.Background(), func(s *Scope) error {
		captured = s
		if got := s.Defer("nil-cb", nil); !errors.Is(got, ErrNilCleanup) {
			t.Errorf("Defer(nil) = %v, want ErrNilCleanup", got)
		}
		return s.Defer("ok", func(context.Context, *Scope) error { return nil })
	})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got := captured.Defer("late", func(context.Context, *Scope) error { return nil }); !errors.Is(got, ErrScopeClosed) {
		t.Fatalf("Defer after exit = %v, want ErrScopeClosed", got)
	}
}

// 事件轨迹输出示例。
func TestTraceOutput(t *testing.T) {
	events, _ := RunTraced(context.Background(), func(s *Scope) error {
		_ = s.Defer("db", func(context.Context, *Scope) error { return nil })
		_ = s.Defer("cache", func(context.Context, *Scope) error { return errors.New("flush failed") })
		return nil
	})
	var lines []string
	for _, e := range events {
		lines = append(lines, e.String())
	}
	trace := strings.Join(lines, "\n")
	t.Log("\n" + trace)
	if !strings.Contains(trace, `release-failed "cache": flush failed`) {
		t.Fatalf("trace missing failure line:\n%s", trace)
	}
}
