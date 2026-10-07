package testiso

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newRunner(t *testing.T) (*Runner, string) {
	t.Helper()
	src := t.TempDir()
	runRoot := t.TempDir()
	return &Runner{SrcRoot: src, RunRoot: runRoot}, src
}

func TestRunCreatesIsolatedDirPerRun(t *testing.T) {
	r, src := newRunner(t)
	writeFile(t, filepath.Join(src, "a.txt"), "a")

	first, err := r.Run(Request{Task: "job", Manifest: []string{"a.txt"}})
	if err != nil {
		t.Fatal(err)
	}
	second, err := r.Run(Request{Task: "job", Manifest: []string{"a.txt"}})
	if err != nil {
		t.Fatal(err)
	}
	if first.Dir == second.Dir {
		t.Fatalf("runs share a directory: %s", first.Dir)
	}
	if first.Generation != 1 || second.Generation != 2 {
		t.Fatalf("generations = %d, %d; want 1, 2", first.Generation, second.Generation)
	}
	for _, res := range []*Result{first, second} {
		if _, err := os.Stat(filepath.Join(res.Dir, "inputs", "a.txt")); err != nil {
			t.Fatalf("run dir %s missing staged input: %v", res.Dir, err)
		}
		if _, err := os.Stat(filepath.Join(res.Dir, "tmp")); !os.IsNotExist(err) {
			t.Fatalf("tmp not cleaned after success in %s", res.Dir)
		}
	}
}

func TestCopiesOnlyManifestInputs(t *testing.T) {
	r, src := newRunner(t)
	writeFile(t, filepath.Join(src, "keep.txt"), "keep")
	writeFile(t, filepath.Join(src, "skip.txt"), "skip")
	writeFile(t, filepath.Join(src, "sub", "nested.txt"), "nested")

	res, err := r.Run(Request{Task: "job", Manifest: []string{"keep.txt", "sub/nested.txt"}})
	if err != nil {
		t.Fatal(err)
	}
	inputs := filepath.Join(res.Dir, "inputs")
	if got, _ := os.ReadFile(filepath.Join(inputs, "keep.txt")); string(got) != "keep" {
		t.Fatalf("keep.txt content = %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(inputs, "sub", "nested.txt")); string(got) != "nested" {
		t.Fatalf("nested.txt content = %q", got)
	}
	if _, err := os.Stat(filepath.Join(inputs, "skip.txt")); !os.IsNotExist(err) {
		t.Fatal("non-manifest file skip.txt was copied")
	}
}

func TestRejectsPathsEscapingRoot(t *testing.T) {
	r, src := newRunner(t)
	writeFile(t, filepath.Join(src, "ok.txt"), "ok")
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "secret.txt"), "secret")

	cases := map[string]string{
		"parent traversal": "../secret.txt",
		"deep traversal":   "sub/../../secret.txt",
		"absolute path":    filepath.Join(outside, "secret.txt"),
	}
	for name, entry := range cases {
		t.Run(name, func(t *testing.T) {
			res, err := r.Run(Request{Task: "job-" + strings.ReplaceAll(name, " ", "-"), Manifest: []string{entry}})
			if !errors.Is(err, ErrPathEscapesRoot) {
				t.Fatalf("err = %v; want ErrPathEscapesRoot", err)
			}
			if res == nil || res.Evidence == "" {
				t.Fatal("expected evidence for rejected run")
			}
		})
	}
}

func TestRejectsSymlinkPointingOutside(t *testing.T) {
	r, src := newRunner(t)
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "secret.txt"), "secret")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(src, "link.txt")); err != nil {
		t.Fatal(err)
	}

	_, err := r.Run(Request{Task: "job", Manifest: []string{"link.txt"}})
	if !errors.Is(err, ErrPathEscapesRoot) {
		t.Fatalf("err = %v; want ErrPathEscapesRoot", err)
	}
}

func TestAllowsSymlinkResolvingInsideRoot(t *testing.T) {
	r, src := newRunner(t)
	writeFile(t, filepath.Join(src, "real.txt"), "real")
	if err := os.Symlink("real.txt", filepath.Join(src, "link.txt")); err != nil {
		t.Fatal(err)
	}

	res, err := r.Run(Request{Task: "job", Manifest: []string{"link.txt"}})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(res.Dir, "inputs", "link.txt")); string(got) != "real" {
		t.Fatalf("link.txt content = %q; want %q", got, "real")
	}
}

var errInjected = errors.New("injected copy failure")

func TestCopyFailureKeepsEvidenceCleansTemp(t *testing.T) {
	r, src := newRunner(t)
	writeFile(t, filepath.Join(src, "good.txt"), "good")
	writeFile(t, filepath.Join(src, "bad.txt"), "bad")
	r.FS = ControlledAdapter{
		CopyFault: func(src, dst string) error {
			if strings.HasSuffix(src, "bad.txt") {
				return errInjected
			}
			return nil
		},
	}

	res, err := r.Run(Request{Task: "job", Manifest: []string{"good.txt", "bad.txt"}})
	if !errors.Is(err, errInjected) {
		t.Fatalf("err = %v; want injected failure", err)
	}
	if res == nil {
		t.Fatal("expected result describing failed run")
	}
	// Evidence is kept and names the failure.
	if res.Evidence == "" {
		t.Fatal("no evidence recorded")
	}
	log, err := os.ReadFile(res.Evidence)
	if err != nil {
		t.Fatalf("read evidence: %v", err)
	}
	if !strings.Contains(string(log), errInjected.Error()) {
		t.Fatalf("evidence log %q missing injected error", log)
	}
	// Non-evidence temp items are gone, even though bad.txt was staged there.
	if _, err := os.Stat(filepath.Join(res.Dir, "tmp")); !os.IsNotExist(err) {
		t.Fatal("tmp directory survived failed run")
	}
	// The successfully copied input remains as part of the run record.
	if _, err := os.Stat(filepath.Join(res.Dir, "inputs", "good.txt")); err != nil {
		t.Fatal("copied input missing from failed run")
	}
}

func TestParallelSameTaskGenerationalIsolation(t *testing.T) {
	r, src := newRunner(t)
	writeFile(t, filepath.Join(src, "a.txt"), "a")

	const workers = 16
	results := make([]*Result, workers)
	errs := make([]error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = r.Run(Request{Task: "shared", Manifest: []string{"a.txt"}})
		}(i)
	}
	wg.Wait()

	gens := make(map[int]string, workers)
	dirs := make(map[string]bool, workers)
	for i := 0; i < workers; i++ {
		if errs[i] != nil {
			t.Fatalf("run %d: %v", i, errs[i])
		}
		if prev, dup := gens[results[i].Generation]; dup {
			t.Fatalf("generation %d claimed by both %s and %s", results[i].Generation, prev, results[i].Dir)
		}
		gens[results[i].Generation] = results[i].Dir
		if dirs[results[i].Dir] {
			t.Fatalf("directory reused: %s", results[i].Dir)
		}
		dirs[results[i].Dir] = true
		if _, err := os.Stat(filepath.Join(results[i].Dir, "inputs", "a.txt")); err != nil {
			t.Fatalf("run %d missing input: %v", i, err)
		}
	}
}

func TestRejectsInvalidTaskNames(t *testing.T) {
	r, _ := newRunner(t)
	for _, task := range []string{"", ".", "..", "a/b", `a\b`, "../escape"} {
		if _, err := r.Run(Request{Task: task}); !errors.Is(err, ErrInvalidTask) {
			t.Fatalf("task %q: err = %v; want ErrInvalidTask", task, err)
		}
	}
}

func TestRejectsNonRegularManifestEntry(t *testing.T) {
	r, src := newRunner(t)
	if err := os.MkdirAll(filepath.Join(src, "adir"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := r.Run(Request{Task: "job", Manifest: []string{"adir"}})
	if err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("err = %v; want not-a-regular-file", err)
	}
}

func TestLoadManifest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manifest.txt")
	writeFile(t, path, "# comment\n\na.txt\n  sub/b.txt  \n")
	got, err := LoadManifest(path)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"a.txt", "sub/b.txt"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("LoadManifest = %v; want %v", got, want)
	}
}
