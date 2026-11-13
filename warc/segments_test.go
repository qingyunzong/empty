package warc

import (
	"errors"
	"testing"
)

func TestSegmentReassembly(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeResponse, ID: "<s1>", SegmentNumber: 1, Content: []byte("Hello, ")},
		&Record{Type: TypeContinuation, ID: "<s2>", SegmentNumber: 2, SegmentOriginID: "<s1>", Content: []byte("WARC ")},
		&Record{Type: TypeContinuation, ID: "<s3>", SegmentNumber: 3, SegmentOriginID: "<s1>",
			SegmentTotalLength: int64(len("Hello, WARC world")), Content: []byte("world")},
	)
	if err := g.Resolve(); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	got, ok := g.Reassembled("<s1>")
	if !ok || string(got) != "Hello, WARC world" {
		t.Fatalf("Reassembled = %q, %v", got, ok)
	}
}

func TestSegmentedOriginalFeedsRevisit(t *testing.T) {
	full := "segmented-payload-content"
	part1, part2 := full[:10], full[10:]
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeResponse, ID: "<o1>", SegmentNumber: 1,
			PayloadDigest: sha1Hex(full), Content: []byte(part1)},
		&Record{Type: TypeContinuation, ID: "<o2>", SegmentNumber: 2, SegmentOriginID: "<o1>",
			SegmentTotalLength: int64(len(full)), Content: []byte(part2)},
		&Record{Type: TypeRevisit, ID: "<rev>", RefersTo: "<o1>", PayloadDigest: sha1Hex(full)},
	)
	if err := g.Resolve(); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
}

func TestSegmentGap(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeResponse, ID: "<s1>", SegmentNumber: 1, Content: []byte("a")},
		&Record{Type: TypeContinuation, ID: "<s3>", SegmentNumber: 3, SegmentOriginID: "<s1>",
			SegmentTotalLength: 2, Content: []byte("b")},
	)
	if err := g.Resolve(); !errors.Is(err, ErrSegmentGap) {
		t.Fatalf("Resolve = %v, want ErrSegmentGap", err)
	}
}

func TestSegmentTotalLengthMismatch(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeResponse, ID: "<s1>", SegmentNumber: 1, Content: []byte("ab")},
		&Record{Type: TypeContinuation, ID: "<s2>", SegmentNumber: 2, SegmentOriginID: "<s1>",
			SegmentTotalLength: 5, Content: []byte("cd")},
	)
	if err := g.Resolve(); !errors.Is(err, ErrSegmentTotalLength) {
		t.Fatalf("Resolve = %v, want ErrSegmentTotalLength", err)
	}
}

func TestSegmentMissingOrigin(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeContinuation, ID: "<s2>", SegmentNumber: 2, SegmentOriginID: "<gone>",
			SegmentTotalLength: 1, Content: []byte("x")},
	)
	if err := g.Resolve(); !errors.Is(err, ErrMissingSegmentOrigin) {
		t.Fatalf("Resolve = %v, want ErrMissingSegmentOrigin", err)
	}
}

func TestSegmentMissingTotalLength(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeResponse, ID: "<s1>", SegmentNumber: 1, Content: []byte("ab")},
		&Record{Type: TypeContinuation, ID: "<s2>", SegmentNumber: 2, SegmentOriginID: "<s1>", Content: []byte("cd")},
	)
	if err := g.Resolve(); !errors.Is(err, ErrSegmentTotalLength) {
		t.Fatalf("Resolve = %v, want ErrSegmentTotalLength", err)
	}
}
