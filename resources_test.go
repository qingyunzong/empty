package formal

import (
	"errors"
	"math"
	"reflect"
	"testing"
)

func TestResourcesHelpers(t *testing.T) {
	base := Resources{"cpu": 4, "mem": 2}
	clone := base.Clone()
	clone["cpu"] = 9
	if base["cpu"] != 4 {
		t.Fatalf("Clone aliased the original map")
	}
	if got := base.Get("cpu"); got != 4 {
		t.Fatalf("Get(cpu) = %d", got)
	}
	if got := base.Get("gpu"); got != 0 {
		t.Fatalf("Get(gpu) = %d", got)
	}
	if !reflect.DeepEqual(base.Keys(), []string{"cpu", "mem"}) {
		t.Fatalf("Keys = %v", base.Keys())
	}
	if !base.Equal(Resources{"cpu": 4, "mem": 2, "gpu": 0}) {
		t.Fatalf("Equal should ignore zero entries")
	}
	if base.Equal(Resources{"cpu": 4}) {
		t.Fatalf("Equal should detect missing non-zero entries")
	}
	if (Resources{"cpu": -1}).Validate() == nil {
		t.Fatalf("Validate accepted a negative amount")
	}
	if (Resources{"cpu": 0}).IsZero() != true {
		t.Fatalf("IsZero = false")
	}
}

func TestMulDivOverflowFallback(t *testing.T) {
	quotient, remainder := mulDiv(math.MaxInt64, 2, math.MaxInt64)
	if quotient != 2 || remainder != 0 {
		t.Fatalf("mulDiv = %d r%d, want 2 r0", quotient, remainder)
	}
	quotient, remainder = mulDiv(math.MaxInt64, math.MaxInt64, math.MaxInt64)
	if quotient != math.MaxInt64 || remainder != 0 {
		t.Fatalf("mulDiv big = %d r%d, want MaxInt64 r0", quotient, remainder)
	}
}

func TestSafeAddOverflow(t *testing.T) {
	if _, ok := safeAdd(math.MaxInt64, 1); ok {
		t.Fatalf("safeAdd did not detect positive overflow")
	}
	if _, ok := safeAdd(math.MinInt64, -1); ok {
		t.Fatalf("safeAdd did not detect negative overflow")
	}
	if got, ok := safeAdd(2, 3); !ok || got != 5 {
		t.Fatalf("safeAdd(2,3) = %d,%v", got, ok)
	}
}

func TestShortfallError(t *testing.T) {
	err := &ShortfallError{Missing: Resources{"cpu": 2}}
	if !errors.Is(err, ErrReclaimShortfall) {
		t.Fatalf("errors.Is failed")
	}
	if err.Error() == "" {
		t.Fatalf("empty error string")
	}
}
