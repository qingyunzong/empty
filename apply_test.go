package dataeng

import (
	"errors"
	"math"
	"math/rand"
	"testing"
)

// expand is the small-scale reference: it fully decodes a stream.
func expand(t *testing.T, segs []Segment) []bool {
	t.Helper()
	var out []bool
	for _, s := range segs {
		n, err := s.length()
		if err != nil {
			t.Fatalf("expand: invalid segment: %v", err)
		}
		if n > 1<<20 {
			t.Fatalf("expand: segment too large for reference decoding")
		}
		for i := uint64(0); i < n; i++ {
			if s.Kind == RunKind {
				out = append(out, s.Value)
			} else {
				out = append(out, s.bitAt(i))
			}
		}
	}
	return out
}

func checkNormalized(t *testing.T, got []Segment, want []bool) {
	t.Helper()
	for i, s := range got {
		if s.Kind != RunKind {
			t.Fatalf("output segment %d is not a run: %v", i, s.Kind)
		}
		if s.Count == 0 {
			t.Fatalf("output segment %d has zero count", i)
		}
		if i > 0 && got[i-1].Value == s.Value {
			t.Fatalf("output not maximal: segments %d and %d share value %v", i-1, i, s.Value)
		}
	}
	gotFlat := expand(t, got)
	if len(gotFlat) != len(want) {
		t.Fatalf("expanded length %d, want %d", len(gotFlat), len(want))
	}
	for i := range want {
		if gotFlat[i] != want[i] {
			t.Fatalf("row %d: got %v, want %v", i, gotFlat[i], want[i])
		}
	}
}

func refApply(op Op, a, b []bool) []bool {
	out := make([]bool, len(a))
	for i := range a {
		out[i] = op.apply(a[i], b[i])
	}
	return out
}

// randomStream builds a random stream of exactly total rows.
func randomStream(r *rand.Rand, total int) []Segment {
	var segs []Segment
	for total > 0 {
		n := 1 + r.Intn(total)
		if n > 37 {
			n = 1 + r.Intn(37)
		}
		if r.Intn(2) == 0 {
			segs = append(segs, Run(r.Intn(2) == 0, uint64(n)))
		} else {
			bits := make([]byte, (n+7)/8)
			for i := range bits {
				bits[i] = byte(r.Intn(256))
			}
			if rem := n % 8; rem != 0 {
				bits[len(bits)-1] &= 1<<rem - 1
			}
			segs = append(segs, Literal(bits, uint64(n)))
		}
		total -= n
	}
	return segs
}

func TestApplyAgainstExpansionReference(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	ops := []Op{OpAnd, OpOr, OpXor}
	for trial := 0; trial < 500; trial++ {
		total := r.Intn(200)
		a := randomStream(r, total)
		b := randomStream(r, total)
		op := ops[r.Intn(len(ops))]
		got, err := Apply(op, a, b)
		if err != nil {
			t.Fatalf("trial %d: unexpected error: %v", trial, err)
		}
		want := refApply(op, expand(t, a), expand(t, b))
		checkNormalized(t, got, want)
	}
}

func TestCrossSegmentSeams(t *testing.T) {
	// Boundaries fall at different offsets in the two streams and inside
	// literal bytes; equal values across the seam must coalesce.
	a := []Segment{
		Run(true, 3),
		Literal([]byte{0b00101101, 0b00000001}, 9),
		Run(false, 4),
	}
	b := []Segment{
		Literal([]byte{0b11110000, 0b00000011}, 10),
		Run(true, 6),
	}
	aFlat := expand(t, a)
	bFlat := expand(t, b)
	for _, op := range []Op{OpAnd, OpOr, OpXor} {
		got, err := Apply(op, a, b)
		if err != nil {
			t.Fatalf("op %d: %v", op, err)
		}
		checkNormalized(t, got, refApply(op, aFlat, bFlat))
	}
}

func TestEmptyStreams(t *testing.T) {
	for _, op := range []Op{OpAnd, OpOr, OpXor} {
		got, err := Apply(op, nil, nil)
		if err != nil {
			t.Fatalf("op %d: %v", op, err)
		}
		if len(got) != 0 {
			t.Fatalf("op %d: expected empty result, got %v", op, got)
		}
	}
	// Zero-length segments are legal no-ops.
	got, err := And(
		[]Segment{Run(true, 0), Literal(nil, 0), Run(true, 2)},
		[]Segment{Literal(nil, 0), Run(true, 2)},
	)
	if err != nil {
		t.Fatal(err)
	}
	checkNormalized(t, got, []bool{true, true})
}

func TestHugeRuns(t *testing.T) {
	max := uint64(math.MaxUint64)
	cases := []struct {
		name string
		op   Op
		a, b []Segment
		want []Segment
	}{
		{"and full", OpAnd, []Segment{Run(true, max)}, []Segment{Run(true, max)}, []Segment{Run(true, max)}},
		{"xor full", OpXor, []Segment{Run(true, max)}, []Segment{Run(true, max)}, []Segment{Run(false, max)}},
		{"or absorbs", OpOr, []Segment{Run(false, max-5), Run(true, 5)}, []Segment{Run(true, max)}, []Segment{Run(true, max)}},
		{
			// Seam at a huge offset: complementary runs produce
			// false-true-false with a maximal middle run.
			"seam coalesces", OpAnd,
			[]Segment{Run(true, max-1), Run(false, 1)},
			[]Segment{Run(false, 1), Run(true, max-1)},
			[]Segment{Run(false, 1), Run(true, max-2), Run(false, 1)},
		},
		{
			// Literal-to-run seam at uint64 scale: AND with an all-true
			// column returns the input, coalesced across the seam.
			"literal seam against huge run", OpAnd,
			[]Segment{Literal([]byte{0b00000101}, 3), Run(true, max-3)},
			[]Segment{Run(true, max)},
			[]Segment{Run(true, 1), Run(false, 1), Run(true, max-2)},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Apply(tc.op, tc.a, tc.b)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i].Kind != RunKind || got[i].Value != tc.want[i].Value || got[i].Count != tc.want[i].Count {
					t.Fatalf("segment %d: got %+v, want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestInvalidInputsProduceNoPartialResult(t *testing.T) {
	max := uint64(math.MaxUint64)
	ok := []Segment{Run(true, 4)}
	cases := []struct {
		name string
		a, b []Segment
	}{
		{"length mismatch", []Segment{Run(true, 3)}, ok},
		{"empty vs non-empty", nil, ok},
		{"overflow left", []Segment{Run(true, max), Run(false, 1)}, ok},
		{"overflow right", ok, []Segment{Run(true, max), Run(false, 1)}},
		{"literal wrong byte count", []Segment{Literal([]byte{0, 0}, 3)}, ok},
		{"literal missing byte", []Segment{Literal([]byte{1}, 9)}, ok},
		{"literal non-zero tail bits", []Segment{Literal([]byte{0b11110000}, 4)}, ok},
		{"unknown kind", []Segment{{Kind: Kind(42), Count: 4}}, ok},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, op := range []Op{OpAnd, OpOr, OpXor} {
				got, err := Apply(op, tc.a, tc.b)
				if err == nil {
					t.Fatalf("op %d: expected error, got %v", op, got)
				}
				if got != nil {
					t.Fatalf("op %d: partial result %v returned with error %v", op, got, err)
				}
			}
		})
	}
}

func TestLengthOverflowErrorIdentity(t *testing.T) {
	_, err := validateStream([]Segment{Run(true, math.MaxUint64), Run(true, 1)})
	if !errors.Is(err, ErrLengthOverflow) {
		t.Fatalf("expected ErrLengthOverflow, got %v", err)
	}
	_, err = And([]Segment{Run(true, 1)}, []Segment{Run(true, 2)})
	if !errors.Is(err, ErrLengthMismatch) {
		t.Fatalf("expected ErrLengthMismatch, got %v", err)
	}
}
