package dataeng

import (
	"context"
	"errors"
	"testing"
)

type fixedSource struct {
	value Key
	err   error
	calls int
}

func (s *fixedSource) MaxAutoIncrementKey(context.Context) (Key, error) {
	s.calls++
	return s.value, s.err
}

func TestCaptureSnapshotReadsTheCeilingOnce(t *testing.T) {
	src := &fixedSource{value: 42}
	s, err := CaptureSnapshot(context.Background(), src, WithStartKey(1))
	if err != nil {
		t.Fatalf("CaptureSnapshot: %v", err)
	}
	if src.calls != 1 {
		t.Fatalf("source called %d times, want 1", src.calls)
	}
	if s.Ceiling() != 42 || s.Watermark() != 42 {
		t.Fatalf("ceiling = %d, watermark = %d", s.Ceiling(), s.Watermark())
	}
	if _, _, err := s.Next(s.Lower(), 10); err != nil {
		t.Fatalf("Next: %v", err)
	}
	if src.calls != 1 {
		t.Fatalf("scanning re-read the source: %d calls", src.calls)
	}
}

func TestCaptureSnapshotErrors(t *testing.T) {
	if _, err := CaptureSnapshot(context.Background(), nil); !errors.Is(err, ErrNilSource) {
		t.Fatalf("nil source error = %v", err)
	}
	want := errors.New("boom")
	if _, err := CaptureSnapshot(context.Background(), &fixedSource{err: want}); !errors.Is(err, want) {
		t.Fatalf("source error = %v", err)
	}
}
