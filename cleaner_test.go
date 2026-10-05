package cleaner

import (
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// 过期边界：now >= deadline 才回收，now < deadline 必须保留。
func TestSweepExpiryBoundary(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	deadline := epoch.Add(time.Minute)
	if _, err := s.Put("a", []byte("x"), deadline); err != nil {
		t.Fatal(err)
	}

	removed, err := s.Sweep(deadline.Add(-time.Nanosecond))
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 0 || !s.Exists("a") {
		t.Fatalf("now < deadline: 不应删除, removed=%v exists=%v", removed, s.Exists("a"))
	}

	removed, err = s.Sweep(deadline) // now == deadline 即过期
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 1 || removed[0] != "a" || s.Exists("a") {
		t.Fatalf("now == deadline: 应删除, removed=%v exists=%v", removed, s.Exists("a"))
	}
}

// 续租与删除在同一临界区决胜：续租成功后，按旧截止时间的清理不得误删。
func TestRenewWinsAgainstSweep(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := epoch.Add(time.Minute)
	gen, err := s.Put("a", []byte("x"), old)
	if err != nil {
		t.Fatal(err)
	}
	future := epoch.Add(time.Hour)
	if err := s.Renew("a", gen, future); err != nil {
		t.Fatal(err)
	}
	removed, err := s.Sweep(old.Add(time.Minute)) // 已过旧截止、未到新截止
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 0 || !s.Exists("a") {
		t.Fatalf("续租后被误删: removed=%v exists=%v", removed, s.Exists("a"))
	}
}

// 旧代清理不能删除新代同名文件；旧代续租必须被拒绝。
func TestStaleGenerationCannotTouchNewFile(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	deadline := epoch.Add(time.Minute)
	gen1, err := s.Put("a", []byte("old"), deadline)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Sweep(deadline); err != nil { // 回收旧代
		t.Fatal(err)
	}
	// 同名新代文件，截止时间在很远的未来。
	gen2, err := s.Put("a", []byte("new"), epoch.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if gen2 <= gen1 {
		t.Fatalf("代际号应递增: gen1=%d gen2=%d", gen1, gen2)
	}
	// 旧代持有者的续租必须失败。
	if err := s.Renew("a", gen1, epoch.Add(48*time.Hour)); !errors.Is(err, ErrStaleGeneration) && !errors.Is(err, ErrNotFound) {
		t.Fatalf("旧代续租应被拒绝, got %v", err)
	}
	// 再次按旧截止时间清理，新代同名文件不得受影响。
	removed, err := s.Sweep(deadline.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 0 || !s.Exists("a") {
		t.Fatalf("新代同名文件被误删: removed=%v exists=%v", removed, s.Exists("a"))
	}
	if data, _ := readFile(s, "a"); string(data) != "new" {
		t.Fatalf("文件内容应为新代内容, got %q", data)
	}
}

// 断电恢复：租约持久化，重启后过期语义与续租结果不丢失。
func TestCrashRecovery(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	d1 := epoch.Add(time.Minute)
	d2 := epoch.Add(2 * time.Minute)
	if _, err := s.Put("expire", []byte("e"), d1); err != nil {
		t.Fatal(err)
	}
	gen, err := s.Put("renewed", []byte("r"), d1)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Renew("renewed", gen, d2); err != nil { // 续租到 d2
		t.Fatal(err)
	}
	// 模拟断电：不做任何清理，直接重新 Open。
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	l, err := s2.LeaseOf("renewed")
	if err != nil {
		t.Fatalf("重启后租约丢失: %v", err)
	}
	if !l.Deadline.Equal(d2) || l.Generation != gen {
		t.Fatalf("重启后租约不正确: %+v", l)
	}
	// 在 d1 时刻清理：expire 应删，renewed（已续到 d2）不得删。
	removed, err := s2.Sweep(d1)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 1 || removed[0] != "expire" {
		t.Fatalf("恢复后误删: removed=%v", removed)
	}
	if !s2.Exists("renewed") {
		t.Fatal("恢复后续租文件被误删")
	}
	// 到 d2 时刻再清理，renewed 才应被回收。
	if removed, err = s2.Sweep(d2); err != nil || len(removed) != 1 || removed[0] != "renewed" {
		t.Fatalf("到期未回收: removed=%v err=%v", removed, err)
	}
}

// 并发屏障：多 goroutine 同时续租/清理，核对无有效租约文件被误删。
func TestConcurrentRenewAndSweepBarrier(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const files = 32
	const rounds = 50
	base := epoch

	gens := make([]uint64, files)
	for i := 0; i < files; i++ {
		gen, err := s.Put(fmt.Sprintf("f%02d", i), []byte("v"), base.Add(time.Millisecond))
		if err != nil {
			t.Fatal(err)
		}
		gens[i] = gen
	}

	barrier := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, files*rounds*2)

	// 清理方：反复在“当前截止”时刻清扫。
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-barrier
		for r := 0; r < rounds; r++ {
			if _, err := s.Sweep(base.Add(time.Millisecond)); err != nil {
				errs <- err
				return
			}
		}
	}()
	// 续租方：并发把所有租约延长到未来。
	for i := 0; i < files; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-barrier
			for r := 0; r < rounds; r++ {
				err := s.Renew(fmt.Sprintf("f%02d", i), gens[i], base.Add(time.Hour))
				if err != nil && !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrStaleGeneration) {
					errs <- err
				}
			}
		}(i)
	}
	close(barrier)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("并发执行出错: %v", err)
	}

	// 不变量核对：任何仍持有有效租约（截止 > 清扫时刻）的文件必须存在于磁盘；
	// 任何磁盘上残留的登记文件其租约截止必须晚于清扫时刻（即没有被误删后重建的不一致）。
	sweepNow := base.Add(time.Millisecond)
	for i := 0; i < files; i++ {
		name := fmt.Sprintf("f%02d", i)
		l, err := s.LeaseOf(name)
		if errors.Is(err, ErrNotFound) {
			continue // 已被合法回收
		}
		if err != nil {
			t.Fatal(err)
		}
		if !l.Deadline.After(sweepNow) {
			t.Fatalf("%s: 租约已过期但未被清理", name)
		}
		if !s.Exists(name) {
			t.Fatalf("%s: 租约有效（deadline=%v）但文件被误删", name, l.Deadline)
		}
	}
}

func readFile(s *Store, name string) ([]byte, error) {
	return os.ReadFile(s.path(name))
}
