package dataeng

import (
	"errors"
	"testing"
)

func TestPlanNextRequiresInitialSnapshot(t *testing.T) {
	t.Parallel()

	bounds := Bounds{
		MinLSN: MustParseLSN("0000002a:0000005c:0001"),
		MaxLSN: MustParseLSN("0000002a:0000005c:0002"),
	}
	plan, err := PlanNext(State{}, bounds)
	if !errors.Is(err, ErrSnapshotRequired) {
		t.Fatalf("PlanNext() error = %v, want ErrSnapshotRequired", err)
	}
	if plan.Action != ActionSnapshot {
		t.Fatalf("Action = %s", plan.Action)
	}
	if plan.Range.FromLSN != nil || plan.Range.ToLSN != nil {
		t.Fatalf("snapshot plan must not invent a CDC range: %#v", plan.Range)
	}
}

func TestPlanNextNormalAdvance(t *testing.T) {
	t.Parallel()

	watermark := MustParseLSN("0000002a:0000005c:0002")
	bounds := Bounds{
		MinLSN: MustParseLSN("0000002a:0000005c:0001"),
		MaxLSN: MustParseLSN("0000002a:0000005c:0003"),
	}
	plan, err := PlanNext(State{Watermark: watermark}, bounds)
	if err != nil {
		t.Fatalf("PlanNext() error = %v", err)
	}
	if plan.Action != ActionQuery {
		t.Fatalf("Action = %s", plan.Action)
	}
	if got := plan.Range.FromLSN.String(); got != "0000002a:0000005c:0003" {
		t.Fatalf("FromLSN = %s", got)
	}
	if !plan.Range.ToLSN.Equal(bounds.MaxLSN) {
		t.Fatalf("ToLSN = %s", plan.Range.ToLSN)
	}
}

func TestPlanNextPartialLSNReplaysWithoutSkipping(t *testing.T) {
	t.Parallel()

	watermark := MustParseLSN("0000002a:0000005c:0002")
	position := Position{
		StartLSN:  MustParseLSN("0000002a:0000005c:0003"),
		SeqVal:    MustParseLSN("0000002a:0000005c:0005"),
		Operation: OperationInsert,
	}
	bounds := Bounds{
		MinLSN: MustParseLSN("0000002a:0000005c:0001"),
		MaxLSN: MustParseLSN("0000002a:0000005c:0004"),
	}
	plan, err := PlanNext(State{Watermark: watermark, Position: position}, bounds)
	if err != nil {
		t.Fatalf("PlanNext() error = %v", err)
	}
	if !plan.ReplayLSN {
		t.Fatal("partial LSN must replay the watermark instead of incrementing it")
	}
	if !plan.Range.FromLSN.Equal(watermark) {
		t.Fatalf("FromLSN = %s, want watermark %s", plan.Range.FromLSN, watermark)
	}
}

func TestPlanNextCleanupGapDoesNotJumpToCurrent(t *testing.T) {
	t.Parallel()

	watermark := MustParseLSN("0000002a:0000005c:0002")
	bounds := Bounds{
		MinLSN: MustParseLSN("0000002a:0000005c:0005"),
		MaxLSN: MustParseLSN("0000002a:0000005c:0009"),
	}
	plan, err := PlanNext(State{Watermark: watermark}, bounds)
	if !errors.Is(err, ErrLSNGap) {
		t.Fatalf("PlanNext() error = %v, want ErrLSNGap", err)
	}
	if !errors.Is(err, ErrSnapshotRequired) {
		t.Fatalf("PlanNext() error = %v, want ErrSnapshotRequired", err)
	}
	var gap *GapError
	if !errors.As(err, &gap) {
		t.Fatalf("PlanNext() error type = %T", err)
	}
	if !gap.Watermark.Equal(watermark) || !gap.MinLSN.Equal(bounds.MinLSN) {
		t.Fatalf("gap = %#v", gap)
	}
	if plan.Action != ActionSnapshot || plan.Gap != gap {
		t.Fatalf("plan = %#v", plan)
	}
	if plan.Range.FromLSN != nil || plan.Range.ToLSN != nil {
		t.Fatalf("gap must not skip to max_lsn: %#v", plan.Range)
	}
	if !plan.SnapshotLSN.Equal(bounds.MaxLSN) {
		t.Fatalf("SnapshotLSN = %s", plan.SnapshotLSN)
	}
}

func TestPlanNextReportsGapEvenWhenBoundsLookEmpty(t *testing.T) {
	t.Parallel()

	watermark := MustParseLSN("0000002a:0000005c:0002")
	bounds := Bounds{
		MinLSN: MustParseLSN("0000002a:0000005c:0005"),
	}
	plan, err := PlanNext(State{Watermark: watermark}, bounds)
	if !errors.Is(err, ErrLSNGap) {
		t.Fatalf("PlanNext() error = %v, want ErrLSNGap", err)
	}
	if plan.Action != ActionSnapshot {
		t.Fatalf("Action = %s", plan.Action)
	}
}

func TestPlanNextNoopAtMaximum(t *testing.T) {
	t.Parallel()

	max := MustParseLSN("0000002a:0000005c:0009")
	bounds := Bounds{MinLSN: MustParseLSN("0000002a:0000005c:0001"), MaxLSN: max}
	plan, err := PlanNext(State{Watermark: max}, bounds)
	if err != nil {
		t.Fatalf("PlanNext() error = %v", err)
	}
	if plan.Action != ActionNoop {
		t.Fatalf("Action = %s", plan.Action)
	}
}

func TestQueryRangeAndMapping(t *testing.T) {
	t.Parallel()

	r := QueryRange{
		FromLSN: MustParseLSN("0000002a:0000005c:0001"),
		ToLSN:   MustParseLSN("0000002a:0000005c:0003"),
	}
	if err := r.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if !r.Contains(MustParseLSN("0000002a:0000005c:0002")) {
		t.Fatal("Contains() = false")
	}

	mapped, err := MapRange(r, IncrementLSN, DecrementLSN)
	if err != nil {
		t.Fatalf("MapRange() error = %v", err)
	}
	if got := mapped.FromLSN.String(); got != "0000002a:0000005c:0002" {
		t.Fatalf("mapped FromLSN = %s", got)
	}

	if err := (QueryRange{FromLSN: r.ToLSN, ToLSN: r.FromLSN}).Validate(); !errors.Is(err, ErrInvalidLSN) {
		t.Fatalf("inverted range error = %v", err)
	}
}
