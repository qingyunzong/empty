package dataeng

import (
	"errors"
	"math"
	"testing"
	"time"
)

func TestHugeImportEndUnknownIsConstantSpaceAndTime(t *testing.T) {
	const huge = uint64(1) << 40

	var context *Context
	var err error
	allocations := testing.AllocsPerRun(1, func() {
		context, err = NewContext(nil, []Import{
			ImportWithMax("giant", 1, huge),
		}, nil)
	})
	if err != nil {
		t.Fatalf("NewContext: %v", err)
	}
	// An implementation that allocated one slot per visible position could
	// not have completed this call at all. The constant allocation count
	// documents that only interval metadata was retained.
	if allocations > 100 {
		t.Fatalf("NewContext allocated %v times for a huge import", allocations)
	}
	if got, want := context.MaxSID(), uint64(huge); got != want {
		t.Fatalf("MaxSID = %d, want %d", got, want)
	}

	start := time.Now()
	last := mustResolve(t, context, huge)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("Resolve at huge end took %v", elapsed)
	}
	if !Equivalent(last, SharedUnknown("giant", huge)) {
		t.Fatalf("last token = %s, want SharedUnknown(giant, %d)", last, huge)
	}
	if sid, found := context.Lookup(SharedUnknown("giant", huge)); !found || sid != huge {
		t.Fatalf("Lookup last unknown = (%d, %v), want (%d, true)", sid, found, huge)
	}
	if _, err := context.Resolve(huge + 1); !errors.Is(err, ErrSIDOutOfRange) {
		t.Fatalf("Resolve past end error = %v", err)
	}

	// The same interval metadata representation is used for an explicitly
	// unknown exact table.
	directory := Directory{Key{"giant", 1}: UnknownTable(huge)}
	context = mustContext(t, nil, []Import{{Name: "giant", Version: 1}}, directory)
	if got := mustResolve(t, context, huge); !Equivalent(got, SharedUnknown("giant", huge)) {
		t.Fatalf("unknown table last token = %s", got)
	}

	// A tiny directory array followed by a huge padded tail must likewise not
	// be expanded.
	directory = Directory{Key{"giant", 1}: []string{"head"}}
	context = mustContext(t, nil, []Import{
		{Name: "giant", Version: 1, MaxID: ptr(huge)},
	}, directory)
	if got := mustResolve(t, context, 1); !Equivalent(got, Known("head")) {
		t.Fatalf("known head = %s", got)
	}
	if got := mustResolve(t, context, huge); !Equivalent(got, SharedUnknown("giant", huge)) {
		t.Fatalf("padded last token = %s", got)
	}
}

func TestTwoNearMaxImportsOverflowRejected(t *testing.T) {
	const half = uint64(1) << 63

	_, err := NewContext(nil, []Import{
		ImportWithMax("first", 1, half),
		ImportWithMax("second", 1, half),
	}, nil)
	if !errors.Is(err, ErrSIDOverflow) {
		t.Fatalf("error = %v, want ErrSIDOverflow", err)
	}

	// Exactly math.MaxUint64 total SIDs is still valid. The second import
	// ends at the largest uint64 and can be resolved without expansion.
	context := mustContext(t, nil, []Import{
		ImportWithMax("first", 1, half),
		ImportWithMax("second", 1, half-1),
	}, nil)
	if got, want := context.MaxSID(), uint64(math.MaxUint64); got != want {
		t.Fatalf("MaxSID = %d, want %d", got, want)
	}
	if got := mustResolve(t, context, math.MaxUint64); !Equivalent(got, SharedUnknown("second", half-1)) {
		t.Fatalf("last token = %s", got)
	}

	if _, err := context.AppendLocal("x"); !errors.Is(err, ErrSIDOverflow) {
		t.Fatalf("AppendLocal at max error = %v", err)
	}
}
