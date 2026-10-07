package runtool

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func writeHostFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readHostFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func newRunner(t *testing.T, fsys FS) *Runner {
	t.Helper()
	runner, err := NewRunner(filepath.Join(t.TempDir(), "runs"), fsys)
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

func TestStageInputsCopiesOnlyManifest(t *testing.T) {
	src := t.TempDir()
	writeHostFile(t, filepath.Join(src, "a.txt"), "alpha")
	writeHostFile(t, filepath.Join(src, "sub", "c.txt"), "charlie")
	writeHostFile(t, filepath.Join(src, "extra.txt"), "not-listed")

	runner := newRunner(t, nil)
	run, err := runner.Start("task")
	if err != nil {
		t.Fatal(err)
	}
	if err := run.StageInputs(src, []string{"a.txt", "sub/c.txt"}); err != nil {
		t.Fatal(err)
	}

	if got := readHostFile(t, filepath.Join(run.InputsDir(), "a.txt")); got != "alpha" {
		t.Errorf("a.txt content = %q", got)
	}
	if got := readHostFile(t, filepath.Join(run.InputsDir(), "sub", "c.txt")); got != "charlie" {
		t.Errorf("sub/c.txt content = %q", got)
	}
	if _, err := os.Stat(filepath.Join(run.InputsDir(), "extra.txt")); !os.IsNotExist(err) {
		t.Errorf("unlisted file extra.txt must not be staged (stat err = %v)", err)
	}
}

func TestStageInputsRejectsEscapingPaths(t *testing.T) {
	src := t.TempDir()
	writeHostFile(t, filepath.Join(src, "a.txt"), "alpha")

	runner := newRunner(t, nil)
	for _, entry := range []string{
		"../escape.txt",
		"sub/../../escape.txt",
		"..",
		"/etc/passwd",
	} {
		run, err := runner.Start("escape")
		if err != nil {
			t.Fatal(err)
		}
		if err := run.StageInputs(src, []string{entry}); err == nil {
			t.Errorf("manifest entry %q must be rejected", entry)
		}
	}
}

func TestStageInputsRejectsSymlinkEscapingRoot(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	writeHostFile(t, filepath.Join(base, "secret.txt"), "secret")
	if err := os.Symlink(filepath.Join(base, "secret.txt"), filepath.Join(src, "abs-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../secret.txt", filepath.Join(src, "rel-link")); err != nil {
		t.Fatal(err)
	}

	runner := newRunner(t, nil)
	for _, entry := range []string{"abs-link", "rel-link"} {
		run, err := runner.Start("links")
		if err != nil {
			t.Fatal(err)
		}
		if err := run.StageInputs(src, []string{entry}); err == nil {
			t.Errorf("symlink %q pointing outside the source root must be rejected", entry)
		}
	}
}

func TestStageInputsRejectsSymlinkInsideCopiedDir(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "src")
	writeHostFile(t, filepath.Join(src, "sub", "ok.txt"), "fine")
	writeHostFile(t, filepath.Join(base, "secret.txt"), "secret")
	if err := os.Symlink(filepath.Join(base, "secret.txt"), filepath.Join(src, "sub", "bad")); err != nil {
		t.Fatal(err)
	}

	runner := newRunner(t, nil)
	run, err := runner.Start("dirlink")
	if err != nil {
		t.Fatal(err)
	}
	if err := run.StageInputs(src, []string{"sub"}); err == nil {
		t.Error("symlink escaping the root inside a copied directory must be rejected")
	}
}

func TestStageInputsAllowsInternalSymlink(t *testing.T) {
	src := t.TempDir()
	writeHostFile(t, filepath.Join(src, "real.txt"), "inside")
	if err := os.Symlink("real.txt", filepath.Join(src, "link.txt")); err != nil {
		t.Fatal(err)
	}

	runner := newRunner(t, nil)
	run, err := runner.Start("oklink")
	if err != nil {
		t.Fatal(err)
	}
	if err := run.StageInputs(src, []string{"link.txt"}); err != nil {
		t.Fatal(err)
	}
	if got := readHostFile(t, filepath.Join(run.InputsDir(), "link.txt")); got != "inside" {
		t.Errorf("link.txt content = %q", got)
	}
}

func TestGenerationalIsolationSequential(t *testing.T) {
	runner := newRunner(t, nil)
	first, err := runner.Start("build")
	if err != nil {
		t.Fatal(err)
	}
	second, err := runner.Start("build")
	if err != nil {
		t.Fatal(err)
	}
	other, err := runner.Start("other")
	if err != nil {
		t.Fatal(err)
	}

	if first.Dir == second.Dir {
		t.Fatalf("same-name runs share a directory: %s", first.Dir)
	}
	if first.Generation != 0 || second.Generation != 1 {
		t.Errorf("generations = %d, %d; want 0, 1", first.Generation, second.Generation)
	}
	if other.Generation != 0 {
		t.Errorf("different task name must start its own generation line, got %d", other.Generation)
	}
	for _, run := range []*Run{first, second, other} {
		if _, err := os.Stat(run.Dir); err != nil {
			t.Errorf("run dir %s missing: %v", run.Dir, err)
		}
	}
}

func TestGenerationalIsolationParallel(t *testing.T) {
	runner := newRunner(t, nil)
	const n = 16
	dirs := make(chan string, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			run, err := runner.Start("parallel")
			if err != nil {
				t.Error(err)
				return
			}
			dirs <- run.Dir
		}()
	}
	wg.Wait()
	close(dirs)

	seen := make(map[string]bool, n)
	count := 0
	for dir := range dirs {
		if seen[dir] {
			t.Fatalf("parallel runs share a directory: %s", dir)
		}
		seen[dir] = true
		count++
		if _, err := os.Stat(dir); err != nil {
			t.Errorf("run dir %s missing: %v", dir, err)
		}
	}
	if count != n {
		t.Fatalf("got %d run dirs, want %d", count, n)
	}
}

func TestFinishSuccessRemovesRunDir(t *testing.T) {
	runner := newRunner(t, nil)
	run, err := runner.Start("success")
	if err != nil {
		t.Fatal(err)
	}
	writeHostFile(t, filepath.Join(run.WorkDir(), "scratch.tmp"), "junk")
	writeHostFile(t, filepath.Join(run.EvidenceDir(), "note.txt"), "clue")

	if err := run.Finish(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(run.Dir); !os.IsNotExist(err) {
		t.Errorf("run dir must be removed on success (stat err = %v)", err)
	}
}

func TestFinishFailureKeepsEvidenceCleansTemporaries(t *testing.T) {
	runner := newRunner(t, nil)
	run, err := runner.Start("failure")
	if err != nil {
		t.Fatal(err)
	}
	writeHostFile(t, filepath.Join(run.EvidenceDir(), "note.txt"), "clue")
	writeHostFile(t, filepath.Join(run.WorkDir(), "scratch.tmp"), "junk")

	if err := run.Finish(errors.New("boom")); err != nil {
		t.Fatal(err)
	}

	if got := readHostFile(t, filepath.Join(run.EvidenceDir(), "note.txt")); got != "clue" {
		t.Errorf("evidence note.txt content = %q", got)
	}
	marker := readHostFile(t, filepath.Join(run.EvidenceDir(), "FAILURE.txt"))
	if !strings.Contains(marker, "boom") {
		t.Errorf("FAILURE.txt must record the cause, got:\n%s", marker)
	}
	if _, err := os.Stat(run.WorkDir()); !os.IsNotExist(err) {
		t.Errorf("non-evidence temporaries must be cleaned (stat err = %v)", err)
	}
}

// failCreateFS is a controlled adapter that injects copy failures only for
// designated destination paths; everything else delegates to the real FS.
type failCreateFS struct {
	FS
	mu      sync.Mutex
	targets map[string]bool
}

func (f *failCreateFS) Create(path string) (io.WriteCloser, error) {
	f.mu.Lock()
	hit := f.targets[path]
	f.mu.Unlock()
	if hit {
		return nil, errors.New("injected create failure")
	}
	return f.FS.Create(path)
}

func TestStageInputsCopyFailureInjection(t *testing.T) {
	src := t.TempDir()
	writeHostFile(t, filepath.Join(src, "a.txt"), "data")

	fsys := &failCreateFS{FS: OSFS{}, targets: map[string]bool{}}
	runner := newRunner(t, fsys)
	run, err := runner.Start("job")
	if err != nil {
		t.Fatal(err)
	}

	fsys.targets[filepath.Join(run.InputsDir(), "a.txt")] = true
	stageErr := run.StageInputs(src, []string{"a.txt"})
	if stageErr == nil {
		t.Fatal("expected the injected copy failure to surface")
	}
	if !strings.Contains(stageErr.Error(), "injected create failure") {
		t.Errorf("error = %v, want it to wrap the injected failure", stageErr)
	}

	writeHostFile(t, filepath.Join(run.WorkDir(), "scratch.tmp"), "junk")
	if err := run.Finish(stageErr); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(run.EvidenceDir(), "FAILURE.txt")); err != nil {
		t.Errorf("evidence must be preserved after copy failure: %v", err)
	}
	if _, err := os.Stat(run.WorkDir()); !os.IsNotExist(err) {
		t.Errorf("non-evidence temporaries must be cleaned (stat err = %v)", err)
	}
}

func TestInvalidTaskNames(t *testing.T) {
	runner := newRunner(t, nil)
	for _, name := range []string{"", ".", "..", "a/b", `a\b`, "/abs"} {
		if _, err := runner.Start(name); err == nil {
			t.Errorf("task name %q must be rejected", name)
		}
	}
}
