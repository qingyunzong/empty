package dataeng

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"math/rand"
	"slices"
	"testing"
)

// sortEvents orders events by (time, ID) with IDs compared as UTF-8 bytes.
func sortEvents(events []Event) {
	slices.SortFunc(events, func(x, y Event) int {
		if x.Time < y.Time {
			return -1
		}
		if x.Time > y.Time {
			return 1
		}
		if x.ID < y.ID {
			return -1
		}
		if x.ID > y.ID {
			return 1
		}
		return 0
	})
}

// oracleJoin is an independent brute-force implementation using arbitrary
// precision integers, so int64 endpoint arithmetic cannot overflow.
func oracleJoin(t *testing.T, lefts, rights []Event, a, b int64) []Group {
	t.Helper()
	groups := make([]Group, 0, len(lefts))
	ab, bb := big.NewInt(a), big.NewInt(b)
	for _, left := range lefts {
		lt := big.NewInt(left.Time)
		lo := new(big.Int).Sub(lt, ab)
		hi := new(big.Int).Add(lt, bb)
		matches := make([]Event, 0)
		for _, right := range rights {
			if right.Key != left.Key {
				continue
			}
			rt := big.NewInt(right.Time)
			if rt.Cmp(lo) >= 0 && rt.Cmp(hi) <= 0 {
				matches = append(matches, right)
			}
		}
		sortEvents(matches)
		groups = append(groups, Group{Left: left, Matches: matches})
	}
	slices.SortFunc(groups, func(x, y Group) int {
		if x.Left.Time != y.Left.Time {
			if x.Left.Time < y.Left.Time {
				return -1
			}
			return 1
		}
		if x.Left.ID < y.Left.ID {
			return -1
		}
		if x.Left.ID > y.Left.ID {
			return 1
		}
		return 0
	})
	return groups
}

func assertGroups(t *testing.T, got, want []Group) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("group count: got %d, want %d\ngot=%v\nwant=%v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i].Left != want[i].Left {
			t.Fatalf("group %d left: got %v, want %v", i, got[i].Left, want[i].Left)
		}
		if !slices.Equal(got[i].Matches, want[i].Matches) {
			t.Fatalf("group %d (%s) matches: got %v, want %v", i, want[i].Left.ID, got[i].Matches, want[i].Matches)
		}
	}
}

func mustPush(t *testing.T, j *Joiner, side Side, event Event) {
	t.Helper()
	if err := j.Push(side, event); err != nil {
		t.Fatalf("push %+v: %v", event, err)
	}
}

// TestExactBoundaries checks the closed interval: both endpoints match and the
// neighboring values do not, along with key discrimination.
func TestExactBoundaries(t *testing.T) {
	var got []Group
	j, err := New(10, 20, func(g Group) error { got = append(got, g); return nil })
	if err != nil {
		t.Fatal(err)
	}
	left := Event{ID: "L0", Key: "k", Time: 100}
	mustPush(t, j, Left, left)
	rights := []Event{
		{ID: "r-lo", Key: "k", Time: 90},  // exactly leftTime-A
		{ID: "r-hi", Key: "k", Time: 120}, // exactly leftTime+B
		{ID: "r-below", Key: "k", Time: 89},
		{ID: "r-above", Key: "k", Time: 121},
		{ID: "r-otherkey", Key: "x", Time: 100},
	}
	for _, right := range rights {
		mustPush(t, j, Right, right)
	}
	if err := j.Watermark(Right, 120); err != nil { // equal to upper bound: not sealed
		t.Fatal(err)
	}
	if err := j.Watermark(Left, 100); err != nil { // equal to left time: not sealed
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("delivered before sealing: %v", got)
	}
	if err := j.Watermark(Left, 101); err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("right watermark must be strictly greater than leftTime+B: %v", got)
	}
	if err := j.Watermark(Right, 121); err != nil {
		t.Fatal(err)
	}
	want := oracleJoin(t, []Event{left}, rights, 10, 20)
	assertGroups(t, got, want)
	if len(got[0].Matches) != 2 || got[0].Matches[0].ID != "r-lo" || got[0].Matches[1].ID != "r-hi" {
		t.Fatalf("matches should be time-sorted endpoints: %v", got[0].Matches)
	}
}

// TestWatermarkEquality focuses on the strict inequalities in the seal rule.
func TestWatermarkEquality(t *testing.T) {
	var got []Group
	j, _ := New(0, 5, func(g Group) error { got = append(got, g); return nil })
	left := Event{ID: "L", Key: "k", Time: 10}
	mustPush(t, j, Left, left)
	mustPush(t, j, Right, Event{ID: "r", Key: "k", Time: 15})

	if err := j.Watermark(Left, 10); err != nil {
		t.Fatal(err)
	}
	if err := j.Push(Left, Event{ID: "at-wm", Key: "k", Time: 10}); err != nil {
		t.Fatalf("event at watermark should be accepted: %v", err)
	}
	if err := j.Push(Left, Event{ID: "before-wm", Key: "k", Time: 9}); !errors.Is(err, ErrWatermarkViolation) {
		t.Fatalf("event before watermark: got %v, want %v", err, ErrWatermarkViolation)
	}
	if err := j.Watermark(Right, 15); err != nil { // leftTime+B == 15, strict > required
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("equal watermarks must not seal: %v", got)
	}
	if err := j.Watermark(Right, 16); err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("left watermark equality must not seal: %v", got)
	}
	if err := j.Watermark(Left, 11); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("both left events should deliver, got %d", len(got))
	}
}

// TestOutOfOrder verifies arrival order does not affect sorted delivery or
// matching, including right events arriving after their left events.
func TestOutOfOrder(t *testing.T) {
	var got []Group
	j, _ := New(5, 5, func(g Group) error { got = append(got, g); return nil })
	lefts := []Event{
		{ID: "L3", Key: "k", Time: 30},
		{ID: "L1", Key: "k", Time: 10},
		{ID: "L2", Key: "k", Time: 20},
	}
	for _, left := range lefts {
		mustPush(t, j, Left, left)
	}
	rights := []Event{
		{ID: "r2", Key: "k", Time: 22},
		{ID: "r1", Key: "k", Time: 8},
		{ID: "r3", Key: "k", Time: 35},
	}
	for _, right := range rights {
		mustPush(t, j, Right, right)
	}
	if err := j.Watermark(Left, 100); err != nil {
		t.Fatal(err)
	}
	if err := j.Watermark(Right, 100); err != nil {
		t.Fatal(err)
	}
	want := oracleJoin(t, lefts, rights, 5, 5)
	assertGroups(t, got, want)
	for i := 1; i < len(got); i++ {
		prev, cur := got[i-1].Left, got[i].Left
		if prev.Time > cur.Time || (prev.Time == cur.Time && prev.ID > cur.ID) {
			t.Fatalf("groups out of order: %v before %v", prev, cur)
		}
	}
}

// TestUnmatched delivers a group with an empty (non-nil) match slice.
func TestUnmatched(t *testing.T) {
	var got []Group
	j, _ := New(1, 1, func(g Group) error { got = append(got, g); return nil })
	mustPush(t, j, Left, Event{ID: "L", Key: "k", Time: 10})
	mustPush(t, j, Right, Event{ID: "r", Key: "other", Time: 10})
	if err := j.End(Left); err != nil {
		t.Fatal(err)
	}
	if err := j.End(Right); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("want one unmatched group, got %d", len(got))
	}
	if got[0].Matches == nil || len(got[0].Matches) != 0 {
		t.Fatalf("unmatched group needs empty non-nil slice: %v", got[0].Matches)
	}
}

// TestInt64Endpoints exercises overflow at both integer extremes, using End as
// the positive-infinity watermark.
func TestInt64Endpoints(t *testing.T) {
	cases := []struct {
		name         string
		a, b         int64
		left         Event
		rights       []Event
		wantMatchIDs []string
	}{
		{
			name:         "max left, max lookahead overflows",
			a:            0,
			b:            math.MaxInt64,
			left:         Event{ID: "L", Key: "k", Time: math.MaxInt64},
			rights:       []Event{{ID: "only-max", Key: "k", Time: math.MaxInt64}, {ID: "low", Key: "k", Time: math.MaxInt64 - 1}},
			wantMatchIDs: []string{"only-max"},
		},
		{
			name:         "max left with max lookback",
			a:            math.MaxInt64,
			b:            0,
			left:         Event{ID: "L", Key: "k", Time: math.MaxInt64},
			rights:       []Event{{ID: "zero", Key: "k", Time: 0}, {ID: "max", Key: "k", Time: math.MaxInt64}, {ID: "neg", Key: "k", Time: -1}},
			wantMatchIDs: []string{"zero", "max"},
		},
		{
			name:   "min left with max lookback underflows the lower bound",
			a:      math.MaxInt64,
			b:      0,
			left:   Event{ID: "L", Key: "k", Time: math.MinInt64},
			rights: []Event{{ID: "min", Key: "k", Time: math.MinInt64}, {ID: "zero", Key: "k", Time: 0}},
			// Mathematical lower bound is MinInt64-MaxInt64 = -2^64+1,
			// outside int64 range, so zero is below the window by one unit.
			wantMatchIDs: []string{"min"},
		},
		{
			name:         "min left zero window",
			a:            0,
			b:            0,
			left:         Event{ID: "L", Key: "k", Time: math.MinInt64},
			rights:       []Event{{ID: "min", Key: "k", Time: math.MinInt64}, {ID: "up", Key: "k", Time: math.MinInt64 + 1}},
			wantMatchIDs: []string{"min"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got []Group
			j, _ := New(tc.a, tc.b, func(g Group) error { got = append(got, g); return nil })
			mustPush(t, j, Left, tc.left)
			for _, right := range tc.rights {
				mustPush(t, j, Right, right)
			}
			// Finite watermarks can never cross an out-of-range mathematical bound.
			if err := j.Watermark(Left, math.MaxInt64); err != nil {
				t.Fatal(err)
			}
			if err := j.Watermark(Right, math.MaxInt64); err != nil {
				t.Fatal(err)
			}
			leftFiniteSealed := tc.left.Time < math.MaxInt64
			rightFiniteSealed := greaterThanSum(math.MaxInt64, tc.left.Time, tc.b)
			if leftFiniteSealed && rightFiniteSealed {
				if len(got) != 1 {
					t.Fatalf("finite watermarks should seal this case: %v", got)
				}
			} else {
				if len(got) != 0 {
					t.Fatalf("overflowing bound must wait for End: %v", got)
				}
			}
			if err := j.End(Left); err != nil {
				t.Fatal(err)
			}
			if !rightFiniteSealed && len(got) != 0 {
				t.Fatalf("right side still open, cannot seal: %v", got)
			}
			if err := j.End(Right); err != nil {
				t.Fatal(err)
			}
			want := oracleJoin(t, []Event{tc.left}, tc.rights, tc.a, tc.b)
			assertGroups(t, got, want)
			var ids []string
			for _, match := range got[0].Matches {
				ids = append(ids, match.ID)
			}
			if !slices.Equal(ids, tc.wantMatchIDs) {
				t.Fatalf("match IDs: got %v, want %v", ids, tc.wantMatchIDs)
			}
		})
	}
}

// TestRejections covers stream end, watermark monotonicity, inconsistent IDs
// and identical redelivery, asserting state is preserved on rejection.
func TestRejections(t *testing.T) {
	delivered := 0
	j, _ := New(1, 1, func(Group) error { delivered++; return nil })
	left := Event{ID: "L", Key: "k", Time: 10}
	mustPush(t, j, Left, left)
	mustPush(t, j, Right, Event{ID: "R", Key: "k", Time: 10})

	if err := j.Watermark(Left, 5); err != nil {
		t.Fatal(err)
	}
	if err := j.Watermark(Left, 5); err != nil {
		t.Fatalf("re-asserting the same watermark must be allowed: %v", err)
	}
	if err := j.Watermark(Left, 4); !errors.Is(err, ErrWatermarkRegression) {
		t.Fatalf("regression: got %v, want %v", err, ErrWatermarkRegression)
	}
	if err := j.Push(Left, Event{ID: "L", Key: "k", Time: 11}); !errors.Is(err, ErrInconsistentEvent) {
		t.Fatalf("same ID different time: got %v, want %v", err, ErrInconsistentEvent)
	}
	if err := j.Push(Left, Event{ID: "L", Key: "other", Time: 10}); !errors.Is(err, ErrInconsistentEvent) {
		t.Fatalf("same ID different key: got %v, want %v", err, ErrInconsistentEvent)
	}
	// Identical redelivery is ignored and returns success.
	if err := j.Push(Left, left); err != nil {
		t.Fatalf("identical redelivery should be ignored: %v", err)
	}

	if err := j.End(Left); err != nil {
		t.Fatal(err)
	}
	if err := j.Push(Left, Event{ID: "after-end", Key: "k", Time: 100}); !errors.Is(err, ErrStreamEnded) {
		t.Fatalf("push after end: got %v, want %v", err, ErrStreamEnded)
	}
	if err := j.Watermark(Left, 100); !errors.Is(err, ErrStreamEnded) {
		t.Fatalf("watermark after end: got %v, want %v", err, ErrStreamEnded)
	}
	// Repeated End is idempotent and still pumps when the right side ends.
	if err := j.End(Left); err != nil {
		t.Fatalf("repeated end should be idempotent: %v", err)
	}
	if err := j.End(Right); err != nil {
		t.Fatal(err)
	}
	if delivered != 1 {
		t.Fatalf("rejected inputs must not add events; delivered %d groups", delivered)
	}
	if j.End(Side(99)) != ErrInvalidSide {
		t.Fatalf("invalid side should be rejected")
	}
}

// TestCallbackRetry keeps the whole group on failure and retries the same group.
func TestCallbackRetry(t *testing.T) {
	var delivered []Group
	failures := 1
	j, _ := New(1, 1, func(g Group) error {
		if failures > 0 {
			failures--
			return errors.New("callback unavailable")
		}
		delivered = append(delivered, g)
		return nil
	})
	mustPush(t, j, Left, Event{ID: "L", Key: "k", Time: 10})
	mustPush(t, j, Right, Event{ID: "R", Key: "k", Time: 10})
	if err := j.Watermark(Left, 11); err != nil {
		t.Fatal(err)
	}
	err := j.Watermark(Right, 12) // seals the group; first delivery fails
	if err == nil {
		t.Fatal("failing callback must surface an error")
	}
	if err := j.Watermark(Right, 12); err != nil { // equal watermark triggers a retry
		t.Fatalf("retry failed: %v", err)
	}
	if len(delivered) != 1 {
		t.Fatalf("group must deliver exactly once after retries, got %d", len(delivered))
	}

	// A blocked head group prevents delivery of later groups; once recovered,
	// both groups are delivered in order on the next trigger.
	var ordered []string
	block := true
	j2, _ := New(0, 0, func(g Group) error {
		if block {
			return errors.New("blocked")
		}
		ordered = append(ordered, g.Left.ID)
		return nil
	})
	mustPush(t, j2, Left, Event{ID: "first", Key: "k", Time: 0})
	mustPush(t, j2, Left, Event{ID: "second", Key: "k", Time: 1})
	if err := j2.Watermark(Left, 2); err != nil {
		t.Fatal(err)
	}
	if err := j2.End(Right); err == nil {
		t.Fatal("expected callback failure")
	}
	if err := j2.End(Right); err == nil {
		t.Fatal("head should stay blocked")
	}
	if len(ordered) != 0 {
		t.Fatalf("nothing should be delivered while head fails: %v", ordered)
	}
	block = false
	if err := j2.Watermark(Left, 2); err != nil { // equal watermark triggers pump
		t.Fatal(err)
	}
	if !slices.Equal(ordered, []string{"first", "second"}) {
		t.Fatalf("retry ordering: got %v", ordered)
	}
}

func TestNewValidation(t *testing.T) {
	if _, err := New(-1, 0, func(Group) error { return nil }); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("negative A: got %v", err)
	}
	if _, err := New(0, -1, func(Group) error { return nil }); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("negative B: got %v", err)
	}
	if _, err := New(0, 0, nil); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("nil callback: got %v", err)
	}
}

// TestUTF8ByteOrdering ensures IDs order by raw UTF-8 bytes, not rune-aware
// collation. Byte-wise, "é" (0xC3...) sorts after all ASCII letters.
func TestUTF8ByteOrdering(t *testing.T) {
	var got []Group
	j, _ := New(0, 0, func(g Group) error { got = append(got, g); return nil })
	events := []Event{
		{ID: "é", Key: "k", Time: 0},
		{ID: "a", Key: "k", Time: 0},
		{ID: "A", Key: "k", Time: 0},
	}
	for _, event := range events {
		mustPush(t, j, Left, event)
	}
	if err := j.End(Left); err != nil {
		t.Fatal(err)
	}
	if err := j.End(Right); err != nil {
		t.Fatal(err)
	}
	wantIDs := []string{"A", "a", "é"}
	for i, want := range wantIDs {
		if got[i].Left.ID != want {
			t.Fatalf("position %d: got %q, want %q; full=%v", i, got[i].Left.ID, want, got)
		}
	}
}

// TestRandomAgainstOracle drives randomized valid interleavings, including
// int64 endpoint timestamps and out-of-order arrival, then compares the full
// output against the arbitrary-precision brute-force oracle.
func TestRandomAgainstOracle(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	timePool := []int64{
		math.MinInt64,
		math.MinInt64 + 1,
		-100, -1, 0, 1, 2, 50, 99, 100, 101,
		math.MaxInt64 - 1,
		math.MaxInt64,
	}
	windows := []int64{0, 1, 2, 100, math.MaxInt64}

	for iter := 0; iter < 300; iter++ {
		a := windows[rng.Intn(len(windows))]
		b := windows[rng.Intn(len(windows))]
		var got []Group
		j, err := New(a, b, func(g Group) error { got = append(got, g); return nil })
		if err != nil {
			t.Fatal(err)
		}

		type planned struct {
			event Event
			sent  bool
		}
		plan := map[Side][]*planned{}
		accepted := map[Side][]Event{}
		nextID := map[Side]int{Left: 0, Right: 0}
		for _, side := range []Side{Left, Right} {
			n := 1 + rng.Intn(8)
			for k := 0; k < n; k++ {
				event := Event{
					ID:   fmtID(side, nextID[side]),
					Key:  fmt.Sprintf("key-%d", rng.Intn(4)),
					Time: timePool[rng.Intn(len(timePool))],
				}
				nextID[side]++
				plan[side] = append(plan[side], &planned{event: event})
			}
		}

		remainingMin := func(side Side) (int64, bool) {
			var min int64
			found := false
			for _, item := range plan[side] {
				if !item.sent && (!found || item.event.Time < min) {
					min, found = item.event.Time, true
				}
			}
			return min, found
		}

		ended := map[Side]bool{}
		wm := map[Side]int64{}
		wmSet := map[Side]bool{}
		for steps := 0; steps < 120 && (!ended[Left] || !ended[Right]); steps++ {
			side := []Side{Left, Right}[rng.Intn(2)]
			if ended[side] {
				continue
			}
			minTime, hasRemaining := remainingMin(side)
			switch rng.Intn(3) {
			case 0: // push a random remaining event (arbitrary arrival order)
				if !hasRemaining {
					continue
				}
				pending := make([]*planned, 0)
				for _, item := range plan[side] {
					if !item.sent {
						pending = append(pending, item)
					}
				}
				item := pending[rng.Intn(len(pending))]
				if err := j.Push(side, item.event); err != nil {
					t.Fatalf("iteration %d: valid push rejected: %v", iter, err)
				}
				item.sent = true
				accepted[side] = append(accepted[side], item.event)
				// Occasionally redeliver the identical event (must be ignored).
				if rng.Intn(4) == 0 {
					if err := j.Push(side, item.event); err != nil {
						t.Fatalf("identical redelivery: %v", err)
					}
				}
				// Occasionally reuse the ID with different content (must be rejected).
				if rng.Intn(4) == 0 {
					conflict := item.event
					conflict.Time++
					if err := j.Push(side, conflict); !errors.Is(err, ErrInconsistentEvent) {
						t.Fatalf("iteration %d: conflicting ID: got %v, want %v", iter, err, ErrInconsistentEvent)
					}
				}
			case 1: // advance watermark without passing any unsent event time
				if !hasRemaining {
					continue
				}
				next := minTime
				if rng.Intn(2) == 0 && minTime > math.MinInt64 {
					next = minTime - 1
				}
				if wmSet[side] && next < wm[side] {
					next = wm[side]
				}
				if err := j.Watermark(side, next); err != nil {
					t.Fatalf("iteration %d: valid watermark rejected: %v", iter, err)
				}
				wm[side], wmSet[side] = next, true
			case 2: // end the stream
				if err := j.End(side); err != nil {
					t.Fatal(err)
				}
				ended[side] = true
			}
		}
		for _, side := range []Side{Left, Right} {
			if !ended[side] {
				if err := j.End(side); err != nil {
					t.Fatal(err)
				}
			}
		}

		want := oracleJoin(t, accepted[Left], accepted[Right], a, b)
		assertGroups(t, got, want)
		for i := 1; i < len(got); i++ {
			prev, cur := got[i-1].Left, got[i].Left
			if prev.Time > cur.Time || (prev.Time == cur.Time && prev.ID > cur.ID) {
				t.Fatalf("iteration %d: groups out of order %v before %v", iter, prev, cur)
			}
		}
	}
}

func fmtID(side Side, n int) string {
	if side == Left {
		return fmt.Sprintf("L-%03d", n)
	}
	return fmt.Sprintf("R-%03d", n)
}
