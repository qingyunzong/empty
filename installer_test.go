package recovery

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func metaFor(version, index uint64, chunks [][]byte) Meta {
	return Meta{
		Version: version,
		Index:   index,
		Chunks:  len(chunks),
		Digest:  DigestOf(chunks...),
	}
}

func writeAll(t *testing.T, in *Installer, version uint64, chunks [][]byte) {
	t.Helper()
	for seq, data := range chunks {
		if err := in.WriteChunk(version, seq, data); err != nil {
			t.Fatalf("WriteChunk(%d): %v", seq, err)
		}
	}
}

func join(chunks [][]byte) []byte {
	return bytes.Join(chunks, nil)
}

func TestInstallPublishRoundTrip(t *testing.T) {
	dir := t.TempDir()
	in, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	chunks := [][]byte{[]byte("hello "), []byte("snap"), []byte("shot")}
	m := metaFor(1, 100, chunks)
	if err := in.Begin(m); err != nil {
		t.Fatal(err)
	}
	writeAll(t, in, 1, chunks)
	if err := in.Complete(1); err != nil {
		t.Fatal(err)
	}
	got, payload, ok := in.Snapshot()
	if !ok {
		t.Fatal("no snapshot published")
	}
	if got.Version != 1 || got.Index != 100 {
		t.Fatalf("meta = %+v", got)
	}
	if !bytes.Equal(payload, []byte("hello snapshot")) {
		t.Fatalf("payload = %q", payload)
	}
	if in.Installing() {
		t.Fatal("session still active after Complete")
	}
}

func TestCompleteRequiresAllChunks(t *testing.T) {
	dir := t.TempDir()
	in, _ := Open(dir)
	chunks := [][]byte{[]byte("a"), []byte("b"), []byte("c")}
	m := metaFor(1, 10, chunks)
	in.Begin(m)
	in.WriteChunk(1, 0, chunks[0])
	in.WriteChunk(1, 2, chunks[2])
	err := in.Complete(1)
	if !errors.Is(err, ErrIncomplete) {
		t.Fatalf("err = %v, want ErrIncomplete", err)
	}
	if !in.Installing() {
		t.Fatal("session should survive incomplete Complete")
	}
	in.WriteChunk(1, 1, chunks[1])
	if err := in.Complete(1); err != nil {
		t.Fatalf("Complete after filling gap: %v", err)
	}
}

func TestDigestMismatchAbortsAndKeepsOldState(t *testing.T) {
	dir := t.TempDir()
	in, _ := Open(dir)
	good := [][]byte{[]byte("v1-data")}
	in.Begin(metaFor(1, 5, good))
	writeAll(t, in, 1, good)
	if err := in.Complete(1); err != nil {
		t.Fatal(err)
	}

	bad := [][]byte{[]byte("evil")}
	m := metaFor(2, 9, bad)
	m.Digest = DigestOf([]byte("something else"))
	in.Begin(m)
	writeAll(t, in, 2, bad)
	if err := in.Complete(2); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("err = %v, want ErrDigestMismatch", err)
	}
	got, payload, ok := in.Snapshot()
	if !ok || got.Version != 1 || !bytes.Equal(payload, []byte("v1-data")) {
		t.Fatalf("old state damaged: meta=%+v payload=%q ok=%v", got, payload, ok)
	}
	if in.Installing() {
		t.Fatal("failed session should be aborted")
	}
}

func TestDuplicateChunkSameContentIdempotent(t *testing.T) {
	dir := t.TempDir()
	in, _ := Open(dir)
	chunks := [][]byte{[]byte("x"), []byte("y")}
	in.Begin(metaFor(1, 3, chunks))
	in.WriteChunk(1, 0, chunks[0])
	if err := in.WriteChunk(1, 0, chunks[0]); err != nil {
		t.Fatalf("identical duplicate chunk: %v", err)
	}
	writeAll(t, in, 1, chunks)
	if err := in.Complete(1); err != nil {
		t.Fatal(err)
	}
}

func TestDuplicateChunkDifferentContentFails(t *testing.T) {
	dir := t.TempDir()
	in, _ := Open(dir)
	chunks := [][]byte{[]byte("x"), []byte("y")}
	in.Begin(metaFor(1, 3, chunks))
	in.WriteChunk(1, 0, chunks[0])
	err := in.WriteChunk(1, 0, []byte("DIFFERENT"))
	if !errors.Is(err, ErrChunkConflict) {
		t.Fatalf("err = %v, want ErrChunkConflict", err)
	}
	if in.Installing() {
		t.Fatal("conflicting chunk should abort the session")
	}
	if _, ok := in.Session(); ok {
		t.Fatal("session metadata should be cleared")
	}
	if err := in.WriteChunk(1, 1, chunks[1]); !errors.Is(err, ErrNoSession) {
		t.Fatalf("err = %v, want ErrNoSession", err)
	}
}

func TestCrossVersionChunkRejected(t *testing.T) {
	dir := t.TempDir()
	in, _ := Open(dir)
	base := [][]byte{[]byte("old")}
	in.Begin(metaFor(1, 1, base))
	writeAll(t, in, 1, base)
	if err := in.Complete(1); err != nil {
		t.Fatal(err)
	}

	chunks := [][]byte{[]byte("a"), []byte("b")}
	in.Begin(metaFor(2, 7, chunks))
	in.WriteChunk(2, 0, chunks[0])
	// A stale chunk from version 1 mixed into the version-2 stream.
	if err := in.WriteChunk(1, 1, []byte("stale")); !errors.Is(err, ErrVersionMismatch) {
		t.Fatalf("err = %v, want ErrVersionMismatch", err)
	}
	// A chunk from a not-yet-started future version is rejected too.
	if err := in.WriteChunk(3, 1, []byte("future")); !errors.Is(err, ErrVersionMismatch) {
		t.Fatalf("err = %v, want ErrVersionMismatch", err)
	}
	// The in-progress session is undamaged and can finish.
	in.WriteChunk(2, 1, chunks[1])
	if err := in.Complete(2); err != nil {
		t.Fatal(err)
	}
	got, payload, _ := in.Snapshot()
	if got.Version != 2 || !bytes.Equal(payload, []byte("ab")) {
		t.Fatalf("meta=%+v payload=%q", got, payload)
	}
}

func TestBeginNewVersionAbortsStaleSession(t *testing.T) {
	dir := t.TempDir()
	in, _ := Open(dir)
	in.Begin(metaFor(1, 1, [][]byte{[]byte("a")}))
	in.WriteChunk(1, 0, []byte("a"))
	if err := in.Begin(metaFor(2, 2, [][]byte{[]byte("b")})); err != nil {
		t.Fatal(err)
	}
	if err := in.WriteChunk(1, 0, []byte("a")); !errors.Is(err, ErrVersionMismatch) {
		t.Fatalf("stale version write: %v", err)
	}
	in.WriteChunk(2, 0, []byte("b"))
	if err := in.Complete(2); err != nil {
		t.Fatal(err)
	}
	got, payload, _ := in.Snapshot()
	if got.Version != 2 || !bytes.Equal(payload, []byte("b")) {
		t.Fatalf("meta=%+v payload=%q", got, payload)
	}
}

func TestRestartMidInstallKeepsOldState(t *testing.T) {
	dir := t.TempDir()
	in, _ := Open(dir)
	v1 := [][]byte{[]byte("gen-one")}
	in.Begin(metaFor(1, 4, v1))
	writeAll(t, in, 1, v1)
	if err := in.Complete(1); err != nil {
		t.Fatal(err)
	}

	// Start installing version 2, receive some chunks, then "crash".
	v2 := [][]byte{[]byte("gen-"), []byte("two")}
	in.Begin(metaFor(2, 8, v2))
	in.WriteChunk(2, 0, v2[0])

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Installing() {
		t.Fatal("interrupted session should be discarded on restart")
	}
	got, payload, ok := reopened.Snapshot()
	if !ok || got.Version != 1 || !bytes.Equal(payload, []byte("gen-one")) {
		t.Fatalf("old state not intact: meta=%+v payload=%q ok=%v", got, payload, ok)
	}
}

func TestRestartAfterPublishKeepsNewState(t *testing.T) {
	dir := t.TempDir()
	in, _ := Open(dir)
	v1 := [][]byte{[]byte("gen-one")}
	in.Begin(metaFor(1, 4, v1))
	writeAll(t, in, 1, v1)
	in.Complete(1)

	v2 := [][]byte{[]byte("gen-two")}
	in.Begin(metaFor(2, 8, v2))
	writeAll(t, in, 2, v2)
	if err := in.Complete(2); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, payload, ok := reopened.Snapshot()
	if !ok || got.Version != 2 || got.Index != 8 || !bytes.Equal(payload, []byte("gen-two")) {
		t.Fatalf("new state not intact: meta=%+v payload=%q ok=%v", got, payload, ok)
	}
}

// Simulate a crash in the middle of the atomic publish swap, after the
// old snapshot was moved aside but before the new one was renamed in.
func TestCrashDuringSwapRollsBackToOld(t *testing.T) {
	dir := t.TempDir()
	in, _ := Open(dir)
	v1 := [][]byte{[]byte("gen-one")}
	in.Begin(metaFor(1, 4, v1))
	writeAll(t, in, 1, v1)
	in.Complete(1)

	// Crash window: current -> old done, incoming -> current not done.
	if err := os.Rename(filepath.Join(dir, currentDir), filepath.Join(dir, oldDir)); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, payload, ok := reopened.Snapshot()
	if !ok || got.Version != 1 || !bytes.Equal(payload, []byte("gen-one")) {
		t.Fatalf("rollback failed: meta=%+v payload=%q ok=%v", got, payload, ok)
	}
}

// Simulate a crash after the new snapshot was renamed in but before the
// old backup was removed.
func TestCrashDuringSwapRollsForwardToNew(t *testing.T) {
	dir := t.TempDir()
	in, _ := Open(dir)
	v1 := [][]byte{[]byte("gen-one")}
	in.Begin(metaFor(1, 4, v1))
	writeAll(t, in, 1, v1)
	in.Complete(1)

	v2 := [][]byte{[]byte("gen-two")}
	in.Begin(metaFor(2, 8, v2))
	writeAll(t, in, 2, v2)
	in.Complete(2)

	// Recreate the crash window: both current (new) and old exist.
	if err := os.MkdirAll(filepath.Join(dir, oldDir), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFileAtomic(filepath.Join(dir, oldDir, metaFile), []byte(`{"version":1,"index":4,"chunks":1,"digest":"x"}`))
	writeFileAtomic(filepath.Join(dir, oldDir, payloadFile), []byte("gen-one"))

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, payload, ok := reopened.Snapshot()
	if !ok || got.Version != 2 || !bytes.Equal(payload, []byte("gen-two")) {
		t.Fatalf("roll-forward failed: meta=%+v payload=%q ok=%v", got, payload, ok)
	}
	if _, err := os.Stat(filepath.Join(dir, oldDir)); !os.IsNotExist(err) {
		t.Fatal("stale old directory should be removed")
	}
}

func TestOutOfRangeChunk(t *testing.T) {
	dir := t.TempDir()
	in, _ := Open(dir)
	in.Begin(metaFor(1, 1, [][]byte{[]byte("a")}))
	if err := in.WriteChunk(1, 1, []byte("x")); !errors.Is(err, ErrChunkRange) {
		t.Fatalf("err = %v, want ErrChunkRange", err)
	}
	if err := in.WriteChunk(1, -1, []byte("x")); !errors.Is(err, ErrChunkRange) {
		t.Fatalf("err = %v, want ErrChunkRange", err)
	}
}

func TestDoubleBeginSameVersion(t *testing.T) {
	dir := t.TempDir()
	in, _ := Open(dir)
	m := metaFor(1, 1, [][]byte{[]byte("a")})
	in.Begin(m)
	if err := in.Begin(m); !errors.Is(err, ErrSessionActive) {
		t.Fatalf("err = %v, want ErrSessionActive", err)
	}
}
