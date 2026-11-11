package q218

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type sliceIter struct {
	entries []*Entry
	idx     int
	err     error
}

func (it *sliceIter) Next() (*Entry, error) {
	if it.err != nil {
		return nil, it.err
	}
	if it.idx >= len(it.entries) {
		return nil, io.EOF
	}
	entry := it.entries[it.idx]
	it.idx++
	return entry, nil
}

type failReader struct {
	data      string
	pos       int
	failAfter int
	err       error
}

func (r *failReader) Read(p []byte) (int, error) {
	if r.pos >= r.failAfter {
		return 0, r.err
	}
	n := copy(p, r.data[r.pos:])
	if r.pos+n > r.failAfter {
		n = r.failAfter - r.pos
	}
	r.pos += n
	if r.pos >= r.failAfter {
		return n, r.err
	}
	return n, nil
}

type blockingReader struct {
	ctx context.Context
}

func (r blockingReader) Read([]byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	case <-time.After(5 * time.Second):
		return 0, errors.New("blocking reader was not cancelled in time")
	}
}

type fakeTx struct {
	mu        sync.Mutex
	mkdirs    []string
	files     []string
	committed bool
	aborted   bool

	mkdirErr  error
	putErr    error
	commitErr error
	abortErr  error
}

func (tx *fakeTx) Mkdir(rel string) error {
	tx.mu.Lock()
	defer tx.mu.Unlock()
	tx.mkdirs = append(tx.mkdirs, rel)
	return tx.mkdirErr
}

func (tx *fakeTx) PutFile(rel string, content io.Reader) error {
	if tx.putErr != nil {
		return tx.putErr
	}
	if _, err := io.Copy(io.Discard, content); err != nil {
		return err
	}
	tx.mu.Lock()
	tx.files = append(tx.files, rel)
	tx.mu.Unlock()
	return nil
}

func (tx *fakeTx) Commit() error {
	tx.mu.Lock()
	defer tx.mu.Unlock()
	tx.committed = true
	return tx.commitErr
}

func (tx *fakeTx) Abort() error {
	tx.mu.Lock()
	defer tx.mu.Unlock()
	tx.aborted = true
	return tx.abortErr
}

type fakeStager struct {
	tx       *fakeTx
	beginErr error
}

func (s *fakeStager) Begin(context.Context) (StageTx, error) {
	if s.beginErr != nil {
		return nil, s.beginErr
	}
	return s.tx, nil
}

func fileEntry(name string, content string, declared int64) *Entry {
	if declared < 0 {
		declared = int64(len(content))
	}
	return &Entry{Name: name, Type: TypeFile, DeclaredSize: declared, Content: strings.NewReader(content)}
}

func dirEntry(name string) *Entry {
	return &Entry{Name: name, Type: TypeDir}
}

func stagingLeftovers(t *testing.T, root string) []string {
	t.Helper()
	parent := filepath.Dir(root)
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatalf("read staging parent %s: %v", parent, err)
	}
	prefix := "." + filepath.Base(root) + ".staging-"
	var leftovers []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), prefix) {
			leftovers = append(leftovers, entry.Name())
		}
	}
	return leftovers
}

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

func TestNormalizePath(t *testing.T) {
	valid := map[string]string{
		"a":           "a",
		"a/b/c":       "a/b/c",
		"./a/./b":     "a/b",
		"a//b/":       "a/b",
		"x/../a":      "a",
		"a/b/../c":    "a/c",
		"deep/./dir/": "deep/dir",
	}
	for in, want := range valid {
		got, err := normalizePath(in)
		if err != nil {
			t.Fatalf("normalizePath(%q) unexpected error: %v", in, err)
		}
		if got != want {
			t.Fatalf("normalizePath(%q) = %q, want %q", in, got, want)
		}
	}

	invalid := []string{
		"", ".", "/", "/abs/path", "..", "../a", "a/../../b",
		"a/../..", `a\b`, `a\..\b`, `a/b\c`, "with\x00null",
	}
	for _, in := range invalid {
		if _, err := normalizePath(in); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("normalizePath(%q) err = %v, want ErrInvalidPath", in, err)
		}
	}
}

// ---------------------------------------------------------------------------
// Happy path on the real filesystem stager
// ---------------------------------------------------------------------------

func TestIngestSuccessOnFS(t *testing.T) {
	root := filepath.Join(t.TempDir(), "archive")
	stager := NewFSStager(root)

	entries := []*Entry{
		dirEntry("explicit"),
		dirEntry("explicit/nested"),
		fileEntry("explicit/nested/f.txt", "hello", -1),
		fileEntry("implicit/child/data.bin", "binary-data", -1),
		fileEntry("top.txt", "top", -1),
	}

	if err := Ingest(context.Background(), stager, &sliceIter{entries: entries}, Limits{}); err != nil {
		t.Fatalf("Ingest failed: %v", err)
	}

	wantFiles := map[string]string{
		"explicit/nested/f.txt":   "hello",
		"implicit/child/data.bin": "binary-data",
		"top.txt":                 "top",
	}
	for rel, want := range wantFiles {
		got, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatalf("expected staged file %s: %v", rel, err)
		}
		if string(got) != want {
			t.Fatalf("file %s = %q, want %q", rel, got, want)
		}
	}
	for _, dir := range []string{"explicit", "explicit/nested", "implicit", "implicit/child"} {
		info, err := os.Stat(filepath.Join(root, filepath.FromSlash(dir)))
		if err != nil || !info.IsDir() {
			t.Fatalf("expected directory %s: %v", dir, err)
		}
	}
	if leftovers := stagingLeftovers(t, root); len(leftovers) != 0 {
		t.Fatalf("staging leftovers remain: %v", leftovers)
	}
}

// ---------------------------------------------------------------------------
// Falsified declared length: shorter or longer stream than advertised
// ---------------------------------------------------------------------------

func TestFalsifiedLengthRollsWholeArchiveBack(t *testing.T) {
	cases := []struct {
		name     string
		content  string
		declared int64
	}{
		{"declared larger than stream", "abc", 10},
		{"declared smaller than stream", "abcdefghij", 4},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "archive")
			stager := NewFSStager(root)
			entries := []*Entry{
				fileEntry("good.txt", "good", -1),
				fileEntry("bad.txt", tc.content, tc.declared),
			}

			err := Ingest(context.Background(), stager, &sliceIter{entries: entries}, Limits{})
			if !errors.Is(err, ErrSizeMismatch) {
				t.Fatalf("err = %v, want ErrSizeMismatch", err)
			}
			if _, statErr := os.Stat(root); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("destination %s must not exist after rollback: %v", root, statErr)
			}
			if leftovers := stagingLeftovers(t, root); len(leftovers) != 0 {
				t.Fatalf("staging leftovers remain: %v", leftovers)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Late-arriving path conflicts and duplicates, in both arrival orders
// ---------------------------------------------------------------------------

func TestLatePathConflict(t *testing.T) {
	cases := []struct {
		name    string
		entries []*Entry
	}{
		{
			"file then directory over it",
			[]*Entry{fileEntry("a", "x", -1), dirEntry("a")},
		},
		{
			"directory then file over it",
			[]*Entry{dirEntry("a"), fileEntry("a", "x", -1)},
		},
		{
			"child file then parent file",
			[]*Entry{fileEntry("a/b", "x", -1), fileEntry("a", "y", -1)},
		},
		{
			"parent file then child file",
			[]*Entry{fileEntry("a", "y", -1), fileEntry("a/b", "x", -1)},
		},
		{
			"child file then parent directory",
			[]*Entry{fileEntry("a/b", "x", -1), dirEntry("a")},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tx := &fakeTx{}
			err := Ingest(context.Background(), &fakeStager{tx: tx}, &sliceIter{entries: tc.entries}, Limits{})
			if !errors.Is(err, ErrPathConflict) {
				t.Fatalf("err = %v, want ErrPathConflict", err)
			}
			if tx.committed {
				t.Fatal("transaction must not commit on conflict")
			}
			if !tx.aborted {
				t.Fatal("transaction must be aborted on conflict")
			}
		})
	}
}

func TestDuplicateTargets(t *testing.T) {
	cases := []struct {
		name    string
		entries []*Entry
	}{
		{"duplicate files", []*Entry{fileEntry("a", "1", -1), fileEntry("a", "2", -1)}},
		{"duplicate directories", []*Entry{dirEntry("a"), dirEntry("a")}},
		{"normalized duplicate", []*Entry{fileEntry("a/./b", "1", -1), fileEntry("a/b", "2", -1)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tx := &fakeTx{}
			err := Ingest(context.Background(), &fakeStager{tx: tx}, &sliceIter{entries: tc.entries}, Limits{})
			if !errors.Is(err, ErrDuplicateTarget) {
				t.Fatalf("err = %v, want ErrDuplicateTarget", err)
			}
			if tx.committed || !tx.aborted {
				t.Fatalf("commit=%v aborted=%v, want no commit with abort", tx.committed, tx.aborted)
			}
		})
	}
}

func TestExplicitDirAfterImplicitParentIsAllowed(t *testing.T) {
	tx := &fakeTx{}
	entries := []*Entry{
		dirEntry("a/b/c"),
		dirEntry("a"),
		dirEntry("a/b"),
	}
	if err := Ingest(context.Background(), &fakeStager{tx: tx}, &sliceIter{entries: entries}, Limits{}); err != nil {
		t.Fatalf("explicit directory over implicit parent should be allowed: %v", err)
	}
	if !tx.committed || tx.aborted {
		t.Fatalf("commit=%v aborted=%v", tx.committed, tx.aborted)
	}
}

func TestDirectoryRedeclaredOverImplicitParentOfFileConflicts(t *testing.T) {
	tx := &fakeTx{}
	entries := []*Entry{
		fileEntry("a/b.txt", "x", -1),
		dirEntry("a"),
	}
	err := Ingest(context.Background(), &fakeStager{tx: tx}, &sliceIter{entries: entries}, Limits{})
	if !errors.Is(err, ErrPathConflict) {
		t.Fatalf("err = %v, want ErrPathConflict", err)
	}
	if tx.committed || !tx.aborted {
		t.Fatalf("commit=%v aborted=%v, want abort without commit", tx.committed, tx.aborted)
	}
}

// ---------------------------------------------------------------------------
// Paths outside the archive root and unsupported entry types
// ---------------------------------------------------------------------------

func TestOutOfRootPathsRejected(t *testing.T) {
	for _, name := range []string{"../escape", "a/../../escape", "/absolute/path", `a\b`} {
		root := filepath.Join(t.TempDir(), "archive")
		stager := NewFSStager(root)
		err := Ingest(context.Background(), stager, &sliceIter{entries: []*Entry{fileEntry(name, "x", -1)}}, Limits{})
		if !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("name %q: err = %v, want ErrInvalidPath", name, err)
		}
		if leftovers := stagingLeftovers(t, root); len(leftovers) != 0 {
			t.Fatalf("name %q left staging dirs: %v", name, leftovers)
		}
	}
}

func TestUnsupportedTypeRejected(t *testing.T) {
	tx := &fakeTx{}
	entries := []*Entry{{Name: "weird", Type: EntryType(99)}}
	err := Ingest(context.Background(), &fakeStager{tx: tx}, &sliceIter{entries: entries}, Limits{})
	if !errors.Is(err, ErrUnsupportedType) {
		t.Fatalf("err = %v, want ErrUnsupportedType", err)
	}
	if tx.committed || !tx.aborted {
		t.Fatal("unsupported entry must abort without commit")
	}
}

func TestFileWithoutContentRejected(t *testing.T) {
	tx := &fakeTx{}
	entries := []*Entry{{Name: "empty", Type: TypeFile, DeclaredSize: 0, Content: nil}}
	err := Ingest(context.Background(), &fakeStager{tx: tx}, &sliceIter{entries: entries}, Limits{})
	if !errors.Is(err, ErrMissingContent) {
		t.Fatalf("err = %v, want ErrMissingContent", err)
	}
}

// ---------------------------------------------------------------------------
// Byte budgets: exact-at-limit accepted, overflow rejected, declared precheck
// ---------------------------------------------------------------------------

func TestBudgetExactBoundaryAccepted(t *testing.T) {
	tx := &fakeTx{}
	entries := []*Entry{
		fileEntry("a", "12345", -1),
		fileEntry("b", "67890", -1),
	}
	err := Ingest(context.Background(), &fakeStager{tx: tx}, &sliceIter{entries: entries}, Limits{PerEntry: 5, Total: 10})
	if err != nil {
		t.Fatalf("streams ending exactly at the budget must pass: %v", err)
	}
	if !tx.committed {
		t.Fatal("archive at exactly the budget must commit")
	}
}

func TestEntryBudgetExceededOnActualBytes(t *testing.T) {
	tx := &fakeTx{}
	entries := []*Entry{fileEntry("a", "123456", 6)}
	err := Ingest(context.Background(), &fakeStager{tx: tx}, &sliceIter{entries: entries}, Limits{PerEntry: 5})
	if !errors.Is(err, ErrEntryBudget) {
		t.Fatalf("err = %v, want ErrEntryBudget", err)
	}
	if tx.committed || !tx.aborted {
		t.Fatal("over-budget entry must abort without commit")
	}
}

func TestTotalBudgetExceededAcrossEntries(t *testing.T) {
	tx := &fakeTx{}
	entries := []*Entry{
		fileEntry("a", "1234", -1),
		fileEntry("b", "5678", -1),
	}
	err := Ingest(context.Background(), &fakeStager{tx: tx}, &sliceIter{entries: entries}, Limits{Total: 7})
	if !errors.Is(err, ErrTotalBudget) {
		t.Fatalf("err = %v, want ErrTotalBudget", err)
	}
	if tx.committed || !tx.aborted {
		t.Fatal("over-budget archive must abort without commit")
	}
}

func TestDeclaredSizeRejectedBeforeReading(t *testing.T) {
	tx := &fakeTx{}
	read := false
	entries := []*Entry{{
		Name:         "a",
		Type:         TypeFile,
		DeclaredSize: 100,
		Content:      readerFunc(func(p []byte) (int, error) { read = true; return 0, io.EOF }),
	}}

	err := Ingest(context.Background(), &fakeStager{tx: tx}, &sliceIter{entries: entries}, Limits{PerEntry: 10})
	if !errors.Is(err, ErrDeclaredTooLarge) || !errors.Is(err, ErrEntryBudget) {
		t.Fatalf("err = %v, want ErrDeclaredTooLarge/ErrEntryBudget", err)
	}
	if read {
		t.Fatal("content must not be read when declared size exceeds budget")
	}
	if len(tx.files) != 0 || tx.committed || !tx.aborted {
		t.Fatal("rejected entry must not be staged")
	}

	tx2 := &fakeTx{}
	entries2 := []*Entry{
		fileEntry("ok", "1234", -1),
		{Name: "big", Type: TypeFile, DeclaredSize: 50, Content: strings.NewReader(strings.Repeat("x", 50))},
	}
	err = Ingest(context.Background(), &fakeStager{tx: tx2}, &sliceIter{entries: entries2}, Limits{Total: 10})
	if !errors.Is(err, ErrDeclaredTooLarge) || !errors.Is(err, ErrTotalBudget) {
		t.Fatalf("err = %v, want ErrDeclaredTooLarge/ErrTotalBudget", err)
	}
}

type readerFunc func(p []byte) (int, error)

func (f readerFunc) Read(p []byte) (int, error) { return f(p) }

// oneByteReader hands out at most one byte per Read, forcing many tiny reads
// through the budget boundary probing logic.
type oneByteReader struct {
	data []byte
	pos  int
}

func (r *oneByteReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	p[0] = r.data[r.pos]
	r.pos++
	return 1, nil
}

func TestBudgetBoundaryWithOneByteReads(t *testing.T) {
	cases := []struct {
		name      string
		length    int
		perEntry  int64
		total     int64
		declared  int64
		wantError error
	}{
		{"exact entry boundary", 5, 5, 0, 5, nil},
		{"one byte over entry boundary", 6, 5, 0, 6, ErrEntryBudget},
		{"exact total boundary across file", 5, 0, 5, 5, nil},
		{"one byte over total boundary", 6, 0, 5, 6, ErrTotalBudget},
		{"declared size mismatch still caught at boundary", 4, 5, 0, 5, ErrSizeMismatch},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tx := &fakeTx{}
			entries := []*Entry{{
				Name:         "tiny",
				Type:         TypeFile,
				DeclaredSize: tc.declared,
				Content:      &oneByteReader{data: []byte(strings.Repeat("x", tc.length))},
			}}
			err := Ingest(context.Background(), &fakeStager{tx: tx}, &sliceIter{entries: entries},
				Limits{PerEntry: tc.perEntry, Total: tc.total})
			if tc.wantError == nil {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if !tx.committed {
					t.Fatal("exact-boundary archive must commit")
				}
				return
			}
			if !errors.Is(err, tc.wantError) {
				t.Fatalf("err = %v, want %v", err, tc.wantError)
			}
			if tx.committed || !tx.aborted {
				t.Fatal("rejected archive must abort without commit")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Cancellation, read failures and iterator failures: all reclaim staging
// ---------------------------------------------------------------------------

func TestCancellationAbortsTransaction(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()

	root := filepath.Join(t.TempDir(), "archive")
	stager := NewFSStager(root)
	entries := []*Entry{{
		Name:         "slow",
		Type:         TypeFile,
		DeclaredSize: 1,
		Content:      blockingReader{ctx: ctx},
	}}

	err := Ingest(ctx, stager, &sliceIter{entries: entries}, Limits{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if _, statErr := os.Stat(root); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("destination must not exist after cancellation: %v", statErr)
	}
	if leftovers := stagingLeftovers(t, root); len(leftovers) != 0 {
		t.Fatalf("staging leftovers remain after cancellation: %v", leftovers)
	}
}

func TestReadFailureReclaimsStaging(t *testing.T) {
	boom := errors.New("stream exploded")
	cases := []struct {
		name   string
		reader io.Reader
	}{
		{"immediate read error", &failReader{data: "abc", failAfter: 0, err: boom}},
		{"read error after some bytes", &failReader{data: "abcdef", failAfter: 3, err: boom}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "archive")
			stager := NewFSStager(root)
			entries := []*Entry{{
				Name:         "broken",
				Type:         TypeFile,
				DeclaredSize: 6,
				Content:      tc.reader,
			}}
			err := Ingest(context.Background(), stager, &sliceIter{entries: entries}, Limits{})
			if !errors.Is(err, boom) {
				t.Fatalf("err = %v, want wrapped read failure %v", err, boom)
			}
			if _, statErr := os.Stat(root); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("destination must not exist after read failure: %v", statErr)
			}
			if leftovers := stagingLeftovers(t, root); len(leftovers) != 0 {
				t.Fatalf("staging leftovers remain: %v", leftovers)
			}
		})
	}
}

func TestIteratorFailureAborts(t *testing.T) {
	boom := errors.New("iterator exploded")
	tx := &fakeTx{}
	it := &sliceIter{
		entries: []*Entry{fileEntry("a", "x", -1)},
		err:     boom,
	}
	err := Ingest(context.Background(), &fakeStager{tx: tx}, it, Limits{})
	if !errors.Is(err, ErrIterator) || !errors.Is(err, boom) {
		t.Fatalf("err = %v, want ErrIterator wrapping %v", err, boom)
	}
	if tx.committed || !tx.aborted {
		t.Fatal("iterator failure must abort without commit")
	}
}

func TestBeginFailureDoesNotOpenTx(t *testing.T) {
	boom := errors.New("begin failed")
	stager := &fakeStager{beginErr: boom}
	err := Ingest(context.Background(), stager, &sliceIter{}, Limits{})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
}

// ---------------------------------------------------------------------------
// Commit atomicity: commit failure still triggers full cleanup
// ---------------------------------------------------------------------------

func TestCommitFailureTriggersAbort(t *testing.T) {
	boom := errors.New("commit failed")
	tx := &fakeTx{commitErr: boom}
	entries := []*Entry{fileEntry("a", "x", -1)}
	err := Ingest(context.Background(), &fakeStager{tx: tx}, &sliceIter{entries: entries}, Limits{})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
	if !tx.committed || !tx.aborted {
		t.Fatalf("commit failure path must still abort: committed=%v aborted=%v", tx.committed, tx.aborted)
	}
}

func TestFSBeginRejectsExistingDestination(t *testing.T) {
	root := filepath.Join(t.TempDir(), "archive")
	if err := os.Mkdir(root, defaultDirPerm); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFSStager(root).Begin(context.Background()); err == nil {
		t.Fatal("Begin must reject an existing destination")
	}
}

func TestFSStagerRejectsEscapingPaths(t *testing.T) {
	root := filepath.Join(t.TempDir(), "archive")
	tx, err := NewFSStager(root).Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Abort() })

	for _, rel := range []string{"../escape", "a/../../escape", "/tmp/abs"} {
		if err := tx.Mkdir(rel); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("Mkdir(%q) err = %v, want ErrInvalidPath", rel, err)
		}
		if err := tx.PutFile(rel, strings.NewReader("x")); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("PutFile(%q) err = %v, want ErrInvalidPath", rel, err)
		}
	}
}

func TestFSAbortRemovesPartialStagingAfterFailedWrite(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "archive")
	stager := NewFSStager(root)
	tx, err := stager.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	boom := errors.New("mid-copy failure")
	if err := tx.PutFile("partial.txt", &failReader{data: "abcdef", failAfter: 3, err: boom}); !errors.Is(err, boom) {
		t.Fatalf("PutFile err = %v, want %v", err, boom)
	}
	if err := tx.Abort(); err != nil {
		t.Fatalf("Abort: %v", err)
	}

	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("parent directory must be empty after abort, found: %v", entries)
	}
}

func TestFSTransactionLifecycleGuards(t *testing.T) {
	root := filepath.Join(t.TempDir(), "archive")
	tx, err := NewFSStager(root).Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if err := tx.Commit(); err == nil {
		t.Fatal("second Commit must fail")
	}
	if err := tx.Abort(); err != nil {
		t.Fatalf("Abort after Commit must be a harmless no-op: %v", err)
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("committed destination must remain in place: %v", err)
	}
	if leftovers := stagingLeftovers(t, root); len(leftovers) != 0 {
		t.Fatalf("staging leftovers: %v", leftovers)
	}
}
