package dualindex

import (
	"errors"
	"fmt"
	"io/fs"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"unicode"
)

// tokenizeForTest is an independent reimplementation of the library
// tokenizer, used to build ground truth from raw files.
func tokenizeForTest(s string) []string {
	var toks []string
	var cur []rune
	flush := func() {
		if len(cur) > 0 {
			toks = append(toks, string(cur))
			cur = nil
		}
	}
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			cur = append(cur, r)
		} else {
			flush()
		}
	}
	flush()
	return toks
}

func writeCorpus(t *testing.T, root string, files map[string]string) {
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

// readCorpus scans raw files from disk into an update batch.
func readCorpus(t *testing.T, root string) []File {
	t.Helper()
	var files []File
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files = append(files, File{Path: filepath.ToSlash(rel), Content: b})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files
}

// scanTerms builds the ground-truth term -> paths mapping by scanning raw
// document contents.
func scanTerms(docs map[string][]byte) map[string]map[string]bool {
	out := make(map[string]map[string]bool)
	for path, content := range docs {
		for _, tok := range tokenizeForTest(string(content)) {
			if out[tok] == nil {
				out[tok] = make(map[string]bool)
			}
			out[tok][path] = true
		}
	}
	return out
}

// checkAgainstDocs verifies a snapshot against a raw scan of docs.
func checkAgainstDocs(t *testing.T, sn *Snapshot, docs map[string][]byte) {
	t.Helper()
	want := scanTerms(docs)

	if got := sn.Terms(); len(got) != len(want) {
		t.Errorf("gen %d: term count = %d, want %d", sn.Gen(), len(got), len(want))
	}
	for term, pathSet := range want {
		var wantPaths []string
		for p := range pathSet {
			wantPaths = append(wantPaths, p)
		}
		sort.Strings(wantPaths)
		if got := sn.Query(term); !reflect.DeepEqual(got, wantPaths) {
			t.Errorf("gen %d: Query(%q) = %v, want %v", sn.Gen(), term, got, wantPaths)
		}
	}
	for _, bogus := range []string{"zzznoterm", "qxqx42"} {
		if got := sn.Query(bogus); len(got) != 0 {
			t.Errorf("gen %d: Query(%q) = %v, want empty", sn.Gen(), bogus, got)
		}
	}
	for path, content := range docs {
		e, ok := sn.Stat(path)
		if !ok {
			t.Errorf("gen %d: Stat(%q) missing", sn.Gen(), path)
			continue
		}
		if e.Size != int64(len(content)) {
			t.Errorf("gen %d: Stat(%q).Size = %d, want %d", sn.Gen(), path, e.Size, len(content))
		}
		if want := len(tokenizeForTest(string(content))); e.Terms != want {
			t.Errorf("gen %d: Stat(%q).Terms = %d, want %d", sn.Gen(), path, e.Terms, want)
		}
	}
}

func generationDirs(t *testing.T, storeDir string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(storeDir, "generations"))
	if err != nil {
		t.Fatal(err)
	}
	var dirs []string
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	sort.Strings(dirs)
	return dirs
}

func TestQueryMatchesRawScan(t *testing.T) {
	corpus := t.TempDir()
	files := map[string]string{
		"a.txt":              "The quick brown fox jumps over the lazy dog",
		"sub/b.txt":          "quick quick hare; fox and hound",
		"sub/deep/c.txt":     "lazy dog naps. Dog years, foxtrot!",
		"sub/deep/d.md":      "Foxtrot 42: a hare, a hound, 7 dogs",
		"notes/todo list.md": "dog dog dog",
	}
	writeCorpus(t, corpus, files)

	store, err := Open(filepath.Join(t.TempDir(), "idx"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Update(Batch{Put: readCorpus(t, corpus)}); err != nil {
		t.Fatal(err)
	}

	sn := store.Acquire()
	defer sn.Close()

	// Ground truth: re-scan the raw files on disk, independently of the
	// library's document set.
	diskDocs := make(map[string][]byte)
	for _, f := range readCorpus(t, corpus) {
		diskDocs[f.Path] = f.Content
	}
	checkAgainstDocs(t, sn, diskDocs)
}

func TestFaultInjectionKeepsOldGeneration(t *testing.T) {
	for _, point := range []FaultPoint{FaultPersistContent, FaultPersistPath, FaultPublish} {
		t.Run(string(point), func(t *testing.T) {
			store, err := Open(filepath.Join(t.TempDir(), "idx"))
			if err != nil {
				t.Fatal(err)
			}
			v1 := Batch{Put: []File{
				{Path: "a.txt", Content: []byte("alpha one")},
				{Path: "b.txt", Content: []byte("beta two")},
			}}
			if err := store.Update(v1); err != nil {
				t.Fatal(err)
			}
			baseGen := store.Gen()

			store.Faults.Fail(point, 1)
			v2 := Batch{Put: []File{{Path: "a.txt", Content: []byte("alpha changed")}}}
			err = store.Update(v2)
			if !errors.Is(err, ErrInjected) {
				t.Fatalf("Update error = %v, want injected fault", err)
			}

			// The old generation stays published and fully queryable.
			if got := store.Gen(); got != baseGen {
				t.Fatalf("Gen = %d after failed build, want %d", got, baseGen)
			}
			sn := store.Acquire()
			if sn.Gen() != sn.ContentGen() || sn.Gen() != sn.PathGen() {
				t.Errorf("inconsistent snapshot: gen=%d content=%d path=%d",
					sn.Gen(), sn.ContentGen(), sn.PathGen())
			}
			if got := sn.Query("alpha"); !reflect.DeepEqual(got, []string{"a.txt"}) {
				t.Errorf("Query(alpha) = %v, want [a.txt]", got)
			}
			if got := sn.Query("changed"); len(got) != 0 {
				t.Errorf("Query(changed) = %v, want empty (old generation)", got)
			}
			sn.Close()

			// The half-built generation directory is removed.
			dirs := generationDirs(t, store.dir)
			if want := []string{generationDirName(baseGen)}; !reflect.DeepEqual(dirs, want) {
				t.Errorf("generation dirs = %v, want %v", dirs, want)
			}

			// The next build recovers and publishes the new content.
			if err := store.Update(v2); err != nil {
				t.Fatal(err)
			}
			if got := store.Query("changed"); !reflect.DeepEqual(got, []string{"a.txt"}) {
				t.Errorf("Query(changed) = %v, want [a.txt]", got)
			}
		})
	}
}

func TestOldGenerationDeletedAfterReaderRelease(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "idx"))
	if err != nil {
		t.Fatal(err)
	}
	genDir := func(n int) string {
		return filepath.Join(store.dir, "generations", generationDirName(n))
	}
	mustUpdate := func(content string) {
		t.Helper()
		if err := store.Update(Batch{Put: []File{{Path: "a.txt", Content: []byte(content)}}}); err != nil {
			t.Fatal(err)
		}
	}

	mustUpdate("alpha one") // gen 1
	sn1 := store.Acquire()
	mustUpdate("alpha two") // gen 2; gen 1 retired but pinned by sn1

	if _, err := os.Stat(genDir(1)); err != nil {
		t.Errorf("pinned generation 1 deleted while a reader holds it: %v", err)
	}
	if got := sn1.Query("one"); !reflect.DeepEqual(got, []string{"a.txt"}) {
		t.Errorf("stale reader Query(one) = %v, want [a.txt]", got)
	}
	if got := sn1.Query("two"); len(got) != 0 {
		t.Errorf("stale reader Query(two) = %v, want empty", got)
	}
	if got := store.Query("two"); !reflect.DeepEqual(got, []string{"a.txt"}) {
		t.Errorf("current Query(two) = %v, want [a.txt]", got)
	}

	sn1.Close()
	if _, err := os.Stat(genDir(1)); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("retired generation 1 not collected after release, stat err = %v", err)
	}

	mustUpdate("alpha three") // gen 3; gen 2 has no readers, collected at publish
	if _, err := os.Stat(genDir(2)); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("unreferenced generation 2 not collected at publish, stat err = %v", err)
	}
	if _, err := os.Stat(genDir(3)); err != nil {
		t.Errorf("current generation 3 missing: %v", err)
	}
}

func TestConcurrentReadersSeeConsistentGeneration(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "idx"))
	if err != nil {
		t.Fatal(err)
	}
	rng := rand.New(rand.NewSource(1))

	var seed Batch
	for i := 0; i < 12; i++ {
		seed.Put = append(seed.Put, File{
			Path:    fmt.Sprintf("docs/f%02d.txt", i),
			Content: []byte(fmt.Sprintf("alpha beta gamma version0 file%d", i)),
		})
	}
	if err := store.Update(seed); err != nil {
		t.Fatal(err)
	}
	lastGood := store.Gen()

	var done atomic.Int32
	var wg sync.WaitGroup
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for done.Load() == 0 {
				sn := store.Acquire()
				if sn.Gen() != sn.ContentGen() || sn.Gen() != sn.PathGen() {
					t.Errorf("reader saw mixed generation: gen=%d content=%d path=%d",
						sn.Gen(), sn.ContentGen(), sn.PathGen())
				}
				checkAgainstDocs(t, sn, sn.Docs())
				sn.Close()
			}
		}()
	}

	points := []FaultPoint{FaultPersistContent, FaultPersistPath, FaultPublish}
	for i := 0; i < 40; i++ {
		if rng.Intn(4) == 0 {
			store.Faults.Fail(points[rng.Intn(len(points))], 1)
		}
		var b Batch
		for j, n := 0, rng.Intn(4)+1; j < n; j++ {
			k := rng.Intn(12)
			b.Put = append(b.Put, File{
				Path:    fmt.Sprintf("docs/f%02d.txt", k),
				Content: []byte(fmt.Sprintf("alpha delta version%d file%d", i, k)),
			})
		}
		if rng.Intn(5) == 0 {
			b.Delete = []string{fmt.Sprintf("docs/f%02d.txt", rng.Intn(12))}
		}
		err := store.Update(b)
		sn := store.Acquire()
		if err != nil {
			if !errors.Is(err, ErrInjected) {
				t.Fatalf("Update error = %v, want injected fault", err)
			}
			if sn.Gen() != lastGood {
				t.Errorf("failed build moved published generation to %d, want %d", sn.Gen(), lastGood)
			}
		} else {
			lastGood = sn.Gen()
		}
		sn.Close()
	}
	done.Store(1)
	wg.Wait()

	// With all readers gone, only the published generation remains on disk.
	dirs := generationDirs(t, store.dir)
	if want := []string{generationDirName(lastGood)}; !reflect.DeepEqual(dirs, want) {
		t.Errorf("generation dirs = %v, want %v", dirs, want)
	}
}

func TestReopenRecoversPublishedGeneration(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "idx")
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Update(Batch{Put: []File{{Path: "a.txt", Content: []byte("alpha one")}}}); err != nil {
		t.Fatal(err)
	}
	if err := store.Update(Batch{Put: []File{{Path: "a.txt", Content: []byte("alpha two")}}}); err != nil {
		t.Fatal(err)
	}
	gen := store.Gen()

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Gen() != gen {
		t.Fatalf("reopened Gen = %d, want %d", reopened.Gen(), gen)
	}
	if got := reopened.Query("two"); !reflect.DeepEqual(got, []string{"a.txt"}) {
		t.Errorf("reopened Query(two) = %v, want [a.txt]", got)
	}

	// A failed publish leaves no visible state after a reopen.
	reopened.Faults.Fail(FaultPublish, 1)
	if err := reopened.Update(Batch{Put: []File{{Path: "a.txt", Content: []byte("alpha three")}}}); !errors.Is(err, ErrInjected) {
		t.Fatalf("Update error = %v, want injected fault", err)
	}
	again, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if again.Gen() != gen {
		t.Errorf("Gen after failed publish + reopen = %d, want %d", again.Gen(), gen)
	}
	if got := again.Query("three"); len(got) != 0 {
		t.Errorf("Query(three) = %v, want empty (unpublished build)", got)
	}
	if dirs := generationDirs(t, dir); !reflect.DeepEqual(dirs, []string{generationDirName(gen)}) {
		t.Errorf("generation dirs = %v, want [%s]", dirs, generationDirName(gen))
	}
}
