package formal

import (
	"bytes"
	"fmt"
	"reflect"
	"sort"
	"testing"
	"time"
)

func crashOptions(clk *testClock) []Option {
	return []Option{
		WithClock(clk.Now),
		WithDefaultTimeout(time.Minute),
		WithRecheckInterval(10 * time.Second),
		WithMaxChecks(3),
	}
}

func seededStore(data []byte) *MemoryStore {
	s := NewMemoryStore()
	_ = s.Append(data)
	return s
}

func mustPrepare(t *testing.T, c *Coordinator, id, messageID string, timeout time.Duration) Receipt {
	t.Helper()
	r, err := c.Prepare(PrepareRequest{
		ID:      id,
		Message: testMessage(messageID),
		Timeout: timeout,
	})
	if err != nil {
		t.Fatalf("Prepare(%s, %s): %v", id, messageID, err)
	}
	return r
}

func mustCommit(t *testing.T, c *Coordinator, ref Ref) Decision {
	t.Helper()
	d, err := c.Commit(ref)
	if err != nil {
		t.Fatalf("Commit(%s): %v", ref, err)
	}
	return d
}

func mustRollback(t *testing.T, c *Coordinator, ref Ref, reason string) Decision {
	t.Helper()
	d, err := c.Rollback(ref, reason)
	if err != nil {
		t.Fatalf("Rollback(%s): %v", ref, err)
	}
	return d
}

func deliveryCounts(c *Coordinator) map[string]int {
	counts := make(map[string]int)
	for _, d := range c.Deliverable() {
		counts[d.Message.ID]++
	}
	return counts
}

func sortedRefs(m map[Ref]*attempt) []Ref {
	refs := make([]Ref, 0, len(m))
	for ref := range m {
		refs = append(refs, ref)
	}
	sort.Slice(refs, func(i, j int) bool { return refLess(refs[i], refs[j]) })
	return refs
}

// verifyVisibility enforces the central invariant on one replayed state:
// every reference is either absent from the deliverable set, or present exactly
// once. A delivered reference must also be committed, and a committed
// reference must be delivered.
func verifyVisibility(t *testing.T, c *Coordinator, plan map[string]State, label string) {
	t.Helper()

	seenRef := make(map[Ref]bool)
	seenMessage := make(map[string]bool)
	for _, d := range c.Deliverable() {
		if seenRef[d.Ref] {
			t.Errorf("%s: reference %s delivered more than once", label, d.Ref)
		}
		seenRef[d.Ref] = true
		if seenMessage[d.Message.ID] {
			t.Errorf("%s: message %s delivered more than once", label, d.Message.ID)
		}
		seenMessage[d.Message.ID] = true
		if want, ok := plan[d.Message.ID]; !ok || want != StateCommitted {
			t.Errorf("%s: unexpected delivery %+v", label, d)
		}
		a, ok := c.Get(d.Ref)
		if !ok || a.State != StateCommitted {
			t.Errorf("%s: delivered reference %s has state %s, ok=%v", label, d.Ref, a.State, ok)
		}
		if d.CommittedAt.IsZero() {
			t.Errorf("%s: delivered reference %s has no commit time", label, d.Ref)
		}
	}
	if len(c.order) != len(c.delivered) {
		t.Errorf("%s: order has %d entries for %d delivered refs", label, len(c.order), len(c.delivered))
	}
	for ref, a := range c.attempts {
		_, delivered := c.delivered[ref]
		switch a.state {
		case StateCommitted:
			if !delivered || !seenRef[ref] {
				t.Errorf("%s: committed %s is not in deliverable set", label, ref)
			}
		case StateRolledBack:
			if delivered {
				t.Errorf("%s: rolled-back %s is in deliverable set", label, ref)
			}
		case StatePrepared:
			if delivered {
				t.Errorf("%s: prepared %s is in deliverable set", label, ref)
			}
		default:
			t.Errorf("%s: attempt %s has invalid state %s", label, ref, a.state)
		}
	}
}

// resolvePrepared completes every attempt according to the scenario's plan and
// replays every already-final decision to exercise duplicate confirmations.
func resolvePrepared(t *testing.T, c *Coordinator, plan map[string]State, label string) {
	t.Helper()
	for _, ref := range sortedRefs(c.attempts) {
		a := c.attempts[ref]
		want, ok := plan[a.message.ID]
		if !ok {
			t.Errorf("%s: no plan for message %s", label, a.message.ID)
			continue
		}
		switch a.state {
		case StatePrepared:
			if want == StateCommitted {
				mustCommit(t, c, ref)
			} else {
				mustRollback(t, c, ref, "recovered from crash")
			}
		case StateCommitted:
			d := mustCommit(t, c, ref)
			if !d.Duplicate || d.State != StateCommitted {
				t.Errorf("%s: duplicate commit %s = %+v", label, ref, d)
			}
		case StateRolledBack:
			d := mustRollback(t, c, ref, "recovered from crash")
			if !d.Duplicate || d.State != StateRolledBack {
				t.Errorf("%s: duplicate rollback %s = %+v", label, ref, d)
			}
		}
		if a.state != want {
			t.Errorf("%s: %s resolved to %s, want %s", label, ref, a.state, want)
		}
	}
	if stats := c.Stats(); stats.Prepared != 0 {
		t.Errorf("%s: %d attempts remain prepared after recovery", label, stats.Prepared)
	}
}

func buildMainCrashScenario(t *testing.T) ([]byte, map[string]State) {
	t.Helper()
	clk := newTestClock()
	store := NewMemoryStore()
	c := openTest(t, store, crashOptions(clk)...)

	r1 := mustPrepare(t, c, "acct-A", "m-1", time.Minute)
	r2 := mustPrepare(t, c, "acct-B", "m-2", time.Minute)
	clk.Advance(2 * time.Minute)
	if due := c.Due(); len(due) != 2 {
		t.Fatalf("due = %d, want 2", len(due))
	}
	if _, err := c.MarkChecked(r1.Ref); err != nil {
		t.Fatalf("MarkChecked r1: %v", err)
	}
	if _, err := c.MarkChecked(r2.Ref); err != nil {
		t.Fatalf("MarkChecked r2: %v", err)
	}
	mustCommit(t, c, r1.Ref)
	mustRollback(t, c, r2.Ref, "local transaction failed")

	// Reuse acct-A after its first generation was finalized. The old
	// confirmation below must resolve the old generation only.
	r3 := mustPrepare(t, c, "acct-A", "m-3", time.Minute)
	if d := mustCommit(t, c, r1.Ref); !d.Duplicate || d.State != StateCommitted {
		t.Fatalf("late old confirmation = %+v", d)
	}
	mustCommit(t, c, r3.Ref)

	r4 := mustPrepare(t, c, "acct-C", "m-4", time.Minute)
	mustCommit(t, c, r4.Ref)

	// Leave one transaction prepared so every crash prefix has something to
	// recover as either invisible or, after rollback, permanently invisible.
	mustPrepare(t, c, "acct-D", "m-5", time.Minute)

	// These are duplicates and must not add records.
	mustCommit(t, c, r3.Ref)
	mustCommit(t, c, r4.Ref)

	data, err := store.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	plan := map[string]State{
		"m-1": StateCommitted,
		"m-2": StateRolledBack,
		"m-3": StateCommitted,
		"m-4": StateCommitted,
		"m-5": StateRolledBack,
	}
	return data, plan
}

func TestCrashPointEnumerationVisibilityInvariant(t *testing.T) {
	data, plan := buildMainCrashScenario(t)
	parsed, err := parseJournal(data)
	if err != nil {
		t.Fatalf("parse reference log: %v", err)
	}
	if len(parsed.bounds) == 0 {
		t.Fatal("reference log has no records")
	}

	clk := newTestClock()
	clk.Advance(10 * time.Minute)
	opts := crashOptions(clk)
	points := 0

	for frameIndex, bound := range parsed.bounds {
		frame := data[bound[0]:bound[1]]
		for prefix := 0; prefix <= len(frame); prefix++ {
			points++
			label := fmt.Sprintf("frame %d prefix %d/%d", frameIndex, prefix, len(frame))
			seed := data[:bound[0]+prefix]
			seedParsed, err := parseJournal(seed)
			if err != nil {
				t.Fatalf("%s: parse seed: %v", label, err)
			}
			store := seededStore(seed)
			c, err := Open(store, opts...)
			if err != nil {
				t.Errorf("%s: Open: %v", label, err)
				continue
			}
			if store.Len() != seedParsed.valid {
				t.Errorf("%s: torn tail not truncated: len=%d valid=%d", label, store.Len(), seedParsed.valid)
			}
			if got := c.Stats().TornTailBytes; got != seedParsed.tail {
				t.Errorf("%s: TornTailBytes=%d, want %d", label, got, seedParsed.tail)
			}
			verifyVisibility(t, c, plan, label)

			resolvePrepared(t, c, plan, label)
			verifyVisibility(t, c, plan, label+" resolved")
			recoveredBytes, err := store.Read()
			if err != nil {
				t.Fatalf("%s: read resolved log: %v", label, err)
			}

			// A second replay must produce the same decisions and delivery
			// set without adding state.
			recovered := openTest(t, seededStore(recoveredBytes), opts...)
			counts := deliveryCounts(recovered)
			for messageID, want := range plan {
				if want == StateCommitted {
					if counts[messageID] > 1 {
						t.Errorf("%s: %s delivered %d times after recovery", label, messageID, counts[messageID])
					}
				} else if counts[messageID] != 0 {
					t.Errorf("%s: rolled-back %s delivered %d times", label, messageID, counts[messageID])
				}
			}
			for _, a := range recovered.attempts {
				want := plan[a.message.ID]
				if want == StateCommitted && counts[a.message.ID] != 1 {
					t.Errorf("%s: committed %s delivered %d times, want 1", label, a.ref, counts[a.message.ID])
				}
				if a.state != want {
					t.Errorf("%s: replayed %s state %s, want %s", label, a.ref, a.state, want)
				}
			}
			verifyVisibility(t, recovered, plan, label+" second replay")

			before, _ := store.Read()
			resolvePrepared(t, recovered, plan, label+" duplicate replay")
			after, _ := store.Read()
			if !bytes.Equal(before, after) {
				t.Errorf("%s: duplicate confirmations appended records", label)
			}
			verifyVisibility(t, recovered, plan, label+" duplicate resolved")
		}
	}
	if points < len(parsed.bounds) {
		t.Fatalf("enumerated only %d crash points", points)
	}
	t.Logf("enumerated %d crash points across %d log frames", points, len(parsed.bounds))
}

func TestCrashDuringGenerationReuse(t *testing.T) {
	clk := newTestClock()
	store := NewMemoryStore()
	c := openTest(t, store, crashOptions(clk)...)
	g1 := mustPrepare(t, c, "reuse", "g-1", time.Minute)
	mustCommit(t, c, g1.Ref)
	g2 := mustPrepare(t, c, "reuse", "g-2", time.Minute)
	mustCommit(t, c, g2.Ref)
	data, err := store.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	parsed, err := parseJournal(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	plan := map[string]State{"g-1": StateCommitted, "g-2": StateCommitted}
	opts := crashOptions(clk)
	for frameIndex, bound := range parsed.bounds {
		frame := data[bound[0]:bound[1]]
		for prefix := 0; prefix <= len(frame); prefix++ {
			label := fmt.Sprintf("reuse frame %d prefix %d", frameIndex, prefix)
			recovered := openTest(t, seededStore(data[:bound[0]+prefix]), opts...)
			verifyVisibility(t, recovered, plan, label)
			resolvePrepared(t, recovered, plan, label)

			// Start a completely new generation under the same transaction
			// number after recovery, then tempt it with old confirmations.
			previousGeneration := recovered.Stats().NextGeneration
			freshID := fmt.Sprintf("g-fresh-%d-%d", frameIndex, prefix)
			fresh := mustPrepare(t, recovered, "reuse", freshID, time.Minute)
			if fresh.Ref.Gen <= previousGeneration {
				t.Fatalf("%s: fresh generation %s did not advance", label, fresh.Ref)
			}
			mustCommit(t, recovered, fresh.Ref)

			if a, ok := recovered.Get(g1.Ref); ok && a.Message.ID == "g-1" {
				if d := mustCommit(t, recovered, g1.Ref); d.State != StateCommitted {
					t.Errorf("%s: g1 decision changed to %s", label, d.State)
				}
			}
			if a, ok := recovered.Get(g2.Ref); ok && a.Message.ID == "g-2" {
				if d := mustCommit(t, recovered, g2.Ref); d.State != StateCommitted {
					t.Errorf("%s: g2 decision changed to %s", label, d.State)
				}
			}
			if a, _ := recovered.Get(fresh.Ref); a.State != StateCommitted {
				t.Errorf("%s: old confirmation changed fresh generation to %s", label, a.State)
			}
			counts := deliveryCounts(recovered)
			for _, id := range []string{"g-1", "g-2", freshID} {
				if counts[id] > 1 {
					t.Errorf("%s: %s delivered %d times", label, id, counts[id])
				}
			}
			if counts[freshID] != 1 {
				t.Errorf("%s: fresh message delivered %d times", label, counts[freshID])
			}
			verifyVisibility(t, recovered, map[string]State{
				"g-1":   StateCommitted,
				"g-2":   StateCommitted,
				freshID: StateCommitted,
			}, label+" fresh")
		}
	}
}

func TestReplayDeduplicatesCopiedRecords(t *testing.T) {
	clk := newTestClock()
	store := NewMemoryStore()
	c := openTest(t, store, crashOptions(clk)...)
	receipt := mustPrepare(t, c, "dedup", "m-dedup", time.Minute)
	mustCommit(t, c, receipt.Ref)

	data, _ := store.Read()
	parsed, err := parseJournal(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	prepareFrame := append([]byte(nil), data[parsed.bounds[0][0]:parsed.bounds[0][1]]...)
	commitFrame := append([]byte(nil), data[parsed.bounds[1][0]:parsed.bounds[1][1]]...)

	// Copy the commit frame twice and the prepare frame once, simulating an
	// ambiguous append that became durable and was retried by a client.
	_ = store.Append(commitFrame)
	_ = store.Append(prepareFrame)
	_ = store.Append(commitFrame)
	verifyVisibility(t, openTest(t, store, crashOptions(clk)...), map[string]State{
		"m-dedup": StateCommitted,
	}, "copied records")

	replayed := openTest(t, store, crashOptions(clk)...)
	requireDelivered(t, replayed, "m-dedup")
	if stats := replayed.Stats(); stats.Attempts != 1 || stats.Delivered != 1 {
		t.Fatalf("replay did not deduplicate: %+v", stats)
	}
	if a, _ := replayed.Get(receipt.Ref); a.State != StateCommitted {
		t.Fatalf("replay state = %+v", a)
	}

	// Replaying the same bytes again must be deterministic.
	bytesA, _ := store.Read()
	first := openTest(t, seededStore(bytesA), crashOptions(clk)...)
	second := openTest(t, seededStore(bytesA), crashOptions(clk)...)
	if !reflect.DeepEqual(first.Deliverable(), second.Deliverable()) {
		t.Fatalf("replay differs:\n%v\n%v", first.Deliverable(), second.Deliverable())
	}
	if first.Stats() != second.Stats() {
		t.Fatalf("replay stats differ: %+v vs %+v", first.Stats(), second.Stats())
	}
}
