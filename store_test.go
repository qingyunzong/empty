package materiallib

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "lib"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func files(tag string) map[string][]byte {
	return map[string][]byte{
		"logs/run.log":      []byte("log of " + tag),
		"summary.json":      []byte(`{"tag":"` + tag + `"}`),
		"data/output.bin":   []byte("payload-" + tag),
		"data/meta/info.md": []byte("# " + tag),
	}
}

func mustPublish(t *testing.T, s *Store, tag string) uint64 {
	t.Helper()
	v, err := s.Publish(files(tag))
	if err != nil {
		t.Fatalf("Publish(%s): %v", tag, err)
	}
	return v
}

func mustRead(t *testing.T, s *Store) *Snapshot {
	t.Helper()
	snap, err := s.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	return snap
}

func assertSnapshot(t *testing.T, snap *Snapshot, version uint64, tag string) {
	t.Helper()
	if snap.Version != version {
		t.Fatalf("snapshot version = %d, want %d", snap.Version, version)
	}
	want := files(tag)
	if len(snap.Files) != len(want) {
		t.Fatalf("snapshot has %d files, want %d", len(snap.Files), len(want))
	}
	for name, content := range want {
		got, ok := snap.Files[name]
		if !ok {
			t.Fatalf("snapshot missing file %s", name)
		}
		if string(got) != string(content) {
			t.Fatalf("file %s = %q, want %q", name, got, content)
		}
	}
}

func TestPublishThenRead(t *testing.T) {
	s := newStore(t)
	v := mustPublish(t, s, "alpha")
	if v != 1 {
		t.Fatalf("first version = %d, want 1", v)
	}
	assertSnapshot(t, mustRead(t, s), 1, "alpha")
}

func TestReadBeforeAnyPublish(t *testing.T) {
	s := newStore(t)
	if _, err := s.Read(); !errors.Is(err, ErrNoCurrent) {
		t.Fatalf("Read err = %v, want ErrNoCurrent", err)
	}
}

func TestOldAttemptsRetained(t *testing.T) {
	s := newStore(t)
	mustPublish(t, s, "v1")
	mustPublish(t, s, "v2")
	v3 := mustPublish(t, s, "v3")

	assertSnapshot(t, mustRead(t, s), v3, "v3")

	// 旧尝试目录与材料全部保留。
	for _, v := range []uint64{1, 2, 3} {
		dir := s.attemptDir(v)
		if _, err := os.Stat(filepath.Join(dir, manifestName)); err != nil {
			t.Fatalf("attempt %d manifest missing: %v", v, err)
		}
		if _, err := os.Stat(filepath.Join(dir, "logs", "run.log")); err != nil {
			t.Fatalf("attempt %d log missing: %v", v, err)
		}
	}
	// 旧目录内容未被新版本污染。
	got, err := os.ReadFile(filepath.Join(s.attemptDir(1), "summary.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `{"tag":"v1"}` {
		t.Fatalf("attempt 1 summary = %q, want v1 content", got)
	}
}

// 在指针切换前的每个注入点制造故障：发布必须失败、指针不变、
// 读者仍看到上一次完整尝试；重跑必须使用全新版本目录，不混用旧文件。
func TestFaultBeforePointerSwitch(t *testing.T) {
	points := []string{
		FaultAfterAttemptDir,
		FaultAfterFiles,
		FaultAfterManifest,
		FaultAfterVerify,
		FaultBeforePointer,
	}
	for _, point := range points {
		t.Run(point, func(t *testing.T) {
			s := newStore(t)
			mustPublish(t, s, "good")

			s.Faults().FailOnce(point)
			if _, err := s.Publish(files("bad")); !errors.Is(err, ErrInjected) {
				t.Fatalf("Publish err = %v, want ErrInjected", err)
			}

			// 读者仍看到上一次完整尝试，内容未被混用。
			assertSnapshot(t, mustRead(t, s), 1, "good")

			// 重跑成功，使用新的版本号（失败尝试的目录不被复用）。
			v := mustPublish(t, s, "retry")
			if v != 3 {
				t.Fatalf("retry version = %d, want 3 (failed attempt dir not reused)", v)
			}
			assertSnapshot(t, mustRead(t, s), 3, "retry")

			// 失败尝试的残留目录即使存在，也从未被指针引用。
			cur, err := os.ReadFile(filepath.Join(s.dir, currentFileName))
			if err != nil {
				t.Fatal(err)
			}
			if n, _ := strconv.ParseUint(string(cur[:6]), 10, 64); n != 3 {
				t.Fatalf("current pointer = %d, want 3", n)
			}
		})
	}
}

// 指针切换后的注入故障：发布报错，但读者看到的是新的、单一且完整的尝试。
func TestFaultAfterPointerSwitch(t *testing.T) {
	s := newStore(t)
	mustPublish(t, s, "old")

	s.Faults().FailOnce(FaultAfterPointer)
	if _, err := s.Publish(files("new")); !errors.Is(err, ErrInjected) {
		t.Fatalf("Publish err = %v, want ErrInjected", err)
	}
	assertSnapshot(t, mustRead(t, s), 2, "new")
}

// 持续故障下多次重试：每次重试都是独立目录，清除故障后成功。
func TestPersistentFaultThenRecover(t *testing.T) {
	s := newStore(t)
	mustPublish(t, s, "base")

	s.Faults().Fail(FaultAfterFiles)
	for i := 0; i < 3; i++ {
		if _, err := s.Publish(files("attempt")); !errors.Is(err, ErrInjected) {
			t.Fatalf("Publish err = %v, want ErrInjected", err)
		}
	}
	assertSnapshot(t, mustRead(t, s), 1, "base")

	s.Faults().ClearAll()
	v := mustPublish(t, s, "final")
	if v != 5 { // 1 次成功 + 3 次失败各占一个版本目录
		t.Fatalf("version = %d, want 5", v)
	}
	assertSnapshot(t, mustRead(t, s), 5, "final")
}

func currentAttemptDir(t *testing.T, s *Store) string {
	t.Helper()
	snap := mustRead(t, s)
	return s.attemptDir(snap.Version)
}

func TestReaderDetectsCorruption(t *testing.T) {
	s := newStore(t)
	mustPublish(t, s, "data")
	dir := currentAttemptDir(t, s)

	if err := os.WriteFile(filepath.Join(dir, "data", "output.bin"), []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(); err == nil {
		t.Fatal("Read succeeded on corrupted attempt")
	}
}

func TestReaderDetectsMissingFile(t *testing.T) {
	s := newStore(t)
	mustPublish(t, s, "data")
	dir := currentAttemptDir(t, s)

	if err := os.Remove(filepath.Join(dir, "logs", "run.log")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(); err == nil {
		t.Fatal("Read succeeded with missing file")
	}
}

func TestReaderDetectsExtraFile(t *testing.T) {
	s := newStore(t)
	mustPublish(t, s, "data")
	dir := currentAttemptDir(t, s)

	if err := os.WriteFile(filepath.Join(dir, "stray.txt"), []byte("stray"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(); err == nil {
		t.Fatal("Read succeeded with extra file")
	}
}

func TestReaderDetectsVersionMismatch(t *testing.T) {
	s := newStore(t)
	mustPublish(t, s, "one")
	mustPublish(t, s, "two")
	// 把 v1 的清单放进 v2 目录，模拟跨尝试混用。
	m1, err := os.ReadFile(filepath.Join(s.attemptDir(1), manifestName))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.attemptDir(2), manifestName), m1, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(); err == nil {
		t.Fatal("Read succeeded with mismatched manifest version")
	}
}

func TestPublishRejectsBadPaths(t *testing.T) {
	s := newStore(t)
	for _, bad := range []string{"../escape", "/abs", "a/../b", manifestName, ""} {
		if _, err := s.Publish(map[string][]byte{bad: []byte("x")}); err == nil {
			t.Fatalf("Publish accepted path %q", bad)
		}
	}
	if _, err := s.Publish(map[string][]byte{"ok.txt": []byte("x"), "../bad": []byte("y")}); err == nil {
		t.Fatal("Publish accepted batch containing bad path")
	}
	// 全部校验失败发生在创建目录之前，版本号不被消耗。
	v := mustPublish(t, s, "clean")
	if v != 1 {
		t.Fatalf("version = %d, want 1 (bad publishes must not consume versions)", v)
	}
}

func TestPublishEmpty(t *testing.T) {
	s := newStore(t)
	if _, err := s.Publish(nil); err == nil {
		t.Fatal("Publish accepted empty file set")
	}
}
