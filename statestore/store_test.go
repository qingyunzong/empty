package statestore

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// shortWriteFile simulates a failing device: Write persists only keep bytes
// and reports a short write, so the torn tail lands in the real file.
type shortWriteFile struct {
	inner syncFile
	keep  int
}

func (f *shortWriteFile) Write(p []byte) (int, error) {
	if len(p) > f.keep {
		if _, err := f.inner.Write(p[:f.keep]); err != nil {
			return 0, err
		}
		return f.keep, io.ErrShortWrite
	}
	return f.inner.Write(p)
}
func (f *shortWriteFile) Sync() error  { return f.inner.Sync() }
func (f *shortWriteFile) Close() error { return f.inner.Close() }

// crashFile simulates a crash: after the frame is synced, the process "dies"
// before the store publishes the new state in memory.
type crashFile struct {
	inner   syncFile
	onSync  func()
	crashed bool
}

func (f *crashFile) Write(p []byte) (int, error) { return f.inner.Write(p) }
func (f *crashFile) Sync() error {
	err := f.inner.Sync()
	if err == nil && f.onSync != nil && !f.crashed {
		f.crashed = true
		f.onSync()
	}
	return err
}
func (f *crashFile) Close() error { return f.inner.Close() }

func openAt(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// barrier holds goroutines until all have arrived, then releases them at once.
type barrier struct {
	arrived sync.WaitGroup
	go_     chan struct{}
	once    sync.Once
}

func newBarrier(n int) *barrier {
	b := &barrier{go_: make(chan struct{})}
	b.arrived.Add(n)
	return b
}

func (b *barrier) wait() {
	b.arrived.Done()
	<-b.go_
}

func (b *barrier) releaseWhenAllArrived() {
	go func() {
		b.arrived.Wait()
		b.once.Do(func() { close(b.go_) })
	}()
}

// TestConcurrentSameExpectedVersion: N goroutines race with the same expected
// version; exactly one wins and receives version 1, all others get
// ErrVersionMismatch and observe version 1.
func TestConcurrentSameExpectedVersion(t *testing.T) {
	dir := t.TempDir()
	s := openAt(t, filepath.Join(dir, "wal.log"))

	const racers = 32
	b := newBarrier(racers)
	b.releaseWhenAllArrived()

	var wg sync.WaitGroup
	results := make(chan error, racers)
	versions := make(chan uint64, racers)
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			b.wait()
			v, err := s.Update(0, []byte{byte(i)})
			versions <- v
			results <- err
		}(i)
	}
	wg.Wait()
	close(results)
	close(versions)

	successes := 0
	for err := range results {
		if err == nil {
			successes++
		} else if !errors.Is(err, ErrVersionMismatch) {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("expected exactly 1 success, got %d", successes)
	}
	for v := range versions {
		if v != 1 {
			t.Fatalf("all racers must observe version 1, got %d", v)
		}
	}
	if got, _ := s.Get(); got != 1 {
		t.Fatalf("final version = %d, want 1", got)
	}
}

// TestVersionChainUnderConcurrency: racers CAS on the latest observed
// version; returned versions must be exactly the set {1..N} with no gaps.
func TestVersionChainUnderConcurrency(t *testing.T) {
	dir := t.TempDir()
	s := openAt(t, filepath.Join(dir, "wal.log"))

	const racers = 16
	const updatesEach = 25
	b := newBarrier(racers)
	b.releaseWhenAllArrived()

	var mu sync.Mutex
	seen := map[uint64]bool{}
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b.wait()
			for j := 0; j < updatesEach; j++ {
				for {
					cur, _ := s.Get()
					v, err := s.Update(cur, []byte{byte(j)})
					if errors.Is(err, ErrVersionMismatch) {
						continue
					}
					if err != nil {
						t.Errorf("update: %v", err)
						return
					}
					if v != cur+1 {
						t.Errorf("returned version %d, want %d", v, cur+1)
					}
					mu.Lock()
					if seen[v] {
						t.Errorf("version %d returned twice", v)
					}
					seen[v] = true
					mu.Unlock()
					break
				}
			}
		}()
	}
	wg.Wait()

	total := uint64(racers * updatesEach)
	if got, _ := s.Get(); got != total {
		t.Fatalf("final version = %d, want %d", got, total)
	}
	for v := uint64(1); v <= total; v++ {
		if !seen[v] {
			t.Fatalf("version %d never returned", v)
		}
	}
}

// TestShortWriteNotPublished: a short write must fail the update, leave the
// in-memory state untouched, and leave no replayable frame behind.
func TestShortWriteNotPublished(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wal.log")
	s := openAt(t, path)

	// Commit v1 on the healthy file.
	if v, err := s.Update(0, []byte("one")); err != nil || v != 1 {
		t.Fatalf("v1 update = (%d, %v)", v, err)
	}

	// Swap in a file that truncates the v2 frame to 10 bytes (< header).
	healthy := s.wal
	s.wal = &shortWriteFile{inner: healthy, keep: 10}
	if _, err := s.Update(1, []byte("two")); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("short write update err = %v, want io.ErrShortWrite", err)
	}
	if v, val := s.Get(); v != 1 || !bytes.Equal(val, []byte("one")) {
		t.Fatalf("short write published state: v=%d val=%q", v, val)
	}
	s.wal = healthy

	// The torn tail must be ignored on recovery: replay sees only v1.
	s.Close()
	s2 := openAt(t, path)
	if v, val := s2.Get(); v != 1 || !bytes.Equal(val, []byte("one")) {
		t.Fatalf("after recovery: v=%d val=%q, want v=1 val=%q", v, val, "one")
	}
	// Store still accepts updates after the failed one.
	if v, err := s2.Update(1, []byte("two")); err != nil || v != 2 {
		t.Fatalf("post-failure update = (%d, %v)", v, err)
	}
}

// TestCrashAfterPersistBeforePublish: the frame is fsynced but the process
// crashes before publishing; recovery must replay the committed frame.
func TestCrashAfterPersistBeforePublish(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wal.log")
	s := openAt(t, path)

	crashed := make(chan struct{})
	s.wal = &crashFile{inner: s.wal, onSync: func() { close(crashed) }}

	done := make(chan error, 1)
	go func() {
		v, err := s.Update(0, []byte("committed"))
		if err == nil && v != 1 {
			err = errors.New("bad version")
		}
		done <- err
	}()
	<-crashed // process "dies" here: frame persisted, publish may not have run

	// Recovery replays the complete frame regardless of the crash point.
	s2 := openAt(t, path)
	if v, val := s2.Get(); v != 1 || !bytes.Equal(val, []byte("committed")) {
		t.Fatalf("after crash recovery: v=%d val=%q, want v=1 val=%q", v, val, "committed")
	}
	if err := <-done; err != nil {
		t.Fatalf("crashed update: %v", err)
	}
}

// TestReplayIgnoresTornAndCorruptTail builds a log by hand: two complete
// frames, then a corrupt-CRC frame, then a truncated frame. Only the
// complete prefix may be replayed.
func TestReplayIgnoresTornAndCorruptTail(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wal.log")

	var log []byte
	log = append(log, encodeFrame(1, []byte("one"))...)
	log = append(log, encodeFrame(2, []byte("two"))...)
	corrupt := encodeFrame(3, []byte("three"))
	corrupt[len(corrupt)-1] ^= 0xFF // break the CRC
	log = append(log, corrupt...)
	torn := encodeFrame(4, []byte("four"))
	log = append(log, torn[:frameHeaderLen+2]...) // truncated payload
	if err := os.WriteFile(path, log, 0o644); err != nil {
		t.Fatal(err)
	}

	s := openAt(t, path)
	if v, val := s.Get(); v != 2 || !bytes.Equal(val, []byte("two")) {
		t.Fatalf("replayed v=%d val=%q, want v=2 val=%q", v, val, "two")
	}
}
