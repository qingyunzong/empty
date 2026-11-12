package dataeng_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"testing"

	dataeng "example.org/dataeng/q0266"
)

// TestHereBoundary straddles the baseline/target junction with HERE: a copy
// anchored exactly at the junction reads the last baseline byte and the first
// target byte in one COPY.
func TestHereBoundary(t *testing.T) {
	base, _ := baseline(t, "0123456789")
	span := int64(10)

	ins := []dataeng.Instruction{
		dataeng.Add{Bytes: []byte("XY")}, // target len 2
		// HERE = S + 2 - 3 = 9 -> baseline '9', then target 'X'.
		dataeng.Copy{Mode: dataeng.CopyHere, Length: 2, Operand: 3},
		// len 4, operand 5 -> address 9 -> '9', then 'X'.
		dataeng.Copy{Mode: dataeng.CopyHere, Length: 2, Operand: 5},
		// Pure target side: len 6, operand 2 -> address 14 = target[4]='X', then 'Y'.
		dataeng.Copy{Mode: dataeng.CopyHere, Length: 2, Operand: 2},
	}
	want := []byte("XY9X9X9X")
	w := mustWindow(t, "here", span, 0, want, ins)

	res, _ := applyOK(t, base, []dataeng.Window{w}, dataeng.Limits{})
	if !bytes.Equal(res.Resource, want) {
		t.Fatalf("resource = %q, want %q", res.Resource, want)
	}

	// HERE operand larger than S + current length resolves negative.
	bad := dataeng.Window{
		ID: "here-bad", Span: span, TargetLength: 1,
		Instructions: []dataeng.Instruction{
			dataeng.Copy{Mode: dataeng.CopyHere, Length: 1, Operand: span + 1},
		},
		TargetSHA256: [32]byte{},
	}
	applyErr(t, base, []dataeng.Window{bad}, dataeng.ErrAddress)
}

// TestOverlappingCopyGrowsLongRepeat ensures a COPY reading inside the target
// it is extending produces a long repeating run byte by byte, instead of
// snapshotting the source before the copy.
func TestOverlappingCopyGrowsLongRepeat(t *testing.T) {
	raw := []byte("zzzzzzzz")
	base := dataeng.Baseline{
		ReaderAt: bytes.NewReader(raw),
		Length:   int64(len(raw)),
		SHA256:   sha256.Sum256(raw),
	}

	ins := []dataeng.Instruction{
		dataeng.Add{Bytes: []byte("ab")},
		// HERE at len 2, operand 2 -> address S (target[0]='a'); copy 30
		// bytes, repeatedly reading bytes produced by the same COPY.
		dataeng.Copy{Mode: dataeng.CopyHere, Length: 30, Operand: 2},
	}
	want := append([]byte("ab"), bytes.Repeat([]byte("ab"), 15)...)
	if len(want) != 32 {
		t.Fatalf("want length %d", len(want))
	}
	w := mustWindow(t, "overlap", 8, 0, want, ins)

	res, _ := applyOK(t, base, []dataeng.Window{w}, dataeng.Limits{})
	if !bytes.Equal(res.Resource, want) {
		t.Fatalf("overlap result mismatch: got %q want %q", res.Resource, want)
	}
}

// TestEmptyTargetWindow covers the zero-output window rule: T=0 is rejected
// rather than contributing an empty resource fragment.
func TestEmptyTargetWindow(t *testing.T) {
	base, _ := baseline(t, "abc")
	empty := dataeng.Window{
		ID: "empty", Span: 3, BaseOffset: 0, TargetLength: 0,
		Instructions: nil, TargetSHA256: sha256.Sum256(nil),
	}
	applyErr(t, base, []dataeng.Window{empty}, dataeng.ErrZeroLength)

	// Two ADD windows succeed and keep isolated caches; the second window
	// cannot observe the first window's near/same state.
	w1 := mustWindow(t, "w1", 3, 0, []byte("A"),
		[]dataeng.Instruction{dataeng.Add{Bytes: []byte("A")}})
	w2 := mustWindow(t, "w2", 3, 0, []byte("B"),
		[]dataeng.Instruction{dataeng.Add{Bytes: []byte("B")}})
	res, _ := applyOK(t, base, []dataeng.Window{w1, w2}, dataeng.Limits{})
	if string(res.Resource) != "AB" {
		t.Fatalf("resource = %q, want AB", res.Resource)
	}
}

// flakyStore fails the first commit of each unseen ID, simulating an unknown
// transaction outcome; nothing is recorded until a real commit succeeds.
type flakyStore struct {
	inner   *dataeng.MemoryStore
	pending map[string]bool
}

func newFlakyStore() *flakyStore {
	return &flakyStore{inner: dataeng.NewMemoryStore(), pending: map[string]bool{}}
}

func (f *flakyStore) Lookup(ctx context.Context, id string) (dataeng.Record, bool, error) {
	return f.inner.Lookup(ctx, id)
}

func (f *flakyStore) Commit(ctx context.Context, id string, rec dataeng.Record) error {
	if id == "g1" && !f.pending[id] {
		f.pending[id] = true
		return errors.New("network reset: commit outcome unknown")
	}
	return f.inner.Commit(ctx, id, rec)
}

// TestRecoveryAfterFailure checks ambiguous-commit recovery, that a failed
// window contributes nothing, and that a later retry resumes the sequence.
func TestRecoveryAfterFailure(t *testing.T) {
	base, _ := baseline(t, "abcdef")

	good1 := mustWindow(t, "g1", 6, 0, []byte("ab"),
		[]dataeng.Instruction{dataeng.Add{Bytes: []byte("ab")}})
	good2 := mustWindow(t, "g2", 6, 0, []byte("cd"),
		[]dataeng.Instruction{dataeng.Add{Bytes: []byte("cd")}})

	// First attempt: ambiguous commit followed by an empty lookup.
	flaky := newFlakyStore()
	app := &dataeng.Applier{Baseline: base, Store: flaky}
	if _, err := app.Apply(context.Background(), []dataeng.Window{good1}); !errors.Is(err, dataeng.ErrAmbiguousCommit) {
		t.Fatalf("expected ambiguous commit, got %v", err)
	}
	if _, found, _ := flaky.Lookup(context.Background(), "g1"); found {
		t.Fatal("failed window must not be committed")
	}

	// Retry: the second commit attempt succeeds, then g2 applies normally.
	res, err := app.Apply(context.Background(), []dataeng.Window{good1, good2})
	if err != nil {
		t.Fatalf("retry failed: %v", err)
	}
	if string(res.Resource) != "abcd" {
		t.Fatalf("resource after recovery = %q, want abcd", res.Resource)
	}
	if len(res.Committed) != 2 || len(res.Skipped) != 0 {
		t.Fatalf("commit accounting wrong: %+v", res)
	}

	// Third call is idempotent: both windows skip and are never rebuilt.
	res2, err := app.Apply(context.Background(), []dataeng.Window{good1, good2})
	if err != nil {
		t.Fatalf("idempotent replay failed: %v", err)
	}
	if string(res2.Resource) != "abcd" || len(res2.Skipped) != 2 || len(res2.Committed) != 0 {
		t.Fatalf("replay accounting wrong: %+v", res2)
	}
}

// ambiguousButPersistedStore returns a commit error while actually persisting
// the record, modeling "commit result unknown" that later resolves as success.
type ambiguousButPersistedStore struct {
	inner *dataeng.MemoryStore
}

func (s *ambiguousButPersistedStore) Lookup(ctx context.Context, id string) (dataeng.Record, bool, error) {
	return s.inner.Lookup(ctx, id)
}

func (s *ambiguousButPersistedStore) Commit(ctx context.Context, id string, rec dataeng.Record) error {
	if err := s.inner.Commit(ctx, id, rec); err != nil {
		return err
	}
	return errors.New("timeout after durable commit")
}

func TestAmbiguousCommitResolvesAsCommitted(t *testing.T) {
	base, _ := baseline(t, "abc")
	w := mustWindow(t, "w", 3, 0, []byte("zz"),
		[]dataeng.Instruction{dataeng.Run{Byte: 'z', Count: 2}})

	store := &ambiguousButPersistedStore{inner: dataeng.NewMemoryStore()}
	res, err := (&dataeng.Applier{Baseline: base, Store: store}).Apply(context.Background(), []dataeng.Window{w})
	if err != nil {
		t.Fatalf("expected recovery, got %v", err)
	}
	if len(res.Committed) != 0 || len(res.Skipped) != 1 {
		t.Fatalf("window should be counted as recovered/skipped: %+v", res)
	}
	if string(res.Resource) != "zz" {
		t.Fatalf("resource = %q", res.Resource)
	}

	// A second call must find it already committed and skip it outright.
	res2, err := (&dataeng.Applier{Baseline: base, Store: store}).Apply(context.Background(), []dataeng.Window{w})
	if err != nil {
		t.Fatalf("replay failed: %v", err)
	}
	if len(res2.Skipped) != 1 || len(res2.Committed) != 0 {
		t.Fatalf("replay accounting wrong: %+v", res2)
	}
}
