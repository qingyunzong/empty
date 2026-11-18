package formal

import (
	"errors"
	"reflect"
	"sync"
	"testing"
)

const testObject ObjectID = "object-1"

func mustRegister(t *testing.T, l *Ledger, keys ...KeySpec) {
	t.Helper()
	if err := l.Register(testObject, keys...); err != nil {
		t.Fatalf("register: %v", err)
	}
}

func mustDelete(t *testing.T, l *Ledger) {
	t.Helper()
	if err := l.Delete(testObject); err != nil {
		t.Fatalf("delete: %v", err)
	}
}

func mustReconcile(t *testing.T, l *Ledger) []Effect {
	t.Helper()
	effects, err := l.Reconcile(testObject)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	return effects
}

func mustConfirm(t *testing.T, l *Ledger, resource ResourceID, attempt uint64, result Result) bool {
	t.Helper()
	applied, err := l.Confirm(testObject, resource, attempt, result)
	if err != nil {
		t.Fatalf("confirm %s: %v", resource, err)
	}
	return applied
}

func mustSnapshot(t *testing.T, l *Ledger) Snapshot {
	t.Helper()
	snap, ok := l.Snapshot(testObject)
	if !ok {
		t.Fatal("object missing from ledger")
	}
	return snap
}

func resourceSnapshot(t *testing.T, snap Snapshot, id ResourceID) ResourceSnapshot {
	t.Helper()
	for _, res := range snap.Resources {
		if res.Resource == id {
			return res
		}
	}
	t.Fatalf("resource %q missing from snapshot", id)
	return ResourceSnapshot{}
}

func keySnapshot(t *testing.T, snap Snapshot, id KeyID) KeySnapshot {
	t.Helper()
	for _, key := range snap.Keys {
		if key.Key == id {
			return key
		}
	}
	t.Fatalf("key %q missing from snapshot", id)
	return KeySnapshot{}
}

func startEffects(effects []Effect) map[ResourceID]uint64 {
	out := make(map[ResourceID]uint64)
	for _, effect := range effects {
		if effect.Kind == EffectStartCleanup {
			out[effect.Resource] = effect.Attempt
		}
	}
	return out
}

func TestTerminalKeyOrderAndRemoval(t *testing.T) {
	l := NewLedger()
	mustRegister(t, l,
		KeySpec{Key: "k1", Resources: []ResourceID{"r1", "r2"}},
		KeySpec{Key: "k2", Resources: []ResourceID{"r3"}},
		KeySpec{Key: "k3", Resources: []ResourceID{"r4"}},
	)
	if err := l.BeginCleanup(testObject); err != nil {
		t.Fatal(err)
	}
	mustDelete(t, l)

	effects := mustReconcile(t, l)
	starts := startEffects(effects)
	if len(starts) != 2 || starts["r1"] != 1 || starts["r2"] != 1 {
		t.Fatalf("first reconcile = %v, want only k1 resources", effects)
	}
	if _, ok := starts["r3"]; ok {
		t.Fatal("k2 started before k1 was removed")
	}

	mustConfirm(t, l, "r1", 1, ResultSucceeded)
	if effects := mustReconcile(t, l); len(effects) != 0 {
		t.Fatalf("reconcile with one pending resource = %v, want none", effects)
	}
	mustConfirm(t, l, "r2", 1, ResultSucceeded)

	effects = mustReconcile(t, l)
	if len(effects) != 2 ||
		effects[0].Kind != EffectRemoveKey || effects[0].Key != "k1" ||
		effects[1].Kind != EffectStartCleanup || effects[1].Resource != "r3" {
		t.Fatalf("after k1 complete = %v, want remove k1 then start r3", effects)
	}

	mustConfirm(t, l, "r3", 1, ResultSucceeded)
	effects = mustReconcile(t, l)
	if len(effects) != 2 ||
		effects[0].Kind != EffectRemoveKey || effects[0].Key != "k2" ||
		effects[1].Kind != EffectStartCleanup || effects[1].Resource != "r4" {
		t.Fatalf("after k2 complete = %v, want remove k2 then start r4", effects)
	}

	mustConfirm(t, l, "r4", 1, ResultSucceeded)
	effects = mustReconcile(t, l)
	if len(effects) != 2 ||
		effects[0].Kind != EffectRemoveKey || effects[0].Key != "k3" ||
		effects[1].Kind != EffectFinishObject {
		t.Fatalf("after k3 complete = %v, want remove k3 then finish", effects)
	}

	snap := mustSnapshot(t, l)
	if !snap.Finished {
		t.Fatal("object should be finished")
	}
	for _, key := range snap.Keys {
		if !key.Removed {
			t.Fatalf("key %s is still present", key.Key)
		}
	}
	for _, res := range snap.Resources {
		if res.State != ResourceSucceeded {
			t.Fatalf("resource %s = %s", res.Resource, res.State)
		}
		if got := snap.SuccessRecords[res.Resource]; got != 1 {
			t.Fatalf("success records for %s = %d, want 1", res.Resource, got)
		}
	}

	if mustConfirm(t, l, "r1", 1, ResultSucceeded) {
		t.Fatal("duplicate success was applied")
	}
	if got := mustSnapshot(t, l).SuccessRecords["r1"]; got != 1 {
		t.Fatalf("duplicate success count = %d, want 1", got)
	}
	if effects := mustReconcile(t, l); len(effects) != 0 {
		t.Fatalf("reconcile after finish = %v, want none", effects)
	}
}

func TestConfirmationVersusDeleteOrdering(t *testing.T) {
	t.Run("confirmation before delete", func(t *testing.T) {
		l := NewLedger()
		mustRegister(t, l, KeySpec{Key: "k", Resources: []ResourceID{"r"}})
		if err := l.BeginCleanup(testObject); err != nil {
			t.Fatal(err)
		}
		starts := startEffects(mustReconcile(t, l))
		if starts["r"] != 1 {
			t.Fatalf("start = %v", starts)
		}
		mustConfirm(t, l, "r", 1, ResultSucceeded)
		mustDelete(t, l)

		effects := mustReconcile(t, l)
		if len(effects) != 2 || effects[0].Kind != EffectRemoveKey || effects[1].Kind != EffectFinishObject {
			t.Fatalf("effects = %v", effects)
		}
	})

	t.Run("delete before in-flight confirmation", func(t *testing.T) {
		l := NewLedger()
		mustRegister(t, l, KeySpec{Key: "k", Resources: []ResourceID{"r"}})
		if err := l.BeginCleanup(testObject); err != nil {
			t.Fatal(err)
		}
		if starts := startEffects(mustReconcile(t, l)); starts["r"] != 1 {
			t.Fatalf("start = %v", starts)
		}
		mustDelete(t, l)

		if effects := mustReconcile(t, l); len(effects) != 0 {
			t.Fatalf("key removed before confirmation: %v", effects)
		}
		mustConfirm(t, l, "r", 1, ResultSucceeded)
		if effects := mustReconcile(t, l); len(effects) != 2 ||
			effects[0].Kind != EffectRemoveKey || effects[1].Kind != EffectFinishObject {
			t.Fatalf("effects after confirmation = %v", effects)
		}
	})

	t.Run("confirmation arrives before cleanup starts", func(t *testing.T) {
		l := NewLedger()
		mustRegister(t, l, KeySpec{Key: "k", Resources: []ResourceID{"r"}})
		// This models a confirmation from an operation that was already in
		// flight when the recovered ledger was rebuilt.
		if !mustConfirm(t, l, "r", 7, ResultSucceeded) {
			t.Fatal("early success was not recorded")
		}
		mustDelete(t, l)
		effects := mustReconcile(t, l)
		if len(effects) != 2 || effects[0].Kind != EffectRemoveKey || effects[1].Kind != EffectFinishObject {
			t.Fatalf("effects = %v, want no StartCleanup", effects)
		}
		if got := mustSnapshot(t, l).SuccessRecords["r"]; got != 1 {
			t.Fatalf("success count = %d", got)
		}
	})
}

func TestReaddedKeyDoesNotRerunCompletedResources(t *testing.T) {
	l := NewLedger()
	mustRegister(t, l,
		KeySpec{Key: "k1", Resources: []ResourceID{"r1", "r2"}},
		KeySpec{Key: "k2", Resources: []ResourceID{"r3"}},
	)
	mustDelete(t, l)

	starts := startEffects(mustReconcile(t, l))
	if len(starts) != 2 {
		t.Fatalf("initial starts = %v", starts)
	}
	mustConfirm(t, l, "r1", 1, ResultSucceeded)
	mustConfirm(t, l, "r2", 1, ResultSucceeded)
	effects := mustReconcile(t, l)
	if len(effects) != 2 || effects[0].Kind != EffectRemoveKey || effects[0].Key != "k1" {
		t.Fatalf("k1 removal = %v", effects)
	}

	// Re-add k1 with an additional resource while k2 is being cleaned up.
	mustRegister(t, l, KeySpec{Key: "k1", Resources: []ResourceID{"r1", "r2", "r4"}})
	effects = mustReconcile(t, l)
	starts = startEffects(effects)
	if len(starts) != 1 || starts["r4"] != 1 {
		t.Fatalf("re-added k1 starts = %v, want only r4", starts)
	}
	for _, id := range []ResourceID{"r1", "r2"} {
		if _, ok := starts[id]; ok {
			t.Fatalf("completed resource %s was restarted", id)
		}
	}

	mustConfirm(t, l, "r4", 1, ResultSucceeded)
	effects = mustReconcile(t, l)
	if len(effects) != 1 || effects[0].Kind != EffectRemoveKey || effects[0].Key != "k1" {
		t.Fatalf("second k1 removal = %v", effects)
	}
	if got := mustSnapshot(t, l).SuccessRecords["r1"]; got != 1 {
		t.Fatalf("r1 success count = %d, want 1", got)
	}

	// Complete k2, then re-add it with exactly the same spec. There must be no
	// new start and the key may be retired immediately.
	mustConfirm(t, l, "r3", 1, ResultSucceeded)
	effects = mustReconcile(t, l)
	if len(effects) != 2 || effects[0].Kind != EffectRemoveKey || effects[0].Key != "k2" || effects[1].Kind != EffectFinishObject {
		t.Fatalf("k2 removal = %v", effects)
	}
	mustRegister(t, l, KeySpec{Key: "k2", Resources: []ResourceID{"r3"}})
	effects = mustReconcile(t, l)
	if len(effects) != 2 || effects[0].Kind != EffectRemoveKey || effects[0].Key != "k2" || effects[1].Kind != EffectFinishObject {
		t.Fatalf("re-added k2 effects = %v, want immediate removal without start", effects)
	}
	// A brand-new key added after the object finished only starts its own new
	// resource; earlier completed keys stay retired.
	mustRegister(t, l, KeySpec{Key: "k3", Resources: []ResourceID{"r5"}})
	effects = mustReconcile(t, l)
	starts = startEffects(effects)
	if len(effects) != 1 || starts["r5"] != 1 {
		t.Fatalf("new key effects = %v, want only r5 start", effects)
	}
	mustConfirm(t, l, "r5", 1, ResultSucceeded)
	effects = mustReconcile(t, l)
	if len(effects) != 2 || effects[0].Kind != EffectRemoveKey || effects[0].Key != "k3" || effects[1].Kind != EffectFinishObject {
		t.Fatalf("new key removal = %v", effects)
	}
	for _, res := range mustSnapshot(t, l).Resources {
		if got := mustSnapshot(t, l).SuccessRecords[res.Resource]; got != 1 {
			t.Fatalf("%s success count = %d", res.Resource, got)
		}
	}
}

func TestRetryAndCancelInterleaving(t *testing.T) {
	l := NewLedger()
	mustRegister(t, l, KeySpec{Key: "k", Resources: []ResourceID{"r1", "r2"}})
	mustDelete(t, l)
	if starts := startEffects(mustReconcile(t, l)); starts["r1"] != 1 || starts["r2"] != 1 {
		t.Fatalf("starts = %v", starts)
	}

	if !mustConfirm(t, l, "r1", 1, ResultFailed) {
		t.Fatal("failure not applied")
	}
	if effects := mustReconcile(t, l); len(effects) != 0 {
		t.Fatalf("failed resource was retried implicitly: %v", effects)
	}
	applied, err := l.Retry(testObject, "r1")
	if err != nil || !applied {
		t.Fatalf("retry = %v, %v", applied, err)
	}
	starts := startEffects(mustReconcile(t, l))
	if starts["r1"] != 2 {
		t.Fatalf("retry start = %v, want attempt 2", starts)
	}
	if _, err := l.Retry(testObject, "r1"); !errors.Is(err, ErrAttemptInFlight) {
		t.Fatalf("retry over in-flight = %v, want ErrAttemptInFlight", err)
	}

	// Cancel the second in-flight attempt. It is safe to restart because a
	// cancelled attempt performed no cleanup.
	applied, err = l.Cancel(testObject, "r2")
	if err != nil || !applied {
		t.Fatalf("cancel = %v, %v", applied, err)
	}
	starts = startEffects(mustReconcile(t, l))
	if starts["r2"] != 2 {
		t.Fatalf("cancel restart = %v, want attempt 2", starts)
	}

	// A stale failure cannot regress the new attempt.
	if mustConfirm(t, l, "r2", 1, ResultFailed) {
		t.Fatal("stale failure was applied")
	}
	if res := resourceSnapshot(t, mustSnapshot(t, l), "r2"); res.State != ResourceInFlight || res.Attempt != 2 {
		t.Fatalf("r2 = %+v", res)
	}

	mustConfirm(t, l, "r1", 2, ResultSucceeded)
	mustConfirm(t, l, "r2", 2, ResultSucceeded)
	effects := mustReconcile(t, l)
	if len(effects) != 2 || effects[0].Kind != EffectRemoveKey || effects[1].Kind != EffectFinishObject {
		t.Fatalf("effects = %v", effects)
	}

	if applied, err := l.Retry(testObject, "r1"); err != nil || applied {
		t.Fatalf("retry after success = %v, %v", applied, err)
	}
	if applied, err := l.Cancel(testObject, "r1"); err != nil || applied {
		t.Fatalf("cancel after success = %v, %v", applied, err)
	}
	if effects := mustReconcile(t, l); len(effects) != 0 {
		t.Fatalf("completed resource restarted: %v", effects)
	}
	snap := mustSnapshot(t, l)
	if snap.SuccessRecords["r1"] != 1 || snap.SuccessRecords["r2"] != 1 {
		t.Fatalf("success records = %v", snap.SuccessRecords)
	}
}

func TestReconcileRequiresDeleteForRemoval(t *testing.T) {
	l := NewLedger()
	mustRegister(t, l, KeySpec{Key: "k", Resources: []ResourceID{"r"}})
	if err := l.BeginCleanup(testObject); err != nil {
		t.Fatal(err)
	}
	if starts := startEffects(mustReconcile(t, l)); starts["r"] != 1 {
		t.Fatalf("starts = %v", starts)
	}
	mustConfirm(t, l, "r", 1, ResultSucceeded)
	if effects := mustReconcile(t, l); len(effects) != 0 {
		t.Fatalf("key removed without delete event: %v", effects)
	}
	if snap := mustSnapshot(t, l); snap.Finished || keySnapshot(t, snap, "k").Removed {
		t.Fatalf("snapshot after pre-delete cleanup = %+v", snap)
	}
}

func TestValidationAndUnknownIDs(t *testing.T) {
	l := NewLedger()
	if _, err := l.Reconcile("missing"); !errors.Is(err, ErrUnknownObject) {
		t.Fatalf("reconcile missing = %v", err)
	}
	if err := l.Register(""); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("empty object = %v", err)
	}
	if err := l.Register(testObject, KeySpec{Key: ""}); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("empty key = %v", err)
	}
	mustRegister(t, l, KeySpec{Key: "k", Resources: []ResourceID{"r"}})
	if _, err := l.Confirm(testObject, "missing", 1, ResultSucceeded); !errors.Is(err, ErrUnknownResource) {
		t.Fatalf("unknown resource = %v", err)
	}
	if _, err := l.Confirm(testObject, "r", 0, ResultSucceeded); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("zero attempt = %v", err)
	}
	if _, err := l.Confirm(testObject, "r", 1, Result(99)); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("bad result = %v", err)
	}
}

func TestReplayRejectsInvalidLog(t *testing.T) {
	l, err := Replay([]Event{{Kind: EventDelete, Object: "missing"}})
	if !errors.Is(err, ErrUnknownObject) {
		t.Fatalf("replay error = %v", err)
	}
	if l == nil {
		t.Fatal("replay should return the replayed prefix")
	}

	l = NewLedger()
	if _, err := l.Apply(Event{Kind: EventDelete, Object: ""}); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("invalid apply = %v", err)
	}
	if got := len(l.EventLog()); got != 0 {
		t.Fatalf("invalid event was logged: %d events", got)
	}
}

func TestConcurrentConfirmAndDeleteExactlyOnce(t *testing.T) {
	const iterations = 100
	for iter := 0; iter < iterations; iter++ {
		l := NewLedger()
		mustRegister(t, l, KeySpec{Key: "k", Resources: []ResourceID{"r1", "r2"}})
		if err := l.BeginCleanup(testObject); err != nil {
			t.Fatal(err)
		}
		starts := startEffects(mustReconcile(t, l))
		for _, id := range []ResourceID{"r1", "r2"} {
			if starts[id] != 1 {
				t.Fatalf("iteration %d start = %v", iter, starts)
			}
		}

		start := make(chan struct{})
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				if _, err := l.Confirm(testObject, "r1", 1, ResultSucceeded); err != nil {
					t.Errorf("confirm r1: %v", err)
				}
			}()
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				if _, err := l.Confirm(testObject, "r2", 1, ResultSucceeded); err != nil {
					t.Errorf("confirm r2: %v", err)
				}
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if err := l.Delete(testObject); err != nil {
				t.Errorf("delete: %v", err)
			}
		}()
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, err := l.Reconcile(testObject); err != nil {
				t.Errorf("reconcile: %v", err)
			}
		}()

		close(start)
		wg.Wait()
		// The concurrent reconcile may already have retired the key. A final
		// reconcile must be a no-op in that case.
		mustReconcile(t, l)
		snap := mustSnapshot(t, l)
		if !snap.Finished {
			t.Fatalf("iteration %d not finished: %+v", iter, snap)
		}
		for _, id := range []ResourceID{"r1", "r2"} {
			if got := snap.SuccessRecords[id]; got != 1 {
				t.Fatalf("iteration %d %s success count = %d", iter, id, got)
			}
		}
	}
}

func TestConcurrentSuccessVersusCancellation(t *testing.T) {
	const iterations = 100
	for iter := 0; iter < iterations; iter++ {
		l := NewLedger()
		mustRegister(t, l, KeySpec{Key: "k", Resources: []ResourceID{"r"}})
		mustDelete(t, l)
		if starts := startEffects(mustReconcile(t, l)); starts["r"] != 1 {
			t.Fatalf("iteration %d starts = %v", iter, starts)
		}

		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(3)
		go func() {
			defer wg.Done()
			<-start
			if _, err := l.Confirm(testObject, "r", 1, ResultSucceeded); err != nil {
				t.Errorf("success: %v", err)
			}
		}()
		go func() {
			defer wg.Done()
			<-start
			if _, err := l.Cancel(testObject, "r"); err != nil {
				t.Errorf("cancel: %v", err)
			}
		}()
		go func() {
			defer wg.Done()
			<-start
			if _, err := l.Confirm(testObject, "r", 1, ResultFailed); err != nil {
				t.Errorf("failure: %v", err)
			}
		}()
		close(start)
		wg.Wait()

		// Whichever result is recorded first, success is monotonic and the
		// resource must not be restarted.
		if effects := mustReconcile(t, l); len(effects) != 2 ||
			effects[0].Kind != EffectRemoveKey || effects[1].Kind != EffectFinishObject {
			t.Fatalf("iteration %d effects = %v", iter, effects)
		}
		snap := mustSnapshot(t, l)
		res := resourceSnapshot(t, snap, "r")
		if res.State != ResourceSucceeded || res.Attempt != 1 {
			t.Fatalf("iteration %d resource = %+v", iter, res)
		}
		if got := snap.SuccessRecords["r"]; got != 1 {
			t.Fatalf("iteration %d success count = %d", iter, got)
		}
	}
}

func TestReplayEveryPrefix(t *testing.T) {
	l := NewLedger()
	var inputs []Event
	step := func(ev Event) {
		t.Helper()
		inputs = append(inputs, ev)
		if _, err := l.Apply(ev); err != nil {
			t.Fatalf("apply %s: %v", ev.Kind, err)
		}
		replayed, err := Replay(inputs)
		if err != nil {
			t.Fatalf("replay %d events: %v", len(inputs), err)
		}
		want := mustSnapshot(t, l)
		got, ok := replayed.Snapshot(testObject)
		if !ok || !reflect.DeepEqual(want, got) {
			t.Fatalf("replay mismatch after %d events:\nwant %+v\n got %+v", len(inputs), want, got)
		}
	}

	step(Event{Kind: EventRegister, Object: testObject, Keys: []KeySpec{{Key: "k1", Resources: []ResourceID{"r1", "r2"}}, {Key: "k2", Resources: []ResourceID{"r3"}}}})
	step(Event{Kind: EventBeginCleanup, Object: testObject})
	step(Event{Kind: EventDelete, Object: testObject})
	step(Event{Kind: EventReconcile, Object: testObject})
	step(Event{Kind: EventConfirm, Object: testObject, Resource: "r1", Attempt: 1, Result: ResultFailed})
	step(Event{Kind: EventRetry, Object: testObject, Resource: "r1"})
	step(Event{Kind: EventReconcile, Object: testObject})
	step(Event{Kind: EventConfirm, Object: testObject, Resource: "r1", Attempt: 2, Result: ResultSucceeded})
	step(Event{Kind: EventConfirm, Object: testObject, Resource: "r2", Attempt: 1, Result: ResultCancelled})
	step(Event{Kind: EventReconcile, Object: testObject})
	step(Event{Kind: EventConfirm, Object: testObject, Resource: "r2", Attempt: 2, Result: ResultSucceeded})
	step(Event{Kind: EventReconcile, Object: testObject})
	step(Event{Kind: EventConfirm, Object: testObject, Resource: "r3", Attempt: 1, Result: ResultSucceeded})
	step(Event{Kind: EventReconcile, Object: testObject})

	snap := mustSnapshot(t, l)
	if !snap.Finished {
		t.Fatalf("scenario did not finish: %+v", snap)
	}
}
