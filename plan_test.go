package dataeng

import (
	"errors"
	"testing"
)

func ref(table, row, field string, target *RowRef, nullable bool) Reference {
	return Reference{
		Source:   RowRef{TableID: table, RowID: row},
		FieldID:  field,
		Target:   target,
		Nullable: nullable,
	}
}

func ptr(r RowRef) *RowRef { return &r }

func TestValidationErrors(t *testing.T) {
	rows := []RowRef{
		{TableID: "t1", RowID: "r1"},
		{TableID: "t1", RowID: "r2"},
	}

	t.Run("duplicate primary key", func(t *testing.T) {
		dup := append([]RowRef(nil), rows...)
		dup = append(dup, RowRef{TableID: "t1", RowID: "r1"})
		if _, err := BuildPlan(dup, nil); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("want ErrInvalidRequest, got %v", err)
		}
	})

	t.Run("duplicate foreign key cell", func(t *testing.T) {
		refs := []Reference{
			ref("t1", "r1", "f", ptr(rows[1]), true),
			ref("t1", "r1", "f", ptr(rows[1]), true),
		}
		if _, err := BuildPlan(rows, refs); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("want ErrInvalidRequest, got %v", err)
		}
	})

	t.Run("unresolved target", func(t *testing.T) {
		refs := []Reference{
			ref("t1", "r1", "f", ptr(RowRef{TableID: "t1", RowID: "ghost"}), true),
		}
		if _, err := BuildPlan(rows, refs); !errors.Is(err, ErrUnresolvedReference) {
			t.Fatalf("want ErrUnresolvedReference, got %v", err)
		}
	})

	t.Run("non-nullable null target", func(t *testing.T) {
		refs := []Reference{ref("t1", "r1", "f", nil, false)}
		if _, err := BuildPlan(rows, refs); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("want ErrInvalidRequest, got %v", err)
		}
	})

	t.Run("too many deferrable edges", func(t *testing.T) {
		refs := make([]Reference, 0, MaxDeferrableEdges+1)
		for i := 0; i <= MaxDeferrableEdges; i++ {
			refs = append(refs, ref("t1", "r1",
				"f"+string(rune('a'+i/10))+string(rune('a'+i%10)),
				ptr(rows[0]), true))
		}
		if _, err := BuildPlan(rows, refs); !errors.Is(err, ErrTooManyDeferrableEdges) {
			t.Fatalf("want ErrTooManyDeferrableEdges, got %v", err)
		}
	})
}

func TestNonDeferrableCycle(t *testing.T) {
	rows := []RowRef{
		{TableID: "t1", RowID: "r1"},
		{TableID: "t1", RowID: "r2"},
	}
	refs := []Reference{
		ref("t1", "r1", "f", ptr(rows[1]), false),
		ref("t1", "r2", "g", ptr(rows[0]), false),
	}
	if _, err := BuildPlan(rows, refs); !errors.Is(err, ErrNonDeferrableCycle) {
		t.Fatalf("want ErrNonDeferrableCycle, got %v", err)
	}
}

func TestSelfLoop(t *testing.T) {
	row := RowRef{TableID: "t1", RowID: "r1"}

	t.Run("nullable self loop is deferred", func(t *testing.T) {
		refs := []Reference{ref("t1", "r1", "f", ptr(row), true)}
		plan, err := BuildPlan([]RowRef{row}, refs)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(plan.DeferredFields) != 1 || plan.DeferredFields[0].FieldID != "f" {
			t.Fatalf("want single deferred field f, got %+v", plan.DeferredFields)
		}
		if len(plan.Backfills) != 1 || plan.Backfills[0].Target != row {
			t.Fatalf("want one backfill targeting r1, got %+v", plan.Backfills)
		}
		if len(plan.LoadOrder) != 1 || plan.LoadOrder[0] != row {
			t.Fatalf("want load order [r1], got %+v", plan.LoadOrder)
		}
	})

	t.Run("non-nullable self loop cannot be deferred", func(t *testing.T) {
		refs := []Reference{ref("t1", "r1", "f", ptr(row), false)}
		if _, err := BuildPlan([]RowRef{row}, refs); !errors.Is(err, ErrNonDeferrableCycle) {
			t.Fatalf("want ErrNonDeferrableCycle, got %v", err)
		}
	})
}

func TestTwoRowCycleTieBreak(t *testing.T) {
	r1 := RowRef{TableID: "t1", RowID: "r1"}
	r2 := RowRef{TableID: "t1", RowID: "r2"}
	rows := []RowRef{r1, r2}
	refs := []Reference{
		ref("t1", "r1", "f", ptr(r2), true),
		ref("t1", "r2", "g", ptr(r1), true),
	}
	plan, err := BuildPlan(rows, refs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(plan.DeferredFields) != 1 {
		t.Fatalf("want exactly one deferred field, got %d", len(plan.DeferredFields))
	}
	// 并列单字段方案中，(t1,r1,f) 的字节序列小于 (t1,r2,g)。
	got := plan.DeferredFields[0]
	if got.Source != r1 || got.FieldID != "f" {
		t.Fatalf("want deferred (t1,r1,f), got (%s,%s,%s)",
			got.Source.TableID, got.Source.RowID, got.FieldID)
	}
	// r1 的外键被置 null 后，保留边 r2 -> r1 表示 r2 依赖 r1，因此 r1 先装载。
	wantOrder := []RowRef{r1, r2}
	assertRowSequence(t, plan.LoadOrder, wantOrder)
	if len(plan.Backfills) != 1 || plan.Backfills[0].Source != r1 ||
		plan.Backfills[0].FieldID != "f" || plan.Backfills[0].Target != r2 {
		t.Fatalf("unexpected backfills: %+v", plan.Backfills)
	}
}

func TestMixedNullableAndFixedCycle(t *testing.T) {
	r1 := RowRef{TableID: "t1", RowID: "r1"}
	r2 := RowRef{TableID: "t1", RowID: "r2"}
	r3 := RowRef{TableID: "t1", RowID: "r3"}
	rows := []RowRef{r1, r2, r3}
	refs := []Reference{
		ref("t1", "r1", "fixed", ptr(r2), false),
		ref("t1", "r2", "c0", ptr(r3), true),
		ref("t1", "r3", "c1", ptr(r1), true),
	}
	plan, err := BuildPlan(rows, refs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(plan.DeferredFields) != 1 {
		t.Fatalf("want one deferred field, got %d", len(plan.DeferredFields))
	}
	if got := plan.DeferredFields[0]; got.Source != r2 || got.FieldID != "c0" {
		t.Fatalf("want deferred (t1,r2,c0), got (%s,%s,%s)",
			got.Source.TableID, got.Source.RowID, got.FieldID)
	}
	assertPlanInvariants(t, rows, refs, plan)
}

func TestTopoByteOrder(t *testing.T) {
	rows := []RowRef{
		{TableID: "B", RowID: "2"},
		{TableID: "A", RowID: "x"},
		{TableID: "A", RowID: "a"},
		{TableID: "B", RowID: "1"},
	}
	plan, err := BuildPlan(rows, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []RowRef{
		{TableID: "A", RowID: "a"},
		{TableID: "A", RowID: "x"},
		{TableID: "B", RowID: "1"},
		{TableID: "B", RowID: "2"},
	}
	assertRowSequence(t, plan.LoadOrder, want)
}

func TestNullReferenceCreatesNoEdge(t *testing.T) {
	r1 := RowRef{TableID: "t1", RowID: "r1"}
	r2 := RowRef{TableID: "t1", RowID: "r2"}
	refs := []Reference{
		ref("t1", "r1", "nullableNull", nil, true),
		ref("t1", "r2", "fk", ptr(r1), false),
	}
	plan, err := BuildPlan([]RowRef{r1, r2}, refs)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(plan.DeferredFields) != 0 || len(plan.Backfills) != 0 {
		t.Fatalf("null reference must not create edges, got %+v / %+v",
			plan.DeferredFields, plan.Backfills)
	}
	// r2 的非空外键指向 r1，因此 r1 必须先装载；空值外键不参与排序约束。
	assertRowSequence(t, plan.LoadOrder, []RowRef{r1, r2})
}

func TestEmptyInput(t *testing.T) {
	plan, err := BuildPlan(nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(plan.LoadOrder) != 0 || len(plan.Backfills) != 0 {
		t.Fatalf("want empty plan, got %+v", plan)
	}
}

func assertRowSequence(t *testing.T, got, want []RowRef) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("sequence length mismatch: got=%v want=%v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("position %d mismatch: got=%v want=%v", i, got, want)
		}
	}
}

// assertPlanInvariants 校验装载计划满足：顺序覆盖全部行、每条非延迟边的目标
// 先于源行装载、补写与延迟字段一一对应且目标已在顺序中。
func assertPlanInvariants(t *testing.T, rows []RowRef, refs []Reference, plan *Plan) {
	t.Helper()
	if len(plan.LoadOrder) != len(rows) {
		t.Fatalf("load order covers %d rows, want %d", len(plan.LoadOrder), len(rows))
	}
	pos := make(map[RowRef]int, len(rows))
	for i, r := range plan.LoadOrder {
		if _, dup := pos[r]; dup {
			t.Fatalf("row repeated in load order: %v", r)
		}
		pos[r] = i
	}
	type cellKey struct {
		source  RowRef
		fieldID string
	}
	deferred := make(map[cellKey]bool, len(plan.DeferredFields))
	for _, d := range plan.DeferredFields {
		deferred[cellKey{source: d.Source, fieldID: d.FieldID}] = true
	}
	for _, r := range refs {
		if r.Target == nil {
			continue
		}
		if deferred[cellKey{source: r.Source, fieldID: r.FieldID}] {
			continue
		}
		if pos[*r.Target] >= pos[r.Source] {
			t.Fatalf("edge %v -> %v violates load order", r.Source, *r.Target)
		}
	}
	if len(plan.Backfills) != len(plan.DeferredFields) {
		t.Fatalf("backfills=%d deferred=%d", len(plan.Backfills), len(plan.DeferredFields))
	}
	for i, b := range plan.Backfills {
		d := plan.DeferredFields[i]
		if b.Source != d.Source || b.FieldID != d.FieldID || b.Target != *d.Target {
			t.Fatalf("backfill %+v does not match deferred %+v", b, d)
		}
		if _, ok := pos[b.Target]; !ok {
			t.Fatalf("backfill target not in load order: %v", b.Target)
		}
	}
}
