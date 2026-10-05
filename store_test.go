package backupstore

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

var errInjected = errors.New("injected fault")

func makeData(size int, seed byte) []byte {
	b := make([]byte, size)
	for i := range b {
		b[i] = seed + byte(i%251)
	}
	return b
}

func mustCommit(t *testing.T, s *Store, key string, data []byte, frags [][2]int64) {
	t.Helper()
	u, err := s.BeginUpload(key, int64(len(data)))
	if err != nil {
		t.Fatalf("BeginUpload: %v", err)
	}
	for _, fr := range frags {
		if err := u.WriteFragment(fr[0], data[fr[0]:fr[1]]); err != nil {
			t.Fatalf("WriteFragment [%d,%d): %v", fr[0], fr[1], err)
		}
	}
	if err := u.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
}

func readAll(t *testing.T, s *Store, key string) []byte {
	t.Helper()
	r, err := s.Get(key)
	if err != nil {
		t.Fatalf("Get(%q): %v", key, err)
	}
	defer r.Close()
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	return b
}

// Fragments arrive out of order and must assemble into the declared content.
func TestOutOfOrderFragments(t *testing.T) {
	s, err := Open(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := makeData(1000, 7)
	mustCommit(t, s, "obj", data, [][2]int64{{500, 700}, {700, 1000}, {0, 500}})
	if got := readAll(t, s, "obj"); !bytes.Equal(got, data) {
		t.Fatalf("committed content mismatch")
	}
}

// Overlapping fragments with identical bytes are accepted.
func TestOverlapConsistent(t *testing.T) {
	s, err := Open(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := makeData(600, 3)
	mustCommit(t, s, "obj", data, [][2]int64{{0, 400}, {200, 600}, [2]int64{100, 500}})
	if got := readAll(t, s, "obj"); !bytes.Equal(got, data) {
		t.Fatalf("committed content mismatch")
	}
}

// Overlapping fragments whose bytes differ must be rejected.
func TestOverlapConflict(t *testing.T) {
	s, err := Open(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := makeData(400, 1)
	u, err := s.BeginUpload("obj", 400)
	if err != nil {
		t.Fatal(err)
	}
	if err := u.WriteFragment(0, data[:300]); err != nil {
		t.Fatal(err)
	}
	bad := makeData(400, 1)
	bad[250] ^= 0xff // differs inside the overlap [100,300)
	if err := u.WriteFragment(100, bad[100:]); !errors.Is(err, ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
	// The rejected fragment recorded nothing; the correct bytes still commit.
	if err := u.WriteFragment(100, data[100:]); err != nil {
		t.Fatal(err)
	}
	if err := u.Commit(); err != nil {
		t.Fatal(err)
	}
	if got := readAll(t, s, "obj"); !bytes.Equal(got, data) {
		t.Fatalf("committed content mismatch")
	}
}

// Commit with gaps fails and the old version stays published.
func TestCommitWithGapKeepsOldVersion(t *testing.T) {
	s, err := Open(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := makeData(500, 9)
	mustCommit(t, s, "obj", old, [][2]int64{{0, 500}})

	u, err := s.BeginUpload("obj", 500)
	if err != nil {
		t.Fatal(err)
	}
	if err := u.WriteFragment(0, makeData(200, 4)); err != nil {
		t.Fatal(err)
	}
	if err := u.Commit(); !errors.Is(err, ErrIncomplete) {
		t.Fatalf("want ErrIncomplete, got %v", err)
	}
	if got := readAll(t, s, "obj"); !bytes.Equal(got, old) {
		t.Fatalf("old version corrupted after failed commit")
	}
}

// A reader that opened the old version before commit keeps reading it;
// new readers see the new version.
func TestOldReaderRemainsReadable(t *testing.T) {
	s, err := Open(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := makeData(300, 2)
	mustCommit(t, s, "obj", old, [][2]int64{{0, 300}})

	r, err := s.Get("obj")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	head := make([]byte, 10)
	if _, err := io.ReadFull(r, head); err != nil {
		t.Fatal(err)
	}

	newData := makeData(300, 8)
	mustCommit(t, s, "obj", newData, [][2]int64{{0, 300}})

	rest, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(append(head, rest...), old) {
		t.Fatalf("old reader saw changed bytes")
	}
	if got := readAll(t, s, "obj"); !bytes.Equal(got, newData) {
		t.Fatalf("new readers must see the new version")
	}
}

// A commit that fails on an injected fault can be retried to completion.
func TestRetryCommitAfterFault(t *testing.T) {
	old := makeData(256, 5)
	newData := makeData(256, 6)
	for _, op := range []Op{OpWrite, OpSync, OpRename, OpSyncDir} {
		dir := t.TempDir()
		seed, err := Open(nil, dir)
		if err != nil {
			t.Fatal(err)
		}
		mustCommit(t, seed, "obj", old, [][2]int64{{0, 256}})

		var failed atomic.Bool
		ff := FaultFS{FS: osFS{}, Hook: func(got Op, path string) error {
			if got == op && !failed.Swap(true) {
				return errInjected
			}
			return nil
		}}
		s, err := Open(ff, dir)
		if err != nil {
			t.Fatal(err)
		}
		u, err := s.BeginUpload("obj", 256)
		if err != nil {
			t.Fatal(err)
		}
		writeErr := u.WriteFragment(0, newData)
		if op == OpWrite {
			if writeErr == nil {
				t.Fatalf("op %s: first write should fail", op)
			}
			if err := u.WriteFragment(0, newData); err != nil {
				t.Fatalf("op %s: retry write: %v", op, err)
			}
			if err := u.Commit(); err != nil {
				t.Fatalf("op %s: commit after write retry: %v", op, err)
			}
		} else {
			if writeErr != nil {
				t.Fatalf("op %s: unexpected write error: %v", op, writeErr)
			}
			if err := u.Commit(); err == nil {
				t.Fatalf("op %s: first commit should fail", op)
			}
			// A failed commit leaves either the old version (failure before
			// rename) or the new version (failure after rename), never a mix.
			if got := readAll(t, s, "obj"); !bytes.Equal(got, old) && !bytes.Equal(got, newData) {
				t.Fatalf("op %s: failed commit corrupted the published version", op)
			}
		}
		if op != OpWrite {
			if err := u.Commit(); err != nil {
				t.Fatalf("op %s: retried commit: %v", op, err)
			}
		}
		if got := readAll(t, s, "obj"); !bytes.Equal(got, newData) {
			t.Fatalf("op %s: new version not published after retry", op)
		}
	}
}

// Crash sweep: fail the Nth mutating operation (write/sync/rename/syncdir),
// abandon all in-memory state, reopen the store, and verify the object is
// either the complete old version or the complete new version.
func TestCrashRecoverySweep(t *testing.T) {
	old := makeData(512, 11)
	newData := makeData(512, 12)
	frags := [][2]int64{{300, 512}, {0, 300}}

	for n := 1; ; n++ {
		dir := t.TempDir()
		seed, err := Open(nil, dir)
		if err != nil {
			t.Fatal(err)
		}
		mustCommit(t, seed, "obj", old, [][2]int64{{0, 512}})

		var count int
		ff := FaultFS{FS: osFS{}, Hook: func(op Op, path string) error {
			count++
			if count == n {
				return errInjected
			}
			return nil
		}}
		s, err := Open(ff, dir)
		if err != nil {
			t.Fatal(err)
		}
		u, err := s.BeginUpload("obj", 512)
		if err != nil {
			t.Fatal(err)
		}
		crashed := false
		for _, fr := range frags {
			if err := u.WriteFragment(fr[0], newData[fr[0]:fr[1]]); err != nil {
				crashed = true
				break
			}
		}
		if !crashed {
			if err := u.Commit(); err != nil {
				crashed = true
			}
		}

		// Recover: a fresh store over the same directory.
		rs, err := Open(nil, dir)
		if err != nil {
			t.Fatal(err)
		}
		got := readAll(t, rs, "obj")
		if !bytes.Equal(got, old) && !bytes.Equal(got, newData) {
			t.Fatalf("n=%d: recovered content is neither old nor new version", n)
		}
		if crashed && bytes.Equal(got, newData) {
			// Allowed only if the crash happened after the rename.
			t.Logf("n=%d: crash after rename, new version published", n)
		}
		entries, err := os.ReadDir(filepath.Join(dir, "staging"))
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("n=%d: recovery left %d staging files", n, len(entries))
		}
		if !crashed {
			if !bytes.Equal(got, newData) {
				t.Fatalf("n=%d: clean commit must publish the new version", n)
			}
			t.Logf("n=%d: no more operations to fail, sweep complete", n)
			break
		}
	}
}

func TestGetNotFoundAndInvalidKey(t *testing.T) {
	s, err := Open(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get("missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	for _, key := range []string{"", ".", "..", "a/b", `a\b`} {
		if _, err := s.BeginUpload(key, 1); !errors.Is(err, ErrInvalidKey) {
			t.Fatalf("key %q: want ErrInvalidKey, got %v", key, err)
		}
		if _, err := s.Get(key); !errors.Is(err, ErrInvalidKey) {
			t.Fatalf("key %q: want ErrInvalidKey, got %v", key, err)
		}
	}
}

func TestAbortDiscardsUpload(t *testing.T) {
	s, err := Open(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	u, err := s.BeginUpload("obj", 100)
	if err != nil {
		t.Fatal(err)
	}
	if err := u.WriteFragment(0, makeData(100, 1)); err != nil {
		t.Fatal(err)
	}
	if err := u.Abort(); err != nil {
		t.Fatal(err)
	}
	if err := u.Commit(); !errors.Is(err, ErrAborted) {
		t.Fatalf("want ErrAborted, got %v", err)
	}
	if _, err := s.Get("obj"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("aborted upload must not be visible, got %v", err)
	}
}

func TestZeroLengthUpload(t *testing.T) {
	s, err := Open(nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	u, err := s.BeginUpload("empty", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := u.Commit(); err != nil {
		t.Fatal(err)
	}
	if got := readAll(t, s, "empty"); len(got) != 0 {
		t.Fatalf("want empty object, got %d bytes", len(got))
	}
}

func ExampleStore() {
	dir, _ := os.MkdirTemp("", "backupstore")
	defer os.RemoveAll(dir)
	s, _ := Open(nil, dir)
	u, _ := s.BeginUpload("snapshot", 6)
	u.WriteFragment(3, []byte("def"))
	u.WriteFragment(0, []byte("abc"))
	u.Commit()
	r, _ := s.Get("snapshot")
	defer r.Close()
	b, _ := io.ReadAll(r)
	fmt.Println(string(b))
	// Output: abcdef
}
