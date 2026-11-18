package formal

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// This file is a small deterministic model checker. It enumerates every
// reachable interleaving of confirmations, delete events, retries,
// cancellations, reconciles, and re-registrations. Every state is treated as a
// fault point: the durable event log is replayed there and must reproduce the
// state exactly. Invariants are checked on every transition, including the
// effects handed to the controller.

type modelProgress struct {
	readdedK1 bool
	readdedK2 bool
	failures  map[ResourceID]int
	cancels   map[ResourceID]int
}

func newModelProgress() modelProgress {
	return modelProgress{
		failures: make(map[ResourceID]int),
		cancels:  make(map[ResourceID]int),
	}
}

func (p modelProgress) clone() modelProgress {
	out := modelProgress{
		readdedK1: p.readdedK1,
		readdedK2: p.readdedK2,
		failures:  make(map[ResourceID]int, len(p.failures)),
		cancels:   make(map[ResourceID]int, len(p.cancels)),
	}
	for id, count := range p.failures {
		out.failures[id] = count
	}
	for id, count := range p.cancels {
		out.cancels[id] = count
	}
	return out
}

type modelChoice struct {
	name     string
	event    Event
	progress modelProgress
}

type modelExplorer struct {
	t         *testing.T
	maxDepth  int
	maxStates int
	visited   map[string]struct{}
	states    int
	terminals int
}

func TestFaultPointEnumerationAndReplay(t *testing.T) {
	l := NewLedger()
	if err := l.Register(testObject,
		KeySpec{Key: "k1", Resources: []ResourceID{"r1", "r2"}},
		KeySpec{Key: "k2", Resources: []ResourceID{"r3"}},
	); err != nil {
		t.Fatal(err)
	}
	if err := l.BeginCleanup(testObject); err != nil {
		t.Fatal(err)
	}

	ex := &modelExplorer{
		t:         t,
		maxDepth:  64,
		maxStates: 250000,
		visited:   make(map[string]struct{}),
	}
	ex.walk(l, newModelProgress())
	t.Logf("fault-point states=%d terminal-paths=%d", ex.states, ex.terminals)
	if ex.terminals == 0 {
		t.Fatal("exploration found no complete execution")
	}
}

func (e *modelExplorer) walk(l *Ledger, progress modelProgress) {
	e.states++
	if e.states > e.maxStates {
		e.t.Fatalf("state explosion: more than %d states", e.maxStates)
	}

	snap := mustSnapshot(e.t, l)
	checkModelInvariants(e.t, snap, l.EventLog())
	checkReplay(e.t, l, snap)

	key := modelStateKey(snap, progress)
	if _, ok := e.visited[key]; ok {
		return
	}
	e.visited[key] = struct{}{}

	if modelTerminal(snap, progress) {
		e.terminals++
		return
	}
	if len(l.EventLog()) >= e.maxDepth {
		return
	}

	for _, choice := range modelCandidates(e.t, l, snap, progress) {
		next := l.Clone()
		effects, err := next.Apply(choice.event)
		if err != nil {
			e.t.Fatalf("candidate %q after %v: %v", choice.name, l.EventLog(), err)
		}
		post := mustSnapshot(e.t, next)
		checkEffects(e.t, snap, post, effects, choice.name)
		e.walk(next, choice.progress)
	}
}

func modelCandidates(t *testing.T, l *Ledger, snap Snapshot, progress modelProgress) []modelChoice {
	t.Helper()
	var out []modelChoice

	add := func(name string, ev Event, next modelProgress) {
		out = append(out, modelChoice{name: name, event: ev, progress: next})
	}

	// Reconcile is a scheduling decision and is logged like any other event.
	preview := l.Clone()
	if effects, err := preview.Reconcile(testObject); err != nil {
		t.Fatalf("preview reconcile: %v", err)
	} else if len(effects) > 0 {
		add("reconcile", Event{Kind: EventReconcile, Object: testObject}, progress)
	}

	if !snap.Deleting {
		add("delete", Event{Kind: EventDelete, Object: testObject}, progress)
	}
	if !snap.Cleaning {
		add("begin-cleanup", Event{Kind: EventBeginCleanup, Object: testObject}, progress)
	}

	for _, res := range snap.Resources {
		id := res.Resource
		switch res.State {
		case ResourceInFlight:
			add("success-"+string(id), Event{
				Kind: EventConfirm, Object: testObject, Resource: id,
				Attempt: res.Attempt, Result: ResultSucceeded,
			}, progress)

			if progress.failures[id] < 1 {
				next := progress.clone()
				next.failures[id]++
				add("failure-"+string(id), Event{
					Kind: EventConfirm, Object: testObject, Resource: id,
					Attempt: res.Attempt, Result: ResultFailed,
				}, next)
			}
			if progress.cancels[id] < 1 {
				next := progress.clone()
				next.cancels[id]++
				add("cancel-"+string(id), Event{
					Kind: EventCancel, Object: testObject, Resource: id,
				}, next)

				next = progress.clone()
				next.cancels[id]++
				add("cancelled-result-"+string(id), Event{
					Kind: EventConfirm, Object: testObject, Resource: id,
					Attempt: res.Attempt, Result: ResultCancelled,
				}, next)
			}

		case ResourceFailed:
			// A late success is still authoritative, and a retry requeues the
			// resource for a new attempt.
			add("late-success-"+string(id), Event{
				Kind: EventConfirm, Object: testObject, Resource: id,
				Attempt: res.Attempt, Result: ResultSucceeded,
			}, progress)
			add("retry-"+string(id), Event{
				Kind: EventRetry, Object: testObject, Resource: id,
			}, progress)
			if progress.cancels[id] < 1 {
				next := progress.clone()
				next.cancels[id]++
				add("cancel-failed-"+string(id), Event{
					Kind: EventCancel, Object: testObject, Resource: id,
				}, next)
			}

		case ResourcePending:
			// A pending resource may still be confirmed by an operation that was
			// already in flight before this ledger recovered.
			attempt := res.Attempt
			if attempt == 0 {
				attempt = 1
			}
			add("early-success-"+string(id), Event{
				Kind: EventConfirm, Object: testObject, Resource: id,
				Attempt: attempt, Result: ResultSucceeded,
			}, progress)
		}
	}

	// Re-add completed keys during cleanup. k1 gains a new resource, while k2
	// is re-added with only completed resources.
	if k1 := keySnapshotMaybe(snap, "k1"); k1 != nil && k1.Removed && !progress.readdedK1 {
		next := progress.clone()
		next.readdedK1 = true
		add("readd-k1", Event{
			Kind: EventRegister, Object: testObject,
			Keys: []KeySpec{{Key: "k1", Resources: []ResourceID{"r1", "r2", "r4"}}},
		}, next)
	}
	if k2 := keySnapshotMaybe(snap, "k2"); k2 != nil && k2.Removed && !progress.readdedK2 {
		next := progress.clone()
		next.readdedK2 = true
		add("readd-k2", Event{
			Kind: EventRegister, Object: testObject,
			Keys: []KeySpec{{Key: "k2", Resources: []ResourceID{"r3"}}},
		}, next)
	}
	return out
}

func keySnapshotMaybe(snap Snapshot, id KeyID) *KeySnapshot {
	for i := range snap.Keys {
		if snap.Keys[i].Key == id {
			return &snap.Keys[i]
		}
	}
	return nil
}

func modelTerminal(snap Snapshot, progress modelProgress) bool {
	if !snap.Deleting || !snap.Finished || !progress.readdedK1 || !progress.readdedK2 {
		return false
	}
	for _, key := range snap.Keys {
		if !key.Removed {
			return false
		}
	}
	for _, res := range snap.Resources {
		if res.State != ResourceSucceeded || snap.SuccessRecords[res.Resource] != 1 {
			return false
		}
	}
	return true
}

func checkModelInvariants(t *testing.T, snap Snapshot, events []Event) {
	t.Helper()
	resourceStateByID := make(map[ResourceID]ResourceState, len(snap.Resources))
	for _, res := range snap.Resources {
		resourceStateByID[res.Resource] = res.State
		if got := snap.SuccessRecords[res.Resource]; got > 1 {
			t.Fatalf("resource %s has %d success records after %v", res.Resource, got, events)
		}
	}

	for _, key := range snap.Keys {
		if !key.Removed {
			continue
		}
		for _, id := range key.Resources {
			if resourceStateByID[id] != ResourceSucceeded {
				t.Fatalf("removed key %s has unconfirmed resource %s after %v", key.Key, id, events)
			}
			if got := snap.SuccessRecords[id]; got != 1 {
				t.Fatalf("removed key %s resource %s has %d success records after %v", key.Key, id, got, events)
			}
		}
	}

	// Key order is strict: a later key can only have been retired after every
	// earlier key has retired at least once.
	for i := 1; i < len(snap.Keys); i++ {
		if snap.Keys[i].Removals > 0 {
			for j := 0; j < i; j++ {
				if snap.Keys[j].Removals == 0 {
					t.Fatalf("key %s retired before earlier key %s after %v", snap.Keys[i].Key, snap.Keys[j].Key, events)
				}
			}
		}
	}

	if snap.Finished {
		if !snap.Deleting {
			t.Fatalf("finished without delete event after %v", events)
		}
		for _, key := range snap.Keys {
			if !key.Removed {
				t.Fatalf("finished with key %s present after %v", key.Key, events)
			}
		}
		for _, res := range snap.Resources {
			if res.State != ResourceSucceeded {
				t.Fatalf("finished with orphan resource %s (%s) after %v", res.Resource, res.State, events)
			}
			if snap.SuccessRecords[res.Resource] != 1 {
				t.Fatalf("finished with %d success records for %s after %v", snap.SuccessRecords[res.Resource], res.Resource, events)
			}
		}
	}
}

func checkEffects(t *testing.T, pre, post Snapshot, effects []Effect, choice string) {
	t.Helper()
	preResources := make(map[ResourceID]ResourceSnapshot, len(pre.Resources))
	for _, res := range pre.Resources {
		preResources[res.Resource] = res
	}
	postResources := make(map[ResourceID]ResourceSnapshot, len(post.Resources))
	for _, res := range post.Resources {
		postResources[res.Resource] = res
	}
	preKeys := make(map[KeyID]KeySnapshot, len(pre.Keys))
	for _, key := range pre.Keys {
		preKeys[key.Key] = key
	}
	postKeys := make(map[KeyID]KeySnapshot, len(post.Keys))
	for _, key := range post.Keys {
		postKeys[key.Key] = key
	}

	for _, effect := range effects {
		switch effect.Kind {
		case EffectStartCleanup:
			before, ok := preResources[effect.Resource]
			if !ok {
				t.Fatalf("%s started unknown resource %s", choice, effect.Resource)
			}
			if before.State == ResourceSucceeded {
				t.Fatalf("%s restarted completed resource %s", choice, effect.Resource)
			}
			after := postResources[effect.Resource]
			if after.State != ResourceInFlight || after.Attempt != before.Attempt+1 || after.Attempt != effect.Attempt {
				t.Fatalf("%s bad start %+v: before %+v after %+v", choice, effect, before, after)
			}
		case EffectRemoveKey:
			before, ok := preKeys[effect.Key]
			if !ok {
				t.Fatalf("%s removed unknown key %s", choice, effect.Key)
			}
			if before.Removed {
				t.Fatalf("%s removed key %s twice", choice, effect.Key)
			}
			for _, id := range before.Resources {
				if preResources[id].State != ResourceSucceeded || pre.SuccessRecords[id] != 1 {
					t.Fatalf("%s removed key %s with unconfirmed resource %s", choice, effect.Key, id)
				}
			}
			after := postKeys[effect.Key]
			if !after.Removed || after.Removals != before.Removals+1 {
				t.Fatalf("%s bad key removal for %s", choice, effect.Key)
			}
		case EffectFinishObject:
			if !post.Finished {
				t.Fatalf("%s finish effect left object unfinished", choice)
			}
			for _, key := range post.Keys {
				if !key.Removed {
					t.Fatalf("%s finished with key %s present", choice, key.Key)
				}
			}
			for _, res := range post.Resources {
				if res.State != ResourceSucceeded || post.SuccessRecords[res.Resource] != 1 {
					t.Fatalf("%s finished with bad resource %+v", choice, res)
				}
			}
		}
	}
}

func checkReplay(t *testing.T, l *Ledger, want Snapshot) {
	t.Helper()
	events := l.EventLog()
	replayed, err := Replay(events)
	if err != nil {
		t.Fatalf("replay %d events: %v", len(events), err)
	}
	got, ok := replayed.Snapshot(testObject)
	if !ok {
		t.Fatalf("replay lost object after %v", events)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("replay state mismatch after %v:\nwant %+v\n got %+v", events, want, got)
	}
}

func modelStateKey(snap Snapshot, progress modelProgress) string {
	var b strings.Builder
	fmt.Fprintf(&b, "c=%t d=%t f=%t;", snap.Cleaning, snap.Deleting, snap.Finished)
	for _, key := range snap.Keys {
		fmt.Fprintf(&b, "k=%s:%t:%d:", key.Key, key.Removed, key.Removals)
		for _, id := range key.Resources {
			fmt.Fprintf(&b, "%s,", id)
		}
		b.WriteString(";")
	}
	for _, res := range snap.Resources {
		fmt.Fprintf(&b, "r=%s:%d:%d:%d;", res.Resource, res.State, res.Attempt, snap.SuccessRecords[res.Resource])
	}
	for _, res := range snap.Resources {
		fmt.Fprintf(&b, "f=%s:%d;c=%s:%d;",
			res.Resource, progress.failures[res.Resource],
			res.Resource, progress.cancels[res.Resource])
	}
	fmt.Fprintf(&b, "readd=%t,%t", progress.readdedK1, progress.readdedK2)
	return b.String()
}
