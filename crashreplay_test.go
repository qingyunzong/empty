package crashreplay

import (
	"bytes"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func trace(t *testing.T, text string) []Event {
	t.Helper()
	events, err := ParseTrace(strings.NewReader(text))
	if err != nil {
		t.Fatalf("parse trace: %v", err)
	}
	return events
}

func TestSyncPersistsWritesAcrossCrash(t *testing.T) {
	s := NewStore(1)
	s.WriteOp("a", "1")
	s.WriteOp("b", "2")
	s.Sync()
	got := s.Crash()
	if got["a"] != "1" || got["b"] != "2" {
		t.Fatalf("synced writes lost: %v", got)
	}
	if len(s.Pending()) != 0 {
		t.Fatalf("pending not cleared after crash")
	}
}

func TestEnumerationCountsAllSubsets(t *testing.T) {
	s := NewStore(1)
	for i := 0; i < 5; i++ {
		s.WriteOp(fmt.Sprintf("k%d", i), "v")
	}
	recs, ok := PossibleRecoveries(s.Disk(), s.Pending())
	if !ok {
		t.Fatal("expected enumeration within budget")
	}
	if len(recs) != 32 {
		t.Fatalf("want 32 subsets, got %d", len(recs))
	}
}

func TestCounterexampleReturnedWithActualRecovery(t *testing.T) {
	events := trace(t, `
write a 1
sync
write a 2
crash
expect eq a 1
recover
`)
	res := Check(events, 7)
	if res.Verdict != Counterexample {
		t.Fatalf("want counterexample, got %v", res.Verdict)
	}
	ce := res.Counterexample
	if ce.Expectation.Op != "eq" || ce.Expectation.Key != "a" {
		t.Fatalf("unexpected expectation: %v", ce.Expectation)
	}
	if ce.State["a"] != "2" {
		t.Fatalf("counterexample state should have a=2, got %v", ce.State)
	}
	if len(ce.Persisted) != 1 || ce.Persisted[0].Value != "2" {
		t.Fatalf("persisted subset should be the unsynced write, got %v", ce.Persisted)
	}
	if ce.Actual == nil {
		t.Fatal("actual recovery result not reported")
	}
	if _, isPossible := possibleStateSet(t, res.Crashes[0])[stateKey(ce.Actual)]; !isPossible {
		t.Fatalf("actual recovery %v not among enumerated recoveries", ce.Actual)
	}
}

func TestFirstCounterexampleIsFirst(t *testing.T) {
	events := trace(t, `
write a 1
crash
expect absent a
expect has a
recover
write b 1
crash
expect absent b
recover
`)
	res := Check(events, 1)
	if res.Verdict != Counterexample {
		t.Fatalf("want counterexample, got %v", res.Verdict)
	}
	if res.Counterexample.CrashIndex != 0 {
		t.Fatalf("first counterexample should be at crash #0, got #%d", res.Counterexample.CrashIndex)
	}
	// Enumeration is subset-major: the empty recovery (mask 0) is checked
	// first and violates "has a".
	if res.Counterexample.Expectation.Op != "has" {
		t.Fatalf("first failing expectation should be 'has a', got %v", res.Counterexample.Expectation)
	}
	if len(res.Crashes) != 1 {
		t.Fatalf("checking should stop at first counterexample, got %d crashes", len(res.Crashes))
	}
}

func TestUnknownWhenBudgetExceeded(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < MaxEnumeratedWrites+1; i++ {
		fmt.Fprintf(&sb, "write k%d v\n", i)
	}
	sb.WriteString("crash\nexpect has k0\nrecover\n")
	res := Check(trace(t, sb.String()), 3)
	if res.Verdict != Unknown {
		t.Fatalf("want unknown, got %v", res.Verdict)
	}
	if !res.Crashes[0].Unknown {
		t.Fatal("crash report should be marked unknown")
	}
	if res.Crashes[0].Actual == nil {
		t.Fatal("actual recovery should still be reported when unknown")
	}
}

func TestOKWhenInvariantsHold(t *testing.T) {
	events := trace(t, `
write a 1
sync
write b 2
crash
expect eq a 1
expect absent b
recover
`)
	// b is unsynced, so it may survive: use neq-free invariant instead.
	events = trace(t, `
write a 1
sync
write b 2
crash
expect eq a 1
recover
`)
	res := Check(events, 1)
	if res.Verdict != OK {
		t.Fatalf("want OK, got %v (%+v)", res.Verdict, res.Counterexample)
	}
	if res.Crashes[0].States != 2 {
		t.Fatalf("want 2 enumerated recoveries, got %d", res.Crashes[0].States)
	}
}

// Acceptance: the deliberately out-of-order, lossy publish implementation
// always lands on one of the enumerated possible recoveries.
func TestActualRecoveryAlwaysWithinEnumeratedSet(t *testing.T) {
	for seed := int64(0); seed < 200; seed++ {
		s := NewStore(seed)
		rng := rand.New(rand.NewSource(seed))
		keys := []string{"a", "b", "c"}
		writes := 1 + rng.Intn(10)
		for i := 0; i < writes; i++ {
			s.WriteOp(keys[rng.Intn(len(keys))], fmt.Sprintf("v%d", i))
			if rng.Intn(4) == 0 {
				s.Sync()
			}
		}
		recs, ok := PossibleRecoveries(s.Disk(), s.Pending())
		if !ok {
			t.Fatal("test setup exceeded budget")
		}
		set := map[string]bool{}
		for _, r := range recs {
			set[stateKey(r.State)] = true
		}
		actual := s.Crash()
		if !set[stateKey(actual)] {
			t.Fatalf("seed %d: actual recovery %v not in enumerated set", seed, actual)
		}
	}
}

// Acceptance: the crash path really does publish out of order, and any
// out-of-order application of any subset equals some program-order subset
// application (exhaustive over small logs with overwriting keys).
func TestOutOfOrderPublishCoveredBySubsetEnumeration(t *testing.T) {
	// The implementation scrambles publish order for some seed.
	scrambled := false
	for seed := int64(0); seed < 50 && !scrambled; seed++ {
		s := NewStore(seed)
		for i := 0; i < 4; i++ {
			s.WriteOp(fmt.Sprintf("k%d", i), "v")
		}
		s.Crash()
		for i, rec := range s.LastPublish {
			if rec.PublishSlot != i {
				scrambled = true
				break
			}
		}
	}
	if !scrambled {
		t.Fatal("crash never published out of order across 50 seeds")
	}

	// Exhaustive: every permutation x subset of a 4-write log with
	// overwrites is covered by the program-order subset enumeration.
	pending := []Write{
		{Seq: 1, Key: "x", Value: "1"},
		{Seq: 2, Key: "y", Value: "2"},
		{Seq: 3, Key: "x", Value: "3"},
		{Seq: 4, Key: "y", Value: "4"},
	}
	recs, ok := PossibleRecoveries(map[string]string{}, pending)
	if !ok {
		t.Fatal("within budget")
	}
	set := map[string]bool{}
	for _, r := range recs {
		set[stateKey(r.State)] = true
	}
	perm := []int{0, 1, 2, 3}
	for first := true; ; {
		if !first {
			if !nextPerm(perm) {
				break
			}
		}
		first = false
		for mask := 0; mask < 1<<4; mask++ {
			state := map[string]string{}
			for _, idx := range perm {
				if mask&(1<<uint(idx)) != 0 {
					state[pending[idx].Key] = pending[idx].Value
				}
			}
			if !set[stateKey(state)] {
				t.Fatalf("permutation %v mask %04b uncovered: %v", perm, mask, state)
			}
		}
	}
}

func TestParseErrors(t *testing.T) {
	for _, bad := range []string{
		"write a\n",
		"frobnicate\n",
		"expect maybe a\n",
		"expect eq a\n",
	} {
		if _, err := ParseTrace(strings.NewReader(bad)); err == nil {
			t.Fatalf("expected parse error for %q", bad)
		}
	}
}

func TestTraceStructureErrors(t *testing.T) {
	res := Check(trace(t, "expect has a\n"), 1)
	if res.Err == nil {
		t.Fatal("expect without crash should be a trace error")
	}
	res = Check(trace(t, "recover\n"), 1)
	if res.Err == nil {
		t.Fatal("recover without crash should be a trace error")
	}
}

func TestCLIEndToEnd(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	okTrace := write("ok.trace", "write a 1\nsync\ncrash\nexpect eq a 1\nrecover\n")
	badTrace := write("bad.trace", "write a 1\ncrash\nexpect absent a\nrecover\n")
	var big strings.Builder
	for i := 0; i < MaxEnumeratedWrites+1; i++ {
		fmt.Fprintf(&big, "write k%d v\n", i)
	}
	big.WriteString("crash\nrecover\n")
	unknownTrace := write("unknown.trace", big.String())

	var out bytes.Buffer
	if code := Run([]string{"verify", okTrace}, &out); code != ExitOK {
		t.Fatalf("ok trace: exit %d, out %s", code, out.String())
	}
	if !strings.Contains(out.String(), "OK:") {
		t.Fatalf("ok trace output: %s", out.String())
	}

	out.Reset()
	if code := Run([]string{"verify", badTrace}, &out); code != ExitCounterexample {
		t.Fatalf("bad trace: exit %d, out %s", code, out.String())
	}
	if !strings.Contains(out.String(), "COUNTEREXAMPLE") ||
		!strings.Contains(out.String(), "actual recovery") {
		t.Fatalf("counterexample output incomplete: %s", out.String())
	}

	out.Reset()
	if code := Run([]string{"verify", unknownTrace}, &out); code != ExitUnknown {
		t.Fatalf("unknown trace: exit %d, out %s", code, out.String())
	}
	if !strings.Contains(out.String(), "UNKNOWN") {
		t.Fatalf("unknown output: %s", out.String())
	}

	out.Reset()
	if code := Run([]string{"verify", filepath.Join(dir, "missing.trace")}, &out); code != ExitError {
		t.Fatalf("missing file: exit %d", code)
	}
}

func stateKey(m map[string]string) string {
	var sb strings.Builder
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	for _, k := range keys {
		fmt.Fprintf(&sb, "%s=%s;", k, m[k])
	}
	return sb.String()
}

func possibleStateSet(t *testing.T, report CrashReport) map[string]bool {
	t.Helper()
	set := map[string]bool{}
	recs, ok := PossibleRecoveries(report.PreCrashDisk, report.Pending)
	if !ok {
		t.Fatal("report exceeded enumeration budget")
	}
	for _, r := range recs {
		set[stateKey(r.State)] = true
	}
	return set
}

func nextPerm(p []int) bool {
	i := len(p) - 2
	for i >= 0 && p[i] >= p[i+1] {
		i--
	}
	if i < 0 {
		return false
	}
	j := len(p) - 1
	for p[j] <= p[i] {
		j--
	}
	p[i], p[j] = p[j], p[i]
	for lo, hi := i+1, len(p)-1; lo < hi; lo, hi = lo+1, hi-1 {
		p[lo], p[hi] = p[hi], p[lo]
	}
	return true
}
