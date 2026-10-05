package backupupload

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func sha(b []byte) [sha256.Size]byte { return sha256.Sum256(b) }

// seed publishes an initial version of name directly through a session.
func seed(t *testing.T, s *Store, name string, content []byte) {
	t.Helper()
	ses, err := s.Begin(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := ses.WriteChunk(0, content); err != nil {
		t.Fatal(err)
	}
	if err := ses.Commit(int64(len(content)), sha(content)); err != nil {
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, s *Store, name string) []byte {
	t.Helper()
	b, err := s.Read(name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Chunks arriving out of order must assemble into the correct object.
func TestOutOfOrderChunks(t *testing.T) {
	s := newStore(t)
	var want []byte
	for i := 0; i < 1000; i++ {
		want = append(want, byte(i%251))
	}
	const chunk = 100
	type part struct{ off int }
	var parts []part
	for off := 0; off < len(want); off += chunk {
		parts = append(parts, part{off})
	}
	// Reverse arrival order.
	for i, j := 0, len(parts)-1; i < j; i, j = i+1, j-1 {
		parts[i], parts[j] = parts[j], parts[i]
	}

	ses, err := s.Begin("obj")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range parts {
		end := p.off + chunk
		if end > len(want) {
			end = len(want)
		}
		if err := ses.WriteChunk(int64(p.off), want[p.off:end]); err != nil {
			t.Fatal(err)
		}
	}
	if err := ses.Commit(int64(len(want)), sha(want)); err != nil {
		t.Fatal(err)
	}
	if got := mustRead(t, s, "obj"); !bytes.Equal(got, want) {
		t.Fatalf("published content mismatch: got %d bytes", len(got))
	}
}

// Overlapping chunks with identical bytes are accepted; conflicting
// bytes are rejected without corrupting staged data.
func TestOverlapConsistency(t *testing.T) {
	s := newStore(t)
	ses, err := s.Begin("obj")
	if err != nil {
		t.Fatal(err)
	}
	if err := ses.WriteChunk(0, []byte("hello world")); err != nil {
		t.Fatal(err)
	}
	// Consistent overlap: "llo w" matches bytes [2,7).
	if err := ses.WriteChunk(2, []byte("llo w")); err != nil {
		t.Fatalf("consistent overlap rejected: %v", err)
	}
	// Conflicting overlap.
	if err := ses.WriteChunk(0, []byte("HELLO")); !errors.Is(err, ErrOverlapConflict) {
		t.Fatalf("expected ErrOverlapConflict, got %v", err)
	}
	// Extend beyond the overlap with consistent prefix.
	if err := ses.WriteChunk(6, []byte("world!!!")); err != nil {
		t.Fatalf("extending overlap rejected: %v", err)
	}
	want := []byte("hello world!!!")
	if err := ses.Commit(int64(len(want)), sha(want)); err != nil {
		t.Fatal(err)
	}
	if got := mustRead(t, s, "obj"); !bytes.Equal(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
}

// Commit must refuse to publish when coverage is incomplete, and the
// old version must stay readable.
func TestCommitIncompleteKeepsOldVersion(t *testing.T) {
	s := newStore(t)
	old := []byte("old complete version")
	seed(t, s, "obj", old)

	ses, err := s.Begin("obj")
	if err != nil {
		t.Fatal(err)
	}
	if err := ses.WriteChunk(0, []byte("new-")); err != nil {
		t.Fatal(err)
	}
	// Gap: bytes [4,8) missing.
	if err := ses.WriteChunk(8, []byte("tail")); err != nil {
		t.Fatal(err)
	}
	err = ses.Commit(12, sha([]byte("new-????tail")))
	if !errors.Is(err, ErrIncomplete) {
		t.Fatalf("expected ErrIncomplete, got %v", err)
	}
	if got := mustRead(t, s, "obj"); !bytes.Equal(got, old) {
		t.Fatalf("old version corrupted: %q", got)
	}
	ses.Abort()
}

// A hash mismatch must abort the commit and preserve the old version.
func TestCommitHashMismatchKeepsOldVersion(t *testing.T) {
	s := newStore(t)
	old := []byte("old")
	seed(t, s, "obj", old)

	ses, err := s.Begin("obj")
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("new")
	if err := ses.WriteChunk(0, data); err != nil {
		t.Fatal(err)
	}
	var wrong [sha256.Size]byte
	if err := ses.Commit(3, wrong); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("expected ErrHashMismatch, got %v", err)
	}
	if got := mustRead(t, s, "obj"); !bytes.Equal(got, old) {
		t.Fatalf("old version corrupted: %q", got)
	}
	ses.Abort()
}

// faultAfter returns an injector that fails the n-th (0-based)
// faultable operation and every operation afterwards, simulating a
// crash at that exact point.
func faultAfter(n int) (FaultInjector, *int) {
	count := new(int)
	return FaultFunc(func(op Op) error {
		c := *count
		*count = c + 1
		if c >= n {
			return fmt.Errorf("injected crash at op #%d (%s)", c, op)
		}
		return nil
	}), count
}

// For every possible crash point during an upload+commit, recovery
// must leave either the complete old version or the complete new
// version published — never anything else.
func TestCrashAtEveryPointRecoversToOldOrNew(t *testing.T) {
	old := []byte("OLD-VERSION")
	newData := []byte("NEW-VERSION-0123456789")

	// One upload attempt performs: 3 chunk writes, 1 sync, 1 rename.
	for crashAt := 0; crashAt <= 5; crashAt++ {
		t.Run(fmt.Sprintf("crash_at_%d", crashAt), func(t *testing.T) {
			dir := t.TempDir()
			s, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			seed(t, s, "obj", old)

			inj, _ := faultAfter(crashAt)
			s.Faults = inj

			ses, err := s.Begin("obj")
			if err != nil {
				t.Fatal(err)
			}
			// Out-of-order chunks.
			_ = ses.WriteChunk(16, newData[16:])
			_ = ses.WriteChunk(0, newData[:8])
			_ = ses.WriteChunk(8, newData[8:16])
			commitErr := ses.Commit(int64(len(newData)), sha(newData))

			// Simulate crash: abandon session, reopen store, recover.
			s2, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			if err := s2.Recover(); err != nil {
				t.Fatal(err)
			}
			got, err := s2.Read("obj")
			if err != nil {
				t.Fatal(err)
			}
			isOld := bytes.Equal(got, old)
			isNew := bytes.Equal(got, newData)
			if !isOld && !isNew {
				t.Fatalf("crash at op %d: recovered content %q is neither old nor new", crashAt, got)
			}
			if commitErr == nil && !isNew {
				t.Fatalf("commit reported success but new version not published")
			}
			// No staging files may survive recovery.
			entries, _ := os.ReadDir(dir)
			for _, e := range entries {
				if filepath.Ext(e.Name()) == stagingSuffix {
					t.Fatalf("staging file %q survived recovery", e.Name())
				}
			}
		})
	}
}

// Injected write, sync, and rename failures must each leave the old
// published version fully intact.
func TestInjectedFailuresKeepOldVersion(t *testing.T) {
	old := []byte("old version")
	newData := []byte("new version")

	cases := map[string]Op{
		"write":  OpWrite,
		"sync":   OpSync,
		"rename": OpRename,
	}
	for name, failOp := range cases {
		t.Run(name, func(t *testing.T) {
			s := newStore(t)
			seed(t, s, "obj", old)
			s.Faults = FaultFunc(func(op Op) error {
				if op == failOp {
					return errors.New("injected " + op.String() + " failure")
				}
				return nil
			})
			ses, err := s.Begin("obj")
			if err != nil {
				t.Fatal(err)
			}
			_ = ses.WriteChunk(0, newData)
			commitErr := ses.Commit(int64(len(newData)), sha(newData))
			if commitErr == nil {
				t.Fatalf("commit unexpectedly succeeded under %s failure", name)
			}
			if got := mustRead(t, s, "obj"); !bytes.Equal(got, old) {
				t.Fatalf("%s failure corrupted old version: %q", name, got)
			}
		})
	}
}

// A reader that opened the old version before a commit must keep
// reading the complete old version even after the new one is
// published.
func TestOldReaderKeepsReadingAfterCommit(t *testing.T) {
	s := newStore(t)
	old := bytes.Repeat([]byte("old!"), 1000)
	seed(t, s, "obj", old)

	r, err := s.OpenReader("obj")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	// Publish a new version while the reader holds the old file open.
	ses, err := s.Begin("obj")
	if err != nil {
		t.Fatal(err)
	}
	newData := bytes.Repeat([]byte("new?"), 1000)
	if err := ses.WriteChunk(0, newData); err != nil {
		t.Fatal(err)
	}
	if err := ses.Commit(int64(len(newData)), sha(newData)); err != nil {
		t.Fatal(err)
	}

	got, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, old) {
		t.Fatalf("old reader saw changed content")
	}
	if got := mustRead(t, s, "obj"); !bytes.Equal(got, newData) {
		t.Fatalf("new readers should see new version")
	}
}

// Concurrent readers during repeated commits must always observe a
// complete version — old or new, never a mixture.
func TestConcurrentReadersSeeCompleteVersions(t *testing.T) {
	s := newStore(t)
	v1 := bytes.Repeat([]byte("A"), 4096)
	v2 := bytes.Repeat([]byte("B"), 4096)
	seed(t, s, "obj", v1)

	var wg sync.WaitGroup
	stop := make(chan struct{})
	errCh := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				b, err := s.Read("obj")
				if err != nil {
					errCh <- err
					return
				}
				if !bytes.Equal(b, v1) && !bytes.Equal(b, v2) {
					errCh <- fmt.Errorf("reader saw torn content (len=%d)", len(b))
					return
				}
			}
		}()
	}
	for i := 0; i < 20; i++ {
		data := v1
		if i%2 == 1 {
			data = v2
		}
		ses, err := s.Begin("obj")
		if err != nil {
			t.Fatal(err)
		}
		if err := ses.WriteChunk(0, data); err != nil {
			t.Fatal(err)
		}
		if err := ses.Commit(int64(len(data)), sha(data)); err != nil {
			t.Fatal(err)
		}
	}
	close(stop)
	wg.Wait()
	select {
	case err := <-errCh:
		t.Fatal(err)
	default:
	}
}

// Recovery with no crash must not disturb a published object.
func TestRecoverKeepsPublishedObject(t *testing.T) {
	s := newStore(t)
	want := []byte("published")
	seed(t, s, "obj", want)
	if err := s.Recover(); err != nil {
		t.Fatal(err)
	}
	if got := mustRead(t, s, "obj"); !bytes.Equal(got, want) {
		t.Fatalf("recover removed published object")
	}
}
