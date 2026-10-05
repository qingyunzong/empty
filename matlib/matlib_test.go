package matlib

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
)

func newStore(t *testing.T, hooks *Hooks) *Store {
	t.Helper()
	s, err := NewStore(filepath.Join(t.TempDir(), "lib"), hooks)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s
}

func mustBegin(t *testing.T, s *Store) *Attempt {
	t.Helper()
	a, err := s.Begin()
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	return a
}

func writeAttempt(t *testing.T, a *Attempt, tag string) {
	t.Helper()
	if err := a.WriteFile("data/output.txt", []byte("output-"+tag)); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := a.WriteLog("run.log", []byte("log-"+tag)); err != nil {
		t.Fatalf("WriteLog: %v", err)
	}
	if err := a.WriteSummary([]byte(`{"tag":"` + tag + `"}`)); err != nil {
		t.Fatalf("WriteSummary: %v", err)
	}
}

func mustPublish(t *testing.T, a *Attempt) {
	t.Helper()
	if err := a.Publish(); err != nil {
		t.Fatalf("Publish: %v", err)
	}
}

// A failed rerun must not reuse or mix logs, summaries, or files from the
// previous attempt: every attempt gets a fresh, isolated directory.
func TestRerunDoesNotMixPreviousAttempt(t *testing.T) {
	s := newStore(t, nil)

	a1 := mustBegin(t, s)
	writeAttempt(t, a1, "v1")
	if err := a1.WriteFile("data/extra.bin", []byte("stale-extra")); err != nil {
		t.Fatal(err)
	}
	// Attempt 1 fails: never published.

	a2 := mustBegin(t, s)
	if a2.Version() == a1.Version() {
		t.Fatalf("rerun reused version %d", a2.Version())
	}
	if a2.Dir() == a1.Dir() {
		t.Fatalf("rerun reused directory %s", a2.Dir())
	}
	// The rerun's directory must not contain anything from attempt 1.
	for _, name := range []string{"data/output.txt", "data/extra.bin", "logs/run.log", "summary.json"} {
		if _, err := os.Stat(filepath.Join(a2.Dir(), filepath.FromSlash(name))); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("rerun directory contains %q from previous attempt (err=%v)", name, err)
		}
	}

	writeAttempt(t, a2, "v2")
	mustPublish(t, a2)

	mat, err := s.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if mat.Version != a2.Version() {
		t.Fatalf("reader got version %d, want %d", mat.Version, a2.Version())
	}
	if _, ok := mat.Files["data/extra.bin"]; ok {
		t.Fatal("reader sees stale file from failed attempt")
	}
	if got := string(mat.Files["logs/run.log"]); got != "log-v2" {
		t.Fatalf("reader sees log %q, want %q", got, "log-v2")
	}
	if got := string(mat.Files["summary.json"]); got != `{"tag":"v2"}` {
		t.Fatalf("reader sees summary %q, want v2 summary", got)
	}
}

// Fault injection at every publish point before the pointer switch: the
// publish fails, the current pointer stays on the previous complete attempt,
// and the failed attempt's directory is retained.
func TestPublishFaultInjectionKeepsPreviousCurrent(t *testing.T) {
	points := []struct {
		name string
		set  func(h *Hooks, failOn uint64, err error)
	}{
		{"BeforeManifestWrite", func(h *Hooks, v uint64, err error) {
			h.BeforeManifestWrite = func(got uint64) error {
				if got == v {
					return err
				}
				return nil
			}
		}},
		{"BeforeVerify", func(h *Hooks, v uint64, err error) {
			h.BeforeVerify = func(got uint64) error {
				if got == v {
					return err
				}
				return nil
			}
		}},
		{"BeforePointerSwitch", func(h *Hooks, v uint64, err error) {
			h.BeforePointerSwitch = func(got uint64) error {
				if got == v {
					return err
				}
				return nil
			}
		}},
	}
	for _, p := range points {
		t.Run(p.name, func(t *testing.T) {
			injected := errors.New("injected fault at " + p.name)
			hooks := &Hooks{}
			s := newStore(t, hooks)

			good := mustBegin(t, s)
			writeAttempt(t, good, "good")
			mustPublish(t, good)

			p.set(hooks, good.Version()+1, injected)
			bad := mustBegin(t, s)
			writeAttempt(t, bad, "bad")
			if err := bad.Publish(); !errors.Is(err, injected) {
				t.Fatalf("Publish error = %v, want injected fault", err)
			}

			cur, err := s.CurrentVersion()
			if err != nil {
				t.Fatalf("CurrentVersion: %v", err)
			}
			if cur != good.Version() {
				t.Fatalf("current pointer moved to %d after failed publish, want %d", cur, good.Version())
			}
			mat, err := s.Read()
			if err != nil {
				t.Fatalf("Read: %v", err)
			}
			if mat.Version != good.Version() || string(mat.Files["data/output.txt"]) != "output-good" {
				t.Fatalf("reader sees version %d files %v, want complete good attempt", mat.Version, keys(mat.Files))
			}
			// Failed attempt retained on disk for inspection.
			if _, err := os.Stat(bad.Dir()); err != nil {
				t.Fatalf("failed attempt directory not retained: %v", err)
			}
		})
	}
}

// A fault after the pointer switch (e.g. crash during cleanup) is reported,
// but readers still see exactly one complete attempt: the new one.
func TestFaultAfterPointerSwitch(t *testing.T) {
	injected := errors.New("injected post-switch fault")
	hooks := &Hooks{AfterPointerSwitch: func(uint64) error { return injected }}
	s := newStore(t, hooks)

	a := mustBegin(t, s)
	writeAttempt(t, a, "v1")
	if err := a.Publish(); !errors.Is(err, injected) {
		t.Fatalf("Publish error = %v, want injected fault", err)
	}
	mat, err := s.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if mat.Version != a.Version() || string(mat.Files["data/output.txt"]) != "output-v1" {
		t.Fatalf("reader sees inconsistent material: version %d files %v", mat.Version, keys(mat.Files))
	}
}

// If a file is corrupted on disk after writing but before publish,
// verification fails and the pointer never moves.
func TestCorruptionBeforePublishBlocksSwitch(t *testing.T) {
	s := newStore(t, nil)

	good := mustBegin(t, s)
	writeAttempt(t, good, "good")
	mustPublish(t, good)

	bad := mustBegin(t, s)
	writeAttempt(t, bad, "bad")
	corruptFile(t, filepath.Join(bad.Dir(), "data", "output.txt"))

	if err := bad.Publish(); err == nil {
		t.Fatal("Publish succeeded despite corrupted file")
	}
	if cur, _ := s.CurrentVersion(); cur != good.Version() {
		t.Fatalf("current pointer moved to %d, want %d", cur, good.Version())
	}
}

// If the current attempt's files are corrupted after publishing, readers get
// an error instead of partial or mixed material.
func TestReaderRejectsCorruptedCurrent(t *testing.T) {
	s := newStore(t, nil)

	a1 := mustBegin(t, s)
	writeAttempt(t, a1, "v1")
	mustPublish(t, a1)
	a2 := mustBegin(t, s)
	writeAttempt(t, a2, "v2")
	mustPublish(t, a2)

	corruptFile(t, filepath.Join(a2.Dir(), "logs", "run.log"))
	if _, err := s.Read(); err == nil {
		t.Fatal("Read succeeded despite corrupted current attempt")
	}
	// The intact older attempt is still readable on its own.
	mat, err := s.ReadVersion(a1.Version())
	if err != nil {
		t.Fatalf("ReadVersion(v1): %v", err)
	}
	if string(mat.Files["data/output.txt"]) != "output-v1" {
		t.Fatalf("v1 material = %q, want output-v1", mat.Files["data/output.txt"])
	}
}

// Old attempts are retained and individually readable; the current pointer
// always refers to the latest complete attempt.
func TestOldAttemptsRetained(t *testing.T) {
	s := newStore(t, nil)
	var versions []uint64
	for i := 1; i <= 3; i++ {
		a := mustBegin(t, s)
		writeAttempt(t, a, "v"+strconv.Itoa(i))
		mustPublish(t, a)
		versions = append(versions, a.Version())
	}

	got, err := s.Versions()
	if err != nil {
		t.Fatalf("Versions: %v", err)
	}
	if !reflect.DeepEqual(got, versions) {
		t.Fatalf("Versions = %v, want %v", got, versions)
	}
	for i, v := range versions {
		mat, err := s.ReadVersion(v)
		if err != nil {
			t.Fatalf("ReadVersion(%d): %v", v, err)
		}
		want := fmt.Sprintf("output-v%d", i+1)
		if string(mat.Files["data/output.txt"]) != want {
			t.Fatalf("attempt %d output = %q, want %q", v, mat.Files["data/output.txt"], want)
		}
	}
	if cur, _ := s.CurrentVersion(); cur != versions[len(versions)-1] {
		t.Fatalf("current = %d, want %d", cur, versions[len(versions)-1])
	}
}

// Readers never observe a half-published attempt: while a publish is in
// flight they keep reading the previous complete attempt, and afterwards
// exactly the new one.
func TestReaderSeesSingleCompleteAttempt(t *testing.T) {
	release := make(chan struct{})
	hooks := &Hooks{BeforePointerSwitch: func(v uint64) error {
		if v != 2 {
			return nil
		}
		<-release // hold the publish between verification and pointer switch
		return nil
	}}
	s := newStore(t, hooks)

	a1 := mustBegin(t, s)
	writeAttempt(t, a1, "v1")
	mustPublish(t, a1)

	a2 := mustBegin(t, s)
	writeAttempt(t, a2, "v2")
	done := make(chan error, 1)
	go func() { done <- a2.Publish() }()

	// While v2 is mid-publish, readers still get complete v1.
	for i := 0; i < 5; i++ {
		mat, err := s.Read()
		if err != nil {
			t.Fatalf("Read during publish: %v", err)
		}
		if mat.Version != a1.Version() || string(mat.Files["data/output.txt"]) != "output-v1" {
			t.Fatalf("reader saw version %d files %v during publish", mat.Version, keys(mat.Files))
		}
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("Publish: %v", err)
	}

	mat, err := s.Read()
	if err != nil {
		t.Fatalf("Read after publish: %v", err)
	}
	if mat.Version != a2.Version() || string(mat.Files["data/output.txt"]) != "output-v2" {
		t.Fatalf("reader saw version %d files %v after publish", mat.Version, keys(mat.Files))
	}
}

func TestReadBeforeAnyPublish(t *testing.T) {
	s := newStore(t, nil)
	if _, err := s.Read(); !errors.Is(err, ErrNoCurrent) {
		t.Fatalf("Read error = %v, want ErrNoCurrent", err)
	}
}

func TestVersionsAreMonotonicAndUnique(t *testing.T) {
	s := newStore(t, nil)
	seen := map[uint64]bool{}
	for i := 0; i < 10; i++ {
		a := mustBegin(t, s)
		if seen[a.Version()] {
			t.Fatalf("duplicate version %d", a.Version())
		}
		seen[a.Version()] = true
		if want := uint64(i + 1); a.Version() != want {
			t.Fatalf("version = %d, want %d", a.Version(), want)
		}
	}
}

func corruptFile(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("corrupted"), 0o644); err != nil {
		t.Fatalf("corrupt %s: %v", path, err)
	}
}

func keys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
