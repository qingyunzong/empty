package formal_test

import (
	"fmt"
	"math"
	"sort"
	"testing"

	formal "example.org/dlks/formal/q10095"
)

// refProbe is the deliberately simple reference counter for one probe stream.
type refProbe struct {
	attempts  int
	successes int
	failures  int
	passRun   int
	failRun   int
}

func (p *refProbe) apply(pass bool) {
	p.attempts++
	if pass {
		p.successes++
		p.passRun++
		p.failRun = 0
		return
	}
	p.failures++
	p.failRun++
	p.passRun = 0
}

// refInstance is a naive state machine written directly from the package
// contract. It intentionally shares no implementation with formal.instance.
type refInstance struct {
	id  formal.InstanceID
	cfg formal.Config

	startup   refProbe
	readiness refProbe
	liveness  refProbe

	startupOK   bool
	startupBad  bool
	readinessOK bool
	livenessOK  bool
}

func newRefInstance(id formal.InstanceID, cfg formal.Config) *refInstance {
	return &refInstance{id: id, cfg: cfg, livenessOK: true}
}

func (r *refInstance) apply(kind formal.ProbeKind, result formal.ProbeResult) {
	pass := result == formal.ProbePass
	switch kind {
	case formal.ProbeStartup:
		r.startup.apply(pass)
		if pass {
			if r.startup.passRun >= r.cfg.StartupSuccessThreshold {
				r.startupOK = true
				r.startupBad = false
			}
		} else if !r.startupOK && r.startup.failRun >= r.cfg.StartupFailureThreshold {
			r.startupBad = true
		}
	case formal.ProbeReadiness:
		r.readiness.apply(pass)
		if pass {
			if r.readiness.passRun >= r.cfg.ReadinessSuccessThreshold {
				r.readinessOK = true
			}
		} else if r.readiness.failRun >= r.cfg.ReadinessFailureThreshold {
			r.readinessOK = false
		}
	case formal.ProbeLiveness:
		r.liveness.apply(pass)
		if pass {
			if r.liveness.passRun >= r.cfg.LivenessSuccessThreshold {
				r.livenessOK = true
			}
		} else if r.liveness.failRun >= r.cfg.LivenessFailureThreshold {
			r.livenessOK = false
		}
	}
}

func (r *refInstance) state() formal.State {
	if r.startupBad {
		return formal.StateUnhealthy
	}
	if !r.startupOK {
		return formal.StateStarting
	}
	if !r.livenessOK {
		return formal.StateUnhealthy
	}
	if !r.readinessOK {
		return formal.StateNotReady
	}
	return formal.StateReady
}

func (r *refInstance) backoffLevel() int {
	level := r.readiness.failRun
	if r.liveness.failRun > level {
		level = r.liveness.failRun
	}
	if !r.startupOK && r.startup.failRun > level {
		level = r.startup.failRun
	}
	return level
}

func (r *refInstance) probeStatus(kind formal.ProbeKind) formal.ProbeStatus {
	var p *refProbe
	switch kind {
	case formal.ProbeStartup:
		p = &r.startup
	case formal.ProbeReadiness:
		p = &r.readiness
	case formal.ProbeLiveness:
		p = &r.liveness
	}
	return formal.ProbeStatus{
		Attempts:             p.attempts,
		Successes:            p.successes,
		Failures:             p.failures,
		ConsecutiveSuccesses: p.passRun,
		ConsecutiveFailures:  p.failRun,
	}
}

func checkProbeStatus(t *testing.T, got, want formal.ProbeStatus, id formal.InstanceID, kind formal.ProbeKind, ctx string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: instance %q %s counters = %+v, want %+v", ctx, id, kind, got, want)
	}
	if got.Attempts != got.Successes+got.Failures {
		t.Fatalf("%s: instance %q %s counters are not one-to-one: %+v", ctx, id, kind, got)
	}
	if got.ConsecutiveSuccesses > got.Attempts || got.ConsecutiveFailures > got.Attempts {
		t.Fatalf("%s: instance %q %s consecutive counter exceeds attempts: %+v", ctx, id, kind, got)
	}
}

func checkSnapshot(t *testing.T, got formal.Snapshot, ref *refInstance, cfg formal.Config, ctx string) {
	t.Helper()
	wantState := ref.state()
	if got.ID != ref.id {
		t.Fatalf("%s: snapshot ID = %q, want %q", ctx, got.ID, ref.id)
	}
	if got.State != wantState {
		t.Fatalf("%s: instance %q state = %s, want %s (%+v)", ctx, got.ID, got.State, wantState, got)
	}
	if got.Ready != (wantState == formal.StateReady) {
		t.Fatalf("%s: instance %q Ready = %v in state %s", ctx, got.ID, got.Ready, got.State)
	}
	if got.ReceivesTraffic != wantState.TrafficEligible() {
		t.Fatalf("%s: instance %q ReceivesTraffic = %v in state %s", ctx, got.ID, got.ReceivesTraffic, got.State)
	}
	if got.StartupDone != ref.startupOK || got.StartupFailed != ref.startupBad {
		t.Fatalf("%s: instance %q startup flags = done:%v failed:%v, want done:%v failed:%v",
			ctx, got.ID, got.StartupDone, got.StartupFailed, ref.startupOK, ref.startupBad)
	}
	if got.ReadinessPassing != ref.readinessOK || got.LivenessHealthy != ref.livenessOK {
		t.Fatalf("%s: instance %q readiness/liveness = %v/%v, want %v/%v",
			ctx, got.ID, got.ReadinessPassing, got.LivenessHealthy, ref.readinessOK, ref.livenessOK)
	}
	checkProbeStatus(t, got.Startup, ref.probeStatus(formal.ProbeStartup), got.ID, formal.ProbeStartup, ctx)
	checkProbeStatus(t, got.Readiness, ref.probeStatus(formal.ProbeReadiness), got.ID, formal.ProbeReadiness, ctx)
	checkProbeStatus(t, got.Liveness, ref.probeStatus(formal.ProbeLiveness), got.ID, formal.ProbeLiveness, ctx)

	if got.BackoffLevel != ref.backoffLevel() {
		t.Fatalf("%s: instance %q backoff level = %d, want %d", ctx, got.ID, got.BackoffLevel, ref.backoffLevel())
	}
	if got.NextProbeDelay != cfg.BackoffDelay(ref.backoffLevel()) {
		t.Fatalf("%s: instance %q next delay = %v, want %v", ctx, got.ID, got.NextProbeDelay, cfg.BackoffDelay(ref.backoffLevel()))
	}
}

func checkTraffic(t *testing.T, a *formal.Aggregator, refs map[formal.InstanceID]*refInstance, ctx string) {
	t.Helper()
	want := make([]formal.InstanceID, 0, len(refs))
	for id, ref := range refs {
		if ref.state() == formal.StateReady {
			want = append(want, id)
		}
	}
	sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })

	got := a.ReadyInstances()
	if len(got) != len(want) {
		t.Fatalf("%s: ready instances = %v, want %v", ctx, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s: ready instances = %v, want %v", ctx, got, want)
		}
	}

	traffic := a.TrafficMap()
	if len(traffic) != len(refs) {
		t.Fatalf("%s: traffic map has %d entries, want %d", ctx, len(traffic), len(refs))
	}
	for id, ref := range refs {
		if traffic[id] != (ref.state() == formal.StateReady) {
			t.Fatalf("%s: traffic[%q] = %v, want %v", ctx, id, traffic[id], ref.state() == formal.StateReady)
		}
	}
}

type probeEvent struct {
	instance int
	kind     formal.ProbeKind
	result   formal.ProbeResult
}

func (e probeEvent) String() string {
	return fmt.Sprintf("i%d:%s:%s", e.instance, e.kind, e.result)
}

var singleAlphabet = []struct {
	kind   formal.ProbeKind
	result formal.ProbeResult
}{
	{formal.ProbeStartup, formal.ProbePass},
	{formal.ProbeStartup, formal.ProbeFail},
	{formal.ProbeReadiness, formal.ProbePass},
	{formal.ProbeReadiness, formal.ProbeFail},
	{formal.ProbeLiveness, formal.ProbePass},
	{formal.ProbeLiveness, formal.ProbeFail},
}

func decodeSequence(code, length, base int, alphabet []probeEvent) []probeEvent {
	out := make([]probeEvent, length)
	for i := length - 1; i >= 0; i-- {
		out[i] = alphabet[code%base]
		code /= base
	}
	return out
}

func formatSequence(seq []probeEvent) string {
	out := ""
	for i, ev := range seq {
		if i > 0 {
			out += " "
		}
		out += ev.String()
	}
	return out
}

func mustNew(t *testing.T, cfg formal.Config, ids ...formal.InstanceID) *formal.Aggregator {
	t.Helper()
	a, err := formal.New(cfg, ids...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return a
}

// TestExhaustiveSingleInstanceProbeSequences enumerates every sequence of six
// probe events over the full alphabet {startup, readiness, liveness} x
// {pass, fail}. After every event it compares the production aggregator with
// the naive reference state machine, including all per-kind counters.
func TestExhaustiveSingleInstanceProbeSequences(t *testing.T) {
	cfg := formal.DefaultConfig()
	const length = 6
	const id = formal.InstanceID("only")

	alphabet := make([]probeEvent, 0, len(singleAlphabet))
	for _, ev := range singleAlphabet {
		alphabet = append(alphabet, probeEvent{instance: 0, kind: ev.kind, result: ev.result})
	}
	total := int(math.Pow(float64(len(alphabet)), float64(length)))
	for code := 0; code < total; code++ {
		seq := decodeSequence(code, length, len(alphabet), alphabet)
		a := mustNew(t, cfg, id)
		ref := newRefInstance(id, cfg)
		for step, ev := range seq {
			snap, err := a.Record(id, ev.kind, ev.result)
			if err != nil {
				t.Fatalf("Record: %v", err)
			}
			ref.apply(ev.kind, ev.result)
			checkSnapshot(t, snap, ref, cfg, fmt.Sprintf("seq[%d] %s", step, formatSequence(seq)))
			again, ok := a.SnapshotFor(id)
			if !ok {
				t.Fatalf("SnapshotFor(%q) missing", id)
			}
			if again != snap {
				t.Fatalf("SnapshotFor = %+v, Record returned %+v", again, snap)
			}
			checkTraffic(t, a, map[formal.InstanceID]*refInstance{id: ref},
				fmt.Sprintf("seq[%d] %s", step, formatSequence(seq)))
		}
	}
}

// TestExhaustiveTwoInstanceJointSequences enumerates all five-event joint
// sequences over both instances and all three probe kinds. This checks that
// counters and state never leak between instances while removals and
// recoveries interleave.
func TestExhaustiveTwoInstanceJointSequences(t *testing.T) {
	cfg := formal.DefaultConfig()
	cfg.StartupFailureThreshold = 2
	cfg.ReadinessSuccessThreshold = 2
	cfg.ReadinessFailureThreshold = 2
	cfg.LivenessSuccessThreshold = 2
	cfg.LivenessFailureThreshold = 2
	cfg.BackoffBase = 10
	cfg.BackoffMax = 40

	ids := []formal.InstanceID{"a", "b"}
	alphabet := make([]probeEvent, 0, 2*len(singleAlphabet))
	for instance := range ids {
		for _, ev := range singleAlphabet {
			alphabet = append(alphabet, probeEvent{instance: instance, kind: ev.kind, result: ev.result})
		}
	}

	const length = 5
	total := int(math.Pow(float64(len(alphabet)), float64(length)))
	for code := 0; code < total; code++ {
		seq := decodeSequence(code, length, len(alphabet), alphabet)
		a := mustNew(t, cfg, ids...)
		refs := map[formal.InstanceID]*refInstance{
			ids[0]: newRefInstance(ids[0], cfg),
			ids[1]: newRefInstance(ids[1], cfg),
		}
		for step, ev := range seq {
			id := ids[ev.instance]
			snap, err := a.Record(id, ev.kind, ev.result)
			if err != nil {
				t.Fatalf("Record: %v", err)
			}
			refs[id].apply(ev.kind, ev.result)
			ctx := fmt.Sprintf("seq[%d] %s", step, formatSequence(seq))
			checkSnapshot(t, snap, refs[id], cfg, ctx)
			for _, other := range ids {
				got, ok := a.SnapshotFor(other)
				if !ok {
					t.Fatalf("%s: SnapshotFor(%q) missing", ctx, other)
				}
				checkSnapshot(t, got, refs[other], cfg, ctx)
			}
			checkTraffic(t, a, refs, ctx)
			for _, selected := range a.Select(2) {
				if refs[selected].state() != formal.StateReady {
					t.Fatalf("%s: Select returned non-ready instance %q", ctx, selected)
				}
			}
		}
	}
}

// TestExhaustiveReadyTrafficInterleavings warms both instances to Ready then
// enumerates every readiness pass/fail sequence for each instance, feeding them
// in an interleaved A,B order. After every event it compares the ready set and
// verifies that traffic selection never includes a non-ready instance.
func TestExhaustiveReadyTrafficInterleavings(t *testing.T) {
	cfg := formal.DefaultConfig()
	cfg.ReadinessFailureThreshold = 3
	cfg.ReadinessSuccessThreshold = 3
	cfg.LivenessFailureThreshold = 2
	cfg.LivenessSuccessThreshold = 2

	ids := []formal.InstanceID{"a", "b"}
	const length = 7
	const patterns = 1 << length

	for pa := 0; pa < patterns; pa++ {
		for pb := 0; pb < patterns; pb++ {
			a := mustNew(t, cfg, ids...)
			refs := map[formal.InstanceID]*refInstance{
				ids[0]: newRefInstance(ids[0], cfg),
				ids[1]: newRefInstance(ids[1], cfg),
			}
			warm := func(id formal.InstanceID, ref *refInstance) {
				snap, err := a.Record(id, formal.ProbeStartup, formal.ProbePass)
				if err != nil {
					t.Fatalf("Record: %v", err)
				}
				ref.apply(formal.ProbeStartup, formal.ProbePass)
				checkSnapshot(t, snap, ref, cfg, "startup warmup")
				for i := 0; i < cfg.ReadinessSuccessThreshold; i++ {
					snap, err := a.Record(id, formal.ProbeReadiness, formal.ProbePass)
					if err != nil {
						t.Fatalf("Record: %v", err)
					}
					ref.apply(formal.ProbeReadiness, formal.ProbePass)
					checkSnapshot(t, snap, ref, cfg, "readiness warmup")
				}
			}
			warm(ids[0], refs[ids[0]])
			warm(ids[1], refs[ids[1]])

			for step := 0; step < length; step++ {
				if step == length-1 {
					// Exercise a liveness removal just before the final event.
					snap, err := a.Record(ids[1], formal.ProbeLiveness, formal.ProbeFail)
					if err != nil {
						t.Fatalf("Record: %v", err)
					}
					refs[ids[1]].apply(formal.ProbeLiveness, formal.ProbeFail)
					checkSnapshot(t, snap, refs[ids[1]], cfg, "liveness event")
					checkTraffic(t, a, refs, "liveness event")
				}
				for _, id := range ids {
					result := formal.ProbePass
					if id == ids[0] && pa&(1<<step) != 0 {
						result = formal.ProbeFail
					}
					if id == ids[1] && pb&(1<<step) != 0 {
						result = formal.ProbeFail
					}
					snap, err := a.Record(id, formal.ProbeReadiness, result)
					if err != nil {
						t.Fatalf("Record: %v", err)
					}
					refs[id].apply(formal.ProbeReadiness, result)
					ctx := fmt.Sprintf("pa=%07b pb=%07b step=%d", pa, pb, step)
					checkSnapshot(t, snap, refs[id], cfg, ctx)
					checkTraffic(t, a, refs, ctx)
					for _, selected := range a.Select(2) {
						if refs[selected].state() != formal.StateReady {
							t.Fatalf("%s: Select returned non-ready instance %q", ctx, selected)
						}
					}
				}
			}
		}
	}
}
