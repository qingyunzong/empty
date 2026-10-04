package counter

import (
	"errors"
	"math/rand"
	"testing"
)

func mustNew(t *testing.T, width uint, allowWrap bool) *Counter {
	t.Helper()
	c, err := New(width, allowWrap)
	if err != nil {
		t.Fatalf("New(%d, %v): %v", width, allowWrap, err)
	}
	return c
}

// --- Handwritten boundary cases ---

func TestPlainIncrease(t *testing.T) {
	c := mustNew(t, 8, true)
	res, err := c.Process([]Reading{
		{Time: 1, Value: 10},
		{Time: 2, Value: 25},
		{Time: 3, Value: 25}, // equal: zero delta
		{Time: 4, Value: 100},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 90 || res.Known != 3 || len(res.Unknown) != 0 {
		t.Fatalf("got %+v, want Total=90 Known=3 no unknowns", res)
	}
}

func TestSingleWrapCompensated(t *testing.T) {
	c := mustNew(t, 4, true) // modulus 16
	res, err := c.Process([]Reading{
		{Time: 1, Value: 14},
		{Time: 2, Value: 2}, // 14 -> 15 -> 0 -> 1 -> 2: delta 4
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 4 || res.Known != 1 || len(res.Unknown) != 0 {
		t.Fatalf("got %+v, want Total=4 Known=1 no unknowns", res)
	}
}

func TestWrapAtExactBoundary(t *testing.T) {
	c := mustNew(t, 8, true)
	res, err := c.Process([]Reading{
		{Time: 1, Value: 255}, // max value
		{Time: 2, Value: 0},   // exactly one tick past wrap
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 1 {
		t.Fatalf("got Total=%d, want 1", res.Total)
	}
}

func TestDecreaseWithoutWrapIsUnknown(t *testing.T) {
	c := mustNew(t, 8, false)
	res, err := c.Process([]Reading{
		{Time: 1, Value: 200},
		{Time: 2, Value: 50},
		{Time: 3, Value: 60},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 10 || res.Known != 1 {
		t.Fatalf("got Total=%d Known=%d, want 10/1", res.Total, res.Known)
	}
	if len(res.Unknown) != 1 || res.Unknown[0] != (Interval{Start: 1, End: 2, Reason: "decrease without wrap"}) {
		t.Fatalf("unknowns: %+v", res.Unknown)
	}
}

func TestExplicitReset(t *testing.T) {
	c := mustNew(t, 8, true)
	res, err := c.Process([]Reading{
		{Time: 1, Value: 100},
		{Time: 2, Value: 150},            // +50
		{Time: 3, Value: 5, Reset: true}, // reset: interval unknown, new baseline 5
		{Time: 4, Value: 20},             // +15
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 65 || res.Known != 2 {
		t.Fatalf("got Total=%d Known=%d, want 65/2", res.Total, res.Known)
	}
	if len(res.Unknown) != 1 || res.Unknown[0] != (Interval{Start: 2, End: 3, Reason: "explicit reset"}) {
		t.Fatalf("unknowns: %+v", res.Unknown)
	}
}

func TestResetWithoutDecreaseIsStillUnknown(t *testing.T) {
	c := mustNew(t, 8, true)
	res, err := c.Process([]Reading{
		{Time: 1, Value: 10},
		{Time: 2, Value: 90, Reset: true}, // value rose, but reset flag dominates
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 0 || res.Known != 0 || len(res.Unknown) != 1 {
		t.Fatalf("got %+v, want one unknown interval", res)
	}
}

func TestDuplicateTimeKeepsHighestVersion(t *testing.T) {
	c := mustNew(t, 16, true)
	res, err := c.Process([]Reading{
		{Time: 1, Value: 100, Version: 1},
		{Time: 2, Value: 110, Version: 1}, // stale duplicate
		{Time: 2, Value: 130, Version: 3}, // winner
		{Time: 2, Value: 120, Version: 2},
		{Time: 3, Value: 140, Version: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Effective stream: 100 -> 130 -> 140, total 40.
	if res.Total != 40 || res.Known != 2 || len(res.Unknown) != 0 {
		t.Fatalf("got %+v, want Total=40 Known=2", res)
	}
}

func TestDuplicateTimeVersionTieKeepsLaterInput(t *testing.T) {
	c := mustNew(t, 16, true)
	res, err := c.Process([]Reading{
		{Time: 1, Value: 7, Version: 5},
		{Time: 1, Value: 9, Version: 5}, // same version, later input wins
		{Time: 2, Value: 20, Version: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 11 { // 9 -> 20
		t.Fatalf("got Total=%d, want 11", res.Total)
	}
}

func TestUnorderedInputIsSorted(t *testing.T) {
	c := mustNew(t, 8, true)
	res, err := c.Process([]Reading{
		{Time: 3, Value: 30},
		{Time: 1, Value: 10},
		{Time: 2, Value: 20},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 20 {
		t.Fatalf("got Total=%d, want 20", res.Total)
	}
}

func TestWidth64Wrap(t *testing.T) {
	c := mustNew(t, 64, true)
	res, err := c.Process([]Reading{
		{Time: 1, Value: ^uint64(0) - 3},
		{Time: 2, Value: 4}, // wrapped across 2^64
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 8 {
		t.Fatalf("got Total=%d, want 8", res.Total)
	}
}

func TestValueOverflowRejected(t *testing.T) {
	c := mustNew(t, 4, true)
	_, err := c.Process([]Reading{{Time: 1, Value: 16}}) // needs 5 bits
	if !errors.Is(err, ErrValueOverflow) {
		t.Fatalf("got %v, want ErrValueOverflow", err)
	}
	// Width 64 accepts every uint64.
	c64 := mustNew(t, 64, true)
	if _, err := c64.Process([]Reading{{Time: 1, Value: ^uint64(0)}}); err != nil {
		t.Fatalf("width 64 rejected max uint64: %v", err)
	}
}

func TestInvalidWidth(t *testing.T) {
	for _, w := range []uint{0, 65, 100} {
		if _, err := New(w, true); err == nil {
			t.Fatalf("New(%d) succeeded, want error", w)
		}
	}
}

func TestEmptyAndSingleInput(t *testing.T) {
	c := mustNew(t, 8, true)
	for _, in := range [][]Reading{nil, {{Time: 5, Value: 42}}} {
		res, err := c.Process(in)
		if err != nil {
			t.Fatal(err)
		}
		if res.Total != 0 || res.Known != 0 || len(res.Unknown) != 0 {
			t.Fatalf("got %+v for %v, want empty result", res, in)
		}
	}
}

// --- Reconstruction model cross-check ---
//
// Simulate a ground-truth counter of the given width. At each step the
// model applies a random increment (chosen so at most one wrap occurs
// before the next sample) or an explicit reset, then emits a reading.
// The library's computable total must equal the model's true increments
// summed over non-reset intervals, and the unknown intervals must be
// exactly the reset intervals.

func TestReconstructionModel(t *testing.T) {
	for _, width := range []uint{4, 8, 16, 64} {
		t.Run(widthName(width), func(t *testing.T) {
			runModel(t, width, 2000, 12345+int64(width))
		})
	}
}

func widthName(w uint) string {
	return string(rune('0'+w/10)) + string(rune('0'+w%10)) + "bit"
}

func runModel(t *testing.T, width uint, steps int, seed int64) {
	rng := rand.New(rand.NewSource(seed))
	var modulus uint64
	var mask uint64 = ^uint64(0)
	if width < 64 {
		modulus = uint64(1) << width
		mask = modulus - 1
	}

	var readings []Reading
	var trueValue uint64
	var wantTotal uint64
	var wantUnknown []Interval
	prevTime := int64(-1)

	emit := func(time int64, reset bool) {
		readings = append(readings, Reading{Time: time, Value: trueValue, Reset: reset})
	}

	emit(0, false)
	prevTime = 0
	for i := 1; i < steps; i++ {
		time := int64(i)
		if rng.Intn(20) == 0 {
			// Explicit reset: true delta across this interval is lost.
			if width < 64 {
				trueValue = uint64(rng.Intn(int(modulus)))
			} else {
				trueValue = rng.Uint64()
			}
			wantUnknown = append(wantUnknown, Interval{Start: prevTime, End: time, Reason: "explicit reset"})
			emit(time, true)
		} else {
			// Random increment, bounded so at most one wrap occurs.
			var inc uint64
			if width < 64 {
				inc = uint64(rng.Intn(int(modulus)))
			} else {
				inc = rng.Uint64()
			}
			trueValue = (trueValue + inc) & mask
			wantTotal += inc
			emit(time, false)
		}
		prevTime = time
	}

	// Shuffle input order and inject stale duplicates with lower versions;
	// the result must be unaffected.
	shuffled := make([]Reading, 0, len(readings)*2)
	for _, r := range readings {
		shuffled = append(shuffled, r)
		if rng.Intn(10) == 0 {
			stale := r
			stale.Version = -1
			stale.Value = rng.Uint64() & mask
			stale.Reset = false
			shuffled = append(shuffled, stale)
		}
	}
	rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })

	c := mustNew(t, width, true)
	res, err := c.Process(shuffled)
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != wantTotal {
		t.Fatalf("width %d: Total=%d, model wants %d", width, res.Total, wantTotal)
	}
	if res.Known != steps-1-len(wantUnknown) {
		t.Fatalf("width %d: Known=%d, want %d", width, res.Known, steps-1-len(wantUnknown))
	}
	if len(res.Unknown) != len(wantUnknown) {
		t.Fatalf("width %d: %d unknown intervals, want %d", width, len(res.Unknown), len(wantUnknown))
	}
	for i, iv := range wantUnknown {
		if res.Unknown[i] != iv {
			t.Fatalf("width %d: unknown[%d]=%+v, want %+v", width, i, res.Unknown[i], iv)
		}
	}
}
