package dataeng

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

// batchReference is an independent, deliberately simple implementation of the
// correlation rules. It keeps the full accepted input set and computes the
// expected output for every observation below both watermarks in one batch,
// using linear scans instead of the component's sorted insertion/search.
type batchReference struct {
	observations []Observation
	configs      map[string][]ConfigInterval

	hasOW bool
	ow    int64
	hasCW bool
	cw    int64
}

func newBatchReference() *batchReference {
	return &batchReference{configs: make(map[string][]ConfigInterval)}
}

func (r *batchReference) addObservation(o Observation) error {
	for _, existing := range r.observations {
		if existing.ID == o.ID {
			if reflect.DeepEqual(existing, o) {
				return nil
			}
			return ErrDuplicateID
		}
	}
	if r.hasOW && o.EventTime < r.ow {
		return ErrWatermark
	}
	r.observations = append(r.observations, cloneObservation(o))
	return nil
}

func (r *batchReference) addConfig(in ConfigInterval) error {
	if in.End <= in.Start {
		return ErrInvalidInterval
	}
	for _, existing := range r.configs[in.DeviceID] {
		overlaps := in.Start < existing.End && existing.Start < in.End
		if overlaps {
			if reflect.DeepEqual(existing, in) {
				return nil
			}
			return ErrOverlap
		}
	}
	if r.hasCW && in.Start < r.cw {
		return ErrWatermark
	}
	r.configs[in.DeviceID] = append(r.configs[in.DeviceID], cloneConfig(in))
	return nil
}

func (r *batchReference) advanceOW(w int64) error {
	if r.hasOW && w < r.ow {
		return ErrWatermark
	}
	r.hasOW = true
	r.ow = w
	return nil
}

func (r *batchReference) advanceCW(w int64) error {
	if r.hasCW && w < r.cw {
		return ErrWatermark
	}
	r.hasCW = true
	r.cw = w
	return nil
}

func (r *batchReference) pending() int {
	if !r.hasOW || !r.hasCW {
		return len(r.observations)
	}
	threshold := r.ow
	if r.cw < threshold {
		threshold = r.cw
	}
	n := 0
	for _, o := range r.observations {
		if o.EventTime >= threshold {
			n++
		}
	}
	return n
}

// batch computes the results the component should have emitted so far, in
// emission order. An observation below both watermarks can only be covered by
// a config already accepted: any later config starts at or above the config
// watermark, which is greater than the observation time.
func (r *batchReference) batch() []Result {
	if !r.hasOW || !r.hasCW {
		return nil
	}
	threshold := r.ow
	if r.cw < threshold {
		threshold = r.cw
	}

	var eligible []Observation
	for _, o := range r.observations {
		if o.EventTime < threshold {
			eligible = append(eligible, o)
		}
	}
	sortObservations(eligible)

	results := make([]Result, 0, len(eligible))
	for _, o := range eligible {
		res := Result{Observation: cloneObservation(o)}
		for _, in := range r.configs[o.DeviceID] {
			if in.Start <= o.EventTime && o.EventTime < in.End {
				copyCfg := cloneConfig(in)
				res.Matched = true
				res.Config = &copyCfg
				break
			}
		}
		results = append(results, res)
	}
	return results
}

func sortObservations(os []Observation) {
	for i := 1; i < len(os); i++ {
		for j := i; j > 0; j-- {
			a, b := os[j-1], os[j]
			if a.EventTime > b.EventTime || (a.EventTime == b.EventTime && a.ID > b.ID) {
				os[j-1], os[j] = os[j], os[j-1]
			} else {
				break
			}
		}
	}
}

// TestMatchesBatchReference drives both the component and the independent
// batch reference through the same randomized stream of out-of-order inputs,
// duplicates, conflicts, watermark moves and rejections. Every error, the
// pending count and the complete emitted output must agree.
func TestMatchesBatchReference(t *testing.T) {
	const steps = 4000
	const span = 24
	const devices = 3

	for _, seed := range []int64{20261112, 42, 7, 99, 1234567} {
		t.Run("seed-"+itoa64(seed), func(t *testing.T) {
			runReferenceStream(t, seed, steps, span, devices)
		})
	}
}

func runReferenceStream(t *testing.T, seed int64, steps, span, devices int) {
	t.Helper()

	ref := newBatchReference()
	rec := newRecorder()
	c := NewCorrelator(rec.emit)
	rng := rand.New(rand.NewSource(seed))

	deviceAt := func(i int) string {
		return string(rune('d' + i))
	}

	var idCounter int
	newID := func() string {
		idCounter++
		return "obs-" + itoa(idCounter)
	}

	checkOutput := func(step int) {
		t.Helper()
		want := ref.batch()
		got := rec.snapshot()
		if !resultsEqual(got, want) {
			t.Fatalf("step %d: emitted output diverged from batch reference\n got %+v\nwant %+v", step, got, want)
		}
		if c.Pending() != ref.pending() {
			t.Fatalf("step %d: Pending = %d, reference %d", step, c.Pending(), ref.pending())
		}
	}

	for step := 0; step < steps; step++ {
		switch rng.Intn(10) {
		case 0, 1, 2: // configuration interval (frequent rejects are predicted)
			device := deviceAt(rng.Intn(devices))
			start := rng.Intn(span + 6)
			end := start + 1 + rng.Intn(4)
			in := cfg(device, int64(start), int64(end), "cfg-"+itoa(rng.Intn(5)))
			wantErr := ref.addConfig(in)
			gotErr := c.AddConfig(in)
			if !sameErrorClass(gotErr, wantErr) {
				t.Fatalf("step %d AddConfig %+v: got %v, want %v", step, in, gotErr, wantErr)
			}

		case 3, 4, 5, 6: // observation, sometimes a re-delivery
			var o Observation
			if len(ref.observations) > 0 && rng.Intn(4) == 0 {
				o = cloneObservation(ref.observations[rng.Intn(len(ref.observations))])
				if rng.Intn(2) == 0 {
					o.Payload = append(o.Payload, '-') // conflicting re-delivery
				}
			} else {
				o = obs(newID(), deviceAt(rng.Intn(devices)), int64(rng.Intn(span)), "p"+itoa(rng.Intn(8)))
			}
			wantErr := ref.addObservation(o)
			gotErr := c.AddObservation(o)
			if !sameErrorClass(gotErr, wantErr) {
				t.Fatalf("step %d AddObservation %+v: got %v, want %v", step, o, gotErr, wantErr)
			}

		case 7: // observation watermark
			w := int64(rng.Intn(span + 2))
			wantErr := ref.advanceOW(w)
			gotErr := c.AdvanceObservationWatermark(w)
			if !sameErrorClass(gotErr, wantErr) {
				t.Fatalf("step %d OW(%d): got %v, want %v", step, w, gotErr, wantErr)
			}

		case 8: // configuration watermark
			w := int64(rng.Intn(span + 2))
			wantErr := ref.advanceCW(w)
			gotErr := c.AdvanceConfigWatermark(w)
			if !sameErrorClass(gotErr, wantErr) {
				t.Fatalf("step %d CW(%d): got %v, want %v", step, w, gotErr, wantErr)
			}

		case 9: // identical re-delivery of an accepted config interval
			var accepted []ConfigInterval
			for _, list := range ref.configs {
				accepted = append(accepted, list...)
			}
			if len(accepted) > 0 {
				in := cloneConfig(accepted[rng.Intn(len(accepted))])
				if err := c.AddConfig(in); err != nil {
					t.Fatalf("step %d identical config re-delivery: %v", step, err)
				}
				if err := ref.addConfig(in); err != nil {
					t.Fatalf("step %d reference identical re-delivery: %v", step, err)
				}
			}
		}

		checkOutput(step)
	}

	// Drive both watermarks past every possible timestamp: every accepted
	// observation must now be emitted and match the final batch result.
	if err := c.AdvanceObservationWatermark(int64(span + 100)); err != nil {
		t.Fatalf("final OW: %v", err)
	}
	if err := ref.advanceOW(int64(span + 100)); err != nil {
		t.Fatalf("final reference OW: %v", err)
	}
	if err := c.AdvanceConfigWatermark(int64(span + 100)); err != nil {
		t.Fatalf("final CW: %v", err)
	}
	if err := ref.advanceCW(int64(span + 100)); err != nil {
		t.Fatalf("final reference CW: %v", err)
	}

	want := ref.batch()
	got := rec.snapshot()
	if !resultsEqual(got, want) {
		t.Fatalf("final output diverged from batch reference\n got %d results, want %d", len(got), len(want))
	}
	if len(got) != len(ref.observations) {
		t.Fatalf("emitted %d of %d accepted observations", len(got), len(ref.observations))
	}
	if c.Pending() != 0 {
		t.Fatalf("Pending = %d, want 0", c.Pending())
	}

	// Every emitted payload is independently owned by the callback.
	for _, r := range got {
		if r.Matched && len(r.Config.Payload) == 0 {
			t.Fatal("unexpected empty config payload")
		}
	}
}

func sameErrorClass(got, want error) bool {
	return (got == nil) == (want == nil) && (got == nil || errors.Is(got, want))
}

func resultsEqual(got, want []Result) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if !reflect.DeepEqual(got[i], want[i]) {
			return false
		}
	}
	return true
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func itoa64(n int64) string {
	return itoa(int(n))
}
