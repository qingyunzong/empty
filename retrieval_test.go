package dualidx_test

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"unicode"

	"dualidx"
)

// --- ground-truth helpers: independent raw scans of the source files ---

func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func rawTokens(content string) []string {
	return strings.FieldsFunc(strings.ToLower(content), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	})
}

func rawPaths(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			rel, err := filepath.Rel(root, p)
			if err != nil {
				return err
			}
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

// equalStrs compares two sorted string slices, treating nil and empty as equal.
func equalStrs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func rawSearch(t *testing.T, root, term string) []string {
	t.Helper()
	term = strings.ToLower(term)
	var out []string
	for _, rel := range rawPaths(t, root) {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatal(err)
		}
		for _, tok := range rawTokens(string(data)) {
			if tok == term {
				out = append(out, rel)
				break
			}
		}
	}
	sort.Strings(out)
	return out
}

func genDirs(t *testing.T, storeDir string) []string {
	t.Helper()
	entries, err := os.ReadDir(storeDir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "gen-") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

var corpusV1 = map[string]string{
	"docs/a.txt":       "the quick brown fox jumps over the lazy dog",
	"docs/b.txt":       "sphinx of black quartz, judge my vow",
	"docs/nested/c.md": "Quick! Quick brown foxes; quartz quartz.",
	"README":           "dual index retrieval library",
}

var corpusV2 = map[string]string{
	"docs/a.txt":       "the quick brown fox jumps over the lazy cat",
	"docs/d.txt":       "entirely new document about retrieval and quartz",
	"docs/nested/c.md": "Quick! Quick brown foxes; quartz quartz.",
	// docs/b.txt deleted, README deleted
}

func newStore(t *testing.T) (*dualidx.Store, *dualidx.FaultInjector, string) {
	t.Helper()
	fj := dualidx.NewFaultInjector()
	dir := t.TempDir()
	s, err := dualidx.OpenStore(dir, fj)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, fj, dir
}

// --- tests ---

func TestQueryMatchesRawScan(t *testing.T) {
	src := t.TempDir()
	writeFiles(t, src, corpusV1)

	s, _, _ := newStore(t)
	if err := s.Rebuild(src); err != nil {
		t.Fatal(err)
	}
	v, err := s.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()

	if got, want := v.Paths(), rawPaths(t, src); !equalStrs(got, want) {
		t.Errorf("Paths() = %v, raw scan = %v", got, want)
	}
	for _, p := range rawPaths(t, src) {
		if _, ok := v.Lookup(p); !ok {
			t.Errorf("Lookup(%q) not found", p)
		}
	}
	if _, ok := v.Lookup("docs/missing.txt"); ok {
		t.Error("Lookup found nonexistent path")
	}

	terms := []string{"quick", "QUARTZ", "fox", "judge", "retrieval", "absent-term", "the"}
	for _, term := range terms {
		got := v.Search(term)
		want := rawSearch(t, src, term)
		if !equalStrs(got, want) {
			t.Errorf("Search(%q) = %v, raw scan = %v", term, got, want)
		}
	}
}

func TestBatchUpdateReadersSeeSameGeneration(t *testing.T) {
	src := t.TempDir()
	writeFiles(t, src, corpusV1)

	s, _, _ := newStore(t)
	if err := s.Rebuild(src); err != nil {
		t.Fatal(err)
	}

	oldView, err := s.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	defer oldView.Close()

	// Batch update: modify a.txt, delete b.txt + README, add d.txt.
	if err := os.RemoveAll(src); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, src, corpusV2)
	if err := s.Rebuild(src); err != nil {
		t.Fatal(err)
	}

	newView, err := s.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	defer newView.Close()

	if oldView.Generation() == newView.Generation() {
		t.Fatalf("both views on generation %d", oldView.Generation())
	}

	// The old view still answers from the old generation for both indexes.
	if got := oldView.Search("judge"); !equalStrs(got, []string{"docs/b.txt"}) {
		t.Errorf("old view Search(judge) = %v", got)
	}
	if _, ok := oldView.Lookup("README"); !ok {
		t.Error("old view lost README")
	}
	// Cross-index consistency inside the old generation: every content hit
	// must resolve through the same generation's path index.
	for _, p := range oldView.Search("quick") {
		if _, ok := oldView.Lookup(p); !ok {
			t.Errorf("old view: content hit %q missing from path index", p)
		}
	}

	// The new view matches a raw scan of the updated corpus.
	for _, term := range []string{"cat", "dog", "judge", "retrieval", "quartz"} {
		if got, want := newView.Search(term), rawSearch(t, src, term); !equalStrs(got, want) {
			t.Errorf("new view Search(%q) = %v, raw scan = %v", term, got, want)
		}
	}
	if got, want := newView.Paths(), rawPaths(t, src); !equalStrs(got, want) {
		t.Errorf("new view Paths() = %v, raw scan = %v", got, want)
	}
}

func TestBuildFailuresKeepOldGeneration(t *testing.T) {
	cases := []struct {
		name   string
		inject func(fj *dualidx.FaultInjector)
	}{
		{"persist content index", func(fj *dualidx.FaultInjector) { fj.SetPersistContentFail(true) }},
		{"persist path index", func(fj *dualidx.FaultInjector) { fj.SetPersistPathFail(true) }},
		{"publish", func(fj *dualidx.FaultInjector) { fj.SetPublishFail(true) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := t.TempDir()
			writeFiles(t, src, corpusV1)

			s, fj, storeDir := newStore(t)
			if err := s.Rebuild(src); err != nil {
				t.Fatal(err)
			}
			genBefore := s.Generation()

			// Update the corpus, then rebuild with the fault armed.
			writeFiles(t, src, corpusV2)
			tc.inject(fj)
			err := s.Rebuild(src)
			if !errors.Is(err, dualidx.ErrInjected) {
				t.Fatalf("Rebuild error = %v, want ErrInjected", err)
			}

			// The old generation stays published and fully queryable.
			if got := s.Generation(); got != genBefore {
				t.Errorf("generation moved to %d despite failed build", got)
			}
			v, err := s.Acquire()
			if err != nil {
				t.Fatal(err)
			}
			defer v.Close()
			if got := v.Search("judge"); !equalStrs(got, []string{"docs/b.txt"}) {
				t.Errorf("Search(judge) after failed build = %v", got)
			}
			if got := v.Paths(); !equalStrs(got, rawPathsFrom(corpusV1)) {
				t.Errorf("Paths() after failed build = %v", got)
			}

			// The failed generation left no files behind.
			if dirs := genDirs(t, storeDir); !reflect.DeepEqual(dirs, []string{fmt.Sprintf("gen-%06d", genBefore)}) {
				t.Errorf("leftover generation dirs %v", dirs)
			}

			// After disarming the fault, a rebuild publishes the new corpus.
			fj.SetPersistContentFail(false)
			fj.SetPersistPathFail(false)
			fj.SetPublishFail(false)
			if err := s.Rebuild(src); err != nil {
				t.Fatal(err)
			}
			v2, err := s.Acquire()
			if err != nil {
				t.Fatal(err)
			}
			defer v2.Close()
			if got, want := v2.Search("cat"), rawSearch(t, src, "cat"); !equalStrs(got, want) {
				t.Errorf("Search(cat) after recovery = %v, raw scan = %v", got, want)
			}
		})
	}
}

func rawPathsFrom(files map[string]string) []string {
	out := make([]string, 0, len(files))
	for p := range files {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

func TestOldGenerationFilesDeletedAfterReaderRelease(t *testing.T) {
	src := t.TempDir()
	writeFiles(t, src, corpusV1)

	s, _, storeDir := newStore(t)
	if err := s.Rebuild(src); err != nil {
		t.Fatal(err)
	}
	gen1Dir := filepath.Join(storeDir, "gen-000001")

	v, err := s.Acquire()
	if err != nil {
		t.Fatal(err)
	}

	// Publish a new generation while a reader still holds the old one.
	writeFiles(t, src, corpusV2)
	if err := s.Rebuild(src); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(gen1Dir); err != nil {
		t.Errorf("gen-1 files removed while reader active: %v", err)
	}
	if got := v.Search("judge"); !equalStrs(got, []string{"docs/b.txt"}) {
		t.Errorf("held view Search(judge) = %v", got)
	}

	// Releasing the last reader deletes the retired generation's files.
	if err := v.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(gen1Dir); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("gen-1 files still present after release, stat err = %v", err)
	}
	if dirs := genDirs(t, storeDir); !reflect.DeepEqual(dirs, []string{"gen-000002"}) {
		t.Errorf("generation dirs = %v, want only gen-000002", dirs)
	}
}

func TestReopenStoreFromDisk(t *testing.T) {
	src := t.TempDir()
	writeFiles(t, src, corpusV1)

	fj := dualidx.NewFaultInjector()
	dir := t.TempDir()
	s, err := dualidx.OpenStore(dir, fj)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Rebuild(src); err != nil {
		t.Fatal(err)
	}
	s.Close()

	// Reopen: the published generation is reloaded purely from disk.
	s2, err := dualidx.OpenStore(dir, fj)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	v, err := s2.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	for _, term := range []string{"quick", "quartz", "retrieval"} {
		if got, want := v.Search(term), rawSearch(t, src, term); !equalStrs(got, want) {
			t.Errorf("reopened Search(%q) = %v, raw scan = %v", term, got, want)
		}
	}
	if got, want := v.Paths(), rawPaths(t, src); !equalStrs(got, want) {
		t.Errorf("reopened Paths() = %v, raw scan = %v", got, want)
	}
}

func TestConcurrentReadersAndWriter(t *testing.T) {
	src := t.TempDir()
	writeFiles(t, src, corpusV1)

	s, _, _ := newStore(t)
	if err := s.Rebuild(src); err != nil {
		t.Fatal(err)
	}

	writeCorpus := func(corpus map[string]string) error {
		if err := os.RemoveAll(src); err != nil {
			return err
		}
		if err := os.MkdirAll(src, 0o755); err != nil {
			return err
		}
		for name, content := range corpus {
			p := filepath.Join(src, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
				return err
			}
		}
		return nil
	}

	stop := make(chan struct{})
	writerDone := make(chan error, 1)

	// Writer: keep flipping the corpus between the two versions.
	go func() {
		for i := 0; ; i++ {
			select {
			case <-stop:
				writerDone <- nil
				return
			default:
			}
			corpus := corpusV1
			if i%2 == 1 {
				corpus = corpusV2
			}
			if err := writeCorpus(corpus); err != nil {
				writerDone <- err
				return
			}
			if err := s.Rebuild(src); err != nil && !errors.Is(err, dualidx.ErrClosed) {
				writerDone <- err
				return
			}
		}
	}()

	// Readers: every view must be internally consistent across both indexes.
	var readers sync.WaitGroup
	for r := 0; r < 8; r++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for i := 0; i < 200; i++ {
				v, err := s.Acquire()
				if err != nil {
					return
				}
				inPaths := make(map[string]bool)
				for _, p := range v.Paths() {
					inPaths[p] = true
					if _, ok := v.Lookup(p); !ok {
						t.Errorf("gen %d: Paths() entry %q missing from Lookup", v.Generation(), p)
					}
				}
				for _, term := range []string{"quick", "quartz", "judge", "cat", "retrieval"} {
					for _, p := range v.Search(term) {
						if !inPaths[p] {
							t.Errorf("gen %d: content hit %q not in path index", v.Generation(), p)
						}
					}
				}
				v.Close()
			}
		}()
	}

	readers.Wait()
	close(stop)
	if err := <-writerDone; err != nil {
		t.Fatalf("writer: %v", err)
	}
}
