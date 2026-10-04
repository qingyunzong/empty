package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func openTemp(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.wal")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s, path
}

// 屏障并发:多个 goroutine 以相同预期版本竞争,只有一个成功。
func TestConcurrentSameExpectedVersionOnlyOneWins(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()

	const racers = 64
	start := make(chan struct{}) // 屏障:关闭即同时放行
	var wg sync.WaitGroup
	results := make([]error, racers)
	versions := make([]uint64, racers)
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			v, err := s.Update(0, []byte(fmt.Sprintf("winner-%d", i)))
			versions[i], results[i] = v, err
		}(i)
	}
	close(start) // 放行,全部竞争 expected=0
	wg.Wait()

	wins := 0
	for i := 0; i < racers; i++ {
		if results[i] == nil {
			wins++
			if versions[i] != 1 {
				t.Fatalf("winner returned version %d, want 1", versions[i])
			}
		} else if !errors.Is(results[i], ErrVersionMismatch) {
			t.Fatalf("loser got unexpected error: %v", results[i])
		}
	}
	if wins != 1 {
		t.Fatalf("got %d winners, want exactly 1", wins)
	}
	if v, _ := s.Get(); v != 1 {
		t.Fatalf("final version = %d, want 1", v)
	}
}

// 持久化先于可见:fsync 进行中,已发布版本必须仍是旧值。
func TestPersistedBeforeVisible(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()

	origSync := s.wal.syncFn
	var seenDuringSync uint64
	s.wal.syncFn = func() error {
		seenDuringSync = s.PublishedVersion() // 崩溃点观察:此刻新值不得可见
		return origSync()
	}

	if _, err := s.Update(0, []byte("v1")); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if seenDuringSync != 0 {
		t.Fatalf("value visible before fsync completed: published=%d", seenDuringSync)
	}
	if got := s.PublishedVersion(); got != 1 {
		t.Fatalf("after Update published=%d, want 1", got)
	}
}

// 短写失败不得发布,且日志被截回,恢复后仍是旧状态。
func TestShortWriteNotPublished(t *testing.T) {
	s, path := openTemp(t)

	origWrite := s.wal.writeFn
	s.wal.writeFn = func(p []byte) (int, error) {
		n, err := origWrite(p[:len(p)/2]) // 模拟短写:只写一半,无错误返回
		return n, err
	}
	if _, err := s.Update(0, []byte("bad")); !errors.Is(err, ErrShortWrite) {
		t.Fatalf("Update err = %v, want ErrShortWrite", err)
	}
	if v, _ := s.Get(); v != 0 {
		t.Fatalf("short write published: version = %d", v)
	}
	s.wal.writeFn = origWrite

	// 恢复重放:半个帧不得被当成提交。
	s.Close()
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	if v, val := s2.Get(); v != 0 || val != nil {
		t.Fatalf("after recovery version=%d value=%q, want 0/nil", v, val)
	}
}

// 写调用直接报错同样不得发布。
func TestWriteErrorNotPublished(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()

	boom := errors.New("disk on fire")
	s.wal.writeFn = func(p []byte) (int, error) { return 0, boom }
	if _, err := s.Update(0, []byte("bad")); !errors.Is(err, boom) {
		t.Fatalf("Update err = %v, want %v", err, boom)
	}
	if v, _ := s.Get(); v != 0 {
		t.Fatalf("failed write published: version = %d", v)
	}
}

// 崩溃注入:fsync 失败(模拟崩溃)不得发布,恢复后仍是旧状态。
func TestCrashDuringSyncNotPublished(t *testing.T) {
	s, path := openTemp(t)

	crash := errors.New("crash: power lost during fsync")
	s.wal.syncFn = func() error { return crash }
	if _, err := s.Update(0, []byte("bad")); !errors.Is(err, crash) {
		t.Fatalf("Update err = %v, want crash", err)
	}
	if v, _ := s.Get(); v != 0 {
		t.Fatalf("crashed update published: version = %d", v)
	}
	if got := s.PublishedVersion(); got != 0 {
		t.Fatalf("published version = %d after crash, want 0", got)
	}

	s.Close()
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	if v, _ := s2.Get(); v != 0 {
		t.Fatalf("after recovery version = %d, want 0", v)
	}
}

// 恢复重放只认完整提交帧:撕裂尾部被忽略并被截断。
func TestRecoveryIgnoresTornTail(t *testing.T) {
	s, path := openTemp(t)
	if _, err := s.Update(0, []byte("one")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Update(1, []byte("two")); err != nil {
		t.Fatal(err)
	}
	s.Close()

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	goodSize := fi.Size()

	// 追加半个帧(撕裂写),模拟崩溃现场。
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte{0x01, 0xEE, 0xFF, 0xC0, 0x03, 0x00}); err != nil {
		t.Fatal(err)
	}
	f.Close()

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	if v, val := s2.Get(); v != 2 || string(val) != "two" {
		t.Fatalf("version=%d value=%q, want 2/two", v, val)
	}
	// 打开时撕裂尾部应被截掉。
	if fi, _ := os.Stat(path); fi.Size() != goodSize {
		t.Fatalf("torn tail not truncated: size=%d, want %d", fi.Size(), goodSize)
	}
}

// CRC 损坏的帧及其后内容一律不认。
func TestRecoveryStopsAtCorruptFrame(t *testing.T) {
	s, path := openTemp(t)
	if _, err := s.Update(0, []byte("one")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Update(1, []byte("two")); err != nil {
		t.Fatal(err)
	}
	s.Close()

	// 第一帧长度 = 头 + payload("one") + crc,第二帧 payload 从这里开始。
	secondPayload := int64(frameHdrSize + 3 + frameCrcSize + frameHdrSize)
	f, err := os.OpenFile(path, os.O_RDWR, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte{0xFF}, secondPayload); err != nil { // 破坏第二帧 payload
		t.Fatal(err)
	}
	f.Close()

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	if v, val := s2.Get(); v != 1 || string(val) != "one" {
		t.Fatalf("version=%d value=%q, want 1/one (corrupt frame must be rejected)", v, val)
	}
}

// 基本往返:更新-关闭-重开后状态一致,版本可继续递增。
func TestRecoveryRoundTrip(t *testing.T) {
	s, path := openTemp(t)
	for i := uint64(0); i < 5; i++ {
		if v, err := s.Update(i, []byte(fmt.Sprintf("v%d", i+1))); err != nil || v != i+1 {
			t.Fatalf("Update(%d) = (%d, %v)", i, v, err)
		}
	}
	s.Close()

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	if v, val := s2.Get(); v != 5 || string(val) != "v5" {
		t.Fatalf("version=%d value=%q, want 5/v5", v, val)
	}
	if v, err := s2.Update(5, []byte("v6")); err != nil || v != 6 {
		t.Fatalf("post-recovery Update = (%d, %v)", v, err)
	}
}
