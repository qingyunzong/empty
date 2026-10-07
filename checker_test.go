package ticketlog

import (
	"strings"
	"testing"
)

func ev(op Op, ticket string, amount int) Event {
	return Event{Op: op, Ticket: ticket, Amount: amount}
}

func checkErr(t *testing.T, events []Event, wantKind string) *Error {
	t.Helper()
	err := Check(events)
	if err == nil {
		t.Fatalf("expected error kind %q, got valid log", wantKind)
	}
	if err.Kind != wantKind {
		t.Fatalf("expected error kind %q, got %q: %s", wantKind, err.Kind, err)
	}
	return err
}

func checkValid(t *testing.T, events []Event) {
	t.Helper()
	if err := Check(events); err != nil {
		t.Fatalf("expected valid log, got %s\n%s", err, err.Detail())
	}
}

func TestValidLifecycle(t *testing.T) {
	checkValid(t, []Event{
		ev(OpLimit, "", 100),
		ev(OpApply, "A", 30),
		ev(OpGrant, "A", 0),
		ev(OpApply, "B", 40),
		ev(OpGrant, "B", 0),
		ev(OpRelease, "A", 0),
		ev(OpApply, "C", 10),
		ev(OpCancel, "C", 0),
		ev(OpRelease, "B", 0),
	})
}

func TestGenerationRebuild(t *testing.T) {
	// A ticket id reused across generations: state must reset each time.
	checkValid(t, []Event{
		ev(OpLimit, "", 50),
		ev(OpApply, "A", 10),
		ev(OpGrant, "A", 0),
		ev(OpRelease, "A", 0),
		ev(OpApply, "A", 20), // generation 2
		ev(OpGrant, "A", 0),
		ev(OpRelease, "A", 0),
		ev(OpApply, "A", 30), // generation 3, cancelled
		ev(OpCancel, "A", 0),
		ev(OpApply, "A", 40), // generation 4
		ev(OpGrant, "A", 0),
		ev(OpRelease, "A", 0),
	})
}

func TestDuplicateRelease(t *testing.T) {
	err := checkErr(t, []Event{
		ev(OpLimit, "", 100),
		ev(OpApply, "A", 30),
		ev(OpGrant, "A", 0),
		ev(OpRelease, "A", 0),
		ev(OpRelease, "A", 0), // duplicate
	}, "duplicate-release")
	// The causal chain must show the full first lifecycle plus the
	// offending second release, in order.
	if len(err.Chain) != 4 {
		t.Fatalf("expected 4 chain entries, got %d: %s", len(err.Chain), err.Detail())
	}
	wantOps := []Op{OpApply, OpGrant, OpRelease, OpRelease}
	for i, want := range wantOps {
		if err.Chain[i].Event.Op != want {
			t.Fatalf("chain[%d] op = %s, want %s\n%s", i, err.Chain[i].Event.Op, want, err.Detail())
		}
	}
	if err.Chain[3].Event.Seq != 5 {
		t.Fatalf("offending event seq = %d, want 5", err.Chain[3].Event.Seq)
	}
}

func TestReleaseAfterCancel(t *testing.T) {
	checkErr(t, []Event{
		ev(OpLimit, "", 100),
		ev(OpApply, "A", 30),
		ev(OpCancel, "A", 0),
		ev(OpRelease, "A", 0),
	}, "release-after-cancel")
}

func TestReleaseUngranted(t *testing.T) {
	checkErr(t, []Event{
		ev(OpLimit, "", 100),
		ev(OpApply, "A", 30),
		ev(OpRelease, "A", 0),
	}, "release-ungranted")
}

func TestCancelUngrantedFreesNothing(t *testing.T) {
	// Cancel of a pending application must not free units: A holds 60,
	// so lowering the limit to 59 must fail even though B was cancelled.
	events := []Event{
		ev(OpLimit, "", 100),
		ev(OpApply, "A", 60),
		ev(OpGrant, "A", 0),
		ev(OpApply, "B", 50),
		ev(OpCancel, "B", 0),
		ev(OpLimit, "", 60), // exactly at the held amount: still valid
	}
	checkValid(t, events)
	events = append(events, ev(OpLimit, "", 59))
	err := checkErr(t, events, "limit-exceeded")
	if !strings.Contains(err.Message, "60 exceeds current limit 59") {
		t.Fatalf("unexpected message: %s", err.Message)
	}
}

func TestLimitExceededAtGrant(t *testing.T) {
	err := checkErr(t, []Event{
		ev(OpLimit, "", 10),
		ev(OpApply, "A", 5),
		ev(OpGrant, "A", 0),
		ev(OpApply, "B", 6),
		ev(OpGrant, "B", 0), // 5+6 > 10
	}, "limit-exceeded")
	// Chain: limit, both applications, both grants... first grant held,
	// offending grant last.
	if len(err.Chain) != 5 {
		t.Fatalf("expected 5 chain entries, got %d: %s", len(err.Chain), err.Detail())
	}
	last := err.Chain[len(err.Chain)-1]
	if last.Event.Seq != 5 || last.Event.Op != OpGrant {
		t.Fatalf("chain must end at offending grant, got %v", last.Event)
	}
	for _, seq := range []int{1, 2, 3, 4} {
		found := false
		for _, ce := range err.Chain {
			if ce.Event.Seq == seq {
				found = true
			}
		}
		if !found {
			t.Fatalf("chain missing event #%d\n%s", seq, err.Detail())
		}
	}
}

func TestLimitLoweredBelowGranted(t *testing.T) {
	checkErr(t, []Event{
		ev(OpLimit, "", 100),
		ev(OpApply, "A", 60),
		ev(OpGrant, "A", 0),
		ev(OpLimit, "", 50),
	}, "limit-exceeded")
}

func TestApplyWhileActive(t *testing.T) {
	checkErr(t, []Event{
		ev(OpLimit, "", 100),
		ev(OpApply, "A", 10),
		ev(OpApply, "A", 20),
	}, "apply-while-active")
}

func TestGrantWithoutApply(t *testing.T) {
	checkErr(t, []Event{
		ev(OpLimit, "", 100),
		ev(OpGrant, "A", 0),
	}, "grant-without-apply")
}

func TestAlreadyGranted(t *testing.T) {
	checkErr(t, []Event{
		ev(OpLimit, "", 100),
		ev(OpApply, "A", 10),
		ev(OpGrant, "A", 0),
		ev(OpGrant, "A", 0),
	}, "already-granted")
}

func TestCancelAfterGrant(t *testing.T) {
	checkErr(t, []Event{
		ev(OpLimit, "", 100),
		ev(OpApply, "A", 10),
		ev(OpGrant, "A", 0),
		ev(OpCancel, "A", 0),
	}, "cancel-after-grant")
}

func TestFirstErrorStopsReplay(t *testing.T) {
	// Two violations; only the first is reported.
	err := checkErr(t, []Event{
		ev(OpLimit, "", 100),
		ev(OpRelease, "A", 0), // first error: release without grant
		ev(OpGrant, "B", 0),   // would also be an error
	}, "release-without-grant")
	if err.Event.Seq != 2 {
		t.Fatalf("first error at seq %d, want 2", err.Event.Seq)
	}
}

func TestParse(t *testing.T) {
	events, err := Parse(`
# a comment
LIMIT 100
APPLY T1 30
GRANT T1
RELEASE T1   # trailing comment
APPLY T2 10
CANCEL T2
`)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 6 {
		t.Fatalf("parsed %d events, want 6", len(events))
	}
	checkValid(t, events)
	if _, err := Parse("FROB T1"); err == nil {
		t.Fatal("expected parse error for unknown op")
	}
	if _, err := Parse("APPLY T1"); err == nil {
		t.Fatal("expected parse error for missing amount")
	}
}
