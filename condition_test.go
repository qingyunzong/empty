package dataeng

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
)

// rowInterpreter is a deliberately row-at-a-time expression interpreter. It
// records every visit, serves scripted truth/value results, and can inject a
// fault for individual expression/row pairs. It is the oracle used to check
// sparse masks, short-circuiting, and error isolation.
type rowInterpreter struct {
	visits map[string][]int
	faults map[string]map[int]error
	truths map[string]map[int]Truth
	values map[string]map[int]any
}

func newRowInterpreter() *rowInterpreter {
	return &rowInterpreter{
		visits: make(map[string][]int),
		faults: make(map[string]map[int]error),
		truths: make(map[string]map[int]Truth),
		values: make(map[string]map[int]any),
	}
}

func (i *rowInterpreter) visit(name string, row int) error {
	i.visits[name] = append(i.visits[name], row)
	if rowFaults, ok := i.faults[name]; ok {
		if err, ok := rowFaults[row]; ok {
			return err
		}
	}
	return nil
}

func (i *rowInterpreter) predicate(name string) Predicate {
	return Predicate{
		Name: name,
		Eval: func(row int) (Truth, error) {
			if err := i.visit(name, row); err != nil {
				return NullTruth(), err
			}
			if truth, ok := i.truths[name][row]; ok {
				return truth, nil
			}
			return TruthOf(false), nil
		},
	}
}

func (i *rowInterpreter) value(name string) Value {
	return Value{
		Name: name,
		Eval: func(row int) (any, error) {
			if err := i.visit(name, row); err != nil {
				return nil, err
			}
			if value, ok := i.values[name][row]; ok {
				return value, nil
			}
			return nil, nil
		},
	}
}

func (i *rowInterpreter) setTruth(name string, row int, truth Truth) {
	if i.truths[name] == nil {
		i.truths[name] = make(map[int]Truth)
	}
	i.truths[name][row] = truth
}

func (i *rowInterpreter) setValue(name string, row int, value any) {
	if i.values[name] == nil {
		i.values[name] = make(map[int]any)
	}
	i.values[name][row] = value
}

func (i *rowInterpreter) fault(name string, err error, rows ...int) {
	if i.faults[name] == nil {
		i.faults[name] = make(map[int]error)
	}
	for _, row := range rows {
		i.faults[name][row] = err
	}
}

func (i *rowInterpreter) count(name string) int {
	return len(i.visits[name])
}

func accessRows(t *testing.T, result Result, branch int, kind ExpressionKind) []int {
	t.Helper()
	access, ok := result.AccessFor(branch, kind)
	if !ok {
		t.Fatalf("missing %s access for branch %d", kind, branch)
	}
	return access.Rows
}

func assertRows(t *testing.T, got, want []int) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("visited rows = %v, want %v", got, want)
	}
}

func assertResult(t *testing.T, result Result, position int, value any, null bool, branch int) {
	t.Helper()
	row := result.Rows[position]
	if row.Err != nil {
		t.Fatalf("row %d unexpectedly failed: %v", row.Row, row.Err)
	}
	if row.Value != value || row.Null != null || row.Branch != branch {
		t.Fatalf(
			"row at position %d = {value:%v null:%v branch:%d}, want {value:%v null:%v branch:%d}",
			position, row.Value, row.Null, row.Branch, value, null, branch,
		)
	}
}

func TestEvaluateSparseRowsAndOriginalOrder(t *testing.T) {
	interpreter := newRowInterpreter()
	interpreter.setTruth("p0", 42, TruthOf(true))
	interpreter.setTruth("p1", 7, TruthOf(true))
	interpreter.setValue("v0", 42, "from-b0")
	interpreter.setValue("v1", 7, "from-b1")
	interpreter.setValue("else", 1, "from-else")

	rows := []int{7, 1, 42}
	branches := []Branch{
		{Name: "b0", Predicate: interpreter.predicate("p0"), Value: interpreter.value("v0")},
		{Name: "b1", Predicate: interpreter.predicate("p1"), Value: interpreter.value("v1")},
	}
	result := Evaluate(rows, branches, interpreter.value("else"))

	if len(result.Rows) != len(rows) {
		t.Fatalf("result length = %d, want %d", len(result.Rows), len(rows))
	}
	for position, row := range rows {
		if result.Rows[position].Position != position || result.Rows[position].Row != row {
			t.Fatalf("position %d does not retain input row %d: %+v", position, row, result.Rows[position])
		}
	}
	assertResult(t, result, 0, "from-b1", false, 1)
	assertResult(t, result, 1, "from-else", false, 2)
	assertResult(t, result, 2, "from-b0", false, 0)

	assertRows(t, accessRows(t, result, 0, KindPredicate), []int{7, 1, 42})
	assertRows(t, accessRows(t, result, 0, KindValue), []int{42})
	assertRows(t, accessRows(t, result, 1, KindPredicate), []int{7, 1})
	assertRows(t, accessRows(t, result, 1, KindValue), []int{7})
	assertRows(t, accessRows(t, result, len(branches), KindElse), []int{1})

	checks := map[string][]int{
		"p0":   {7, 1, 42},
		"v0":   {42},
		"p1":   {7, 1},
		"v1":   {7},
		"else": {1},
	}
	for name, want := range checks {
		assertRows(t, interpreter.visits[name], want)
		if interpreter.count(name) != len(want) {
			t.Fatalf("visit count for %s = %d, want %d", name, interpreter.count(name), len(want))
		}
	}
}

func TestNullPredicateIsFalseAndDoesNotEvaluateValue(t *testing.T) {
	interpreter := newRowInterpreter()
	interpreter.setTruth("p0", 0, Truth{Valid: false, Value: true})
	interpreter.setTruth("p0", 1, TruthOf(true))
	interpreter.setTruth("p0", 2, TruthOf(false))
	interpreter.setTruth("p1", 0, TruthOf(true))
	interpreter.setTruth("p1", 2, TruthOf(true))
	interpreter.setValue("v0", 1, "b0")
	interpreter.setValue("v1", 0, "b1-0")
	interpreter.setValue("v1", 2, "b1-2")
	interpreter.fault("v0", errors.New("NULL predicates must not choose a value"), 0, 2)

	rows := []int{0, 1, 2}
	branches := []Branch{
		{Predicate: interpreter.predicate("p0"), Value: interpreter.value("v0")},
		{Predicate: interpreter.predicate("p1"), Value: interpreter.value("v1")},
	}
	result := Evaluate(rows, branches, Value{})

	assertResult(t, result, 0, "b1-0", false, 1)
	assertResult(t, result, 1, "b0", false, 0)
	assertResult(t, result, 2, "b1-2", false, 1)

	assertRows(t, accessRows(t, result, 0, KindPredicate), []int{0, 1, 2})
	assertRows(t, accessRows(t, result, 0, KindValue), []int{1})
	assertRows(t, accessRows(t, result, 1, KindPredicate), []int{0, 2})
	assertRows(t, accessRows(t, result, 1, KindValue), []int{0, 2})
}

func TestSelectedRowsShortCircuitLaterBranchesAndElse(t *testing.T) {
	forbidden := errors.New("unselected expression was evaluated")
	interpreter := newRowInterpreter()
	interpreter.setTruth("p0", 3, TruthOf(true))
	interpreter.setValue("v0", 3, 10)
	interpreter.setTruth("p1", 3, TruthOf(false))
	interpreter.setValue("v1", 3, 20)
	interpreter.setValue("else", 3, 30)
	interpreter.fault("p1", forbidden, 3)
	interpreter.fault("v1", forbidden, 3)
	interpreter.fault("else", forbidden, 3)

	result := Evaluate([]int{3}, []Branch{
		{Predicate: interpreter.predicate("p0"), Value: interpreter.value("v0")},
		{Predicate: interpreter.predicate("p1"), Value: interpreter.value("v1")},
	}, interpreter.value("else"))

	assertResult(t, result, 0, 10, false, 0)
	assertRows(t, accessRows(t, result, 0, KindPredicate), []int{3})
	assertRows(t, accessRows(t, result, 0, KindValue), []int{3})
	assertRows(t, accessRows(t, result, 1, KindPredicate), nil)
	assertRows(t, accessRows(t, result, 1, KindValue), nil)
	assertRows(t, accessRows(t, result, 2, KindElse), nil)
	if len(interpreter.visits["p1"]) != 0 || len(interpreter.visits["v1"]) != 0 || len(interpreter.visits["else"]) != 0 {
		t.Fatalf("later expressions were visited: %v", interpreter.visits)
	}
}

func TestErrorsFinalizeOnlyTheirRowAndBlockLaterBranches(t *testing.T) {
	predicateFault := errors.New("predicate fault")
	valueFault := errors.New("value fault")
	interpreter := newRowInterpreter()
	interpreter.setTruth("p0", 0, TruthOf(true))
	interpreter.setTruth("p0", 2, TruthOf(false))
	interpreter.setTruth("p0", 3, TruthOf(false))
	interpreter.fault("p0", predicateFault, 1)
	interpreter.fault("v0", valueFault, 0)
	interpreter.setValue("v0", 0, "never used")

	interpreter.setTruth("p1", 2, TruthOf(true))
	interpreter.setTruth("p1", 3, TruthOf(false))
	interpreter.setValue("v1", 2, "row-2")
	interpreter.setValue("else", 3, "row-3")

	rows := []int{0, 1, 2, 3}
	branches := []Branch{
		{Predicate: interpreter.predicate("p0"), Value: interpreter.value("v0")},
		{Predicate: interpreter.predicate("p1"), Value: interpreter.value("v1")},
	}
	result := Evaluate(rows, branches, interpreter.value("else"))

	if len(result.Rows) != len(rows) {
		t.Fatalf("failed rows changed result length: got %d, want %d", len(result.Rows), len(rows))
	}

	for _, failed := range []struct {
		position int
		branch   int
		stage    Stage
		cause    error
	}{
		{0, 0, StageValue, valueFault},
		{1, 0, StagePredicate, predicateFault},
	} {
		row := result.Rows[failed.position]
		if row.Err == nil {
			t.Fatalf("position %d did not fail", failed.position)
		}
		if row.Branch != failed.branch || row.Stage != failed.stage {
			t.Fatalf("position %d error stage = branch %d/%s, want branch %d/%s", failed.position, row.Branch, row.Stage, failed.branch, failed.stage)
		}
		if !errors.Is(row.Err, failed.cause) {
			t.Fatalf("position %d error = %v, want %v", failed.position, row.Err, failed.cause)
		}
		var rowError *RowError
		if !errors.As(row.Err, &rowError) {
			t.Fatalf("position %d error is not *RowError: %T", failed.position, row.Err)
		}
		if rowError.Position != failed.position || rowError.Row != rows[failed.position] {
			t.Fatalf("row error position/row = %d/%d, want %d/%d", rowError.Position, rowError.Row, failed.position, rows[failed.position])
		}
	}

	assertResult(t, result, 2, "row-2", false, 1)
	assertResult(t, result, 3, "row-3", false, 2)

	assertRows(t, accessRows(t, result, 0, KindPredicate), []int{0, 1, 2, 3})
	assertRows(t, accessRows(t, result, 0, KindValue), []int{0})
	assertRows(t, accessRows(t, result, 1, KindPredicate), []int{2, 3})
	assertRows(t, accessRows(t, result, 1, KindValue), []int{2})
	assertRows(t, accessRows(t, result, 2, KindElse), []int{3})

	if len(interpreter.visits["p0"]) != 4 || len(interpreter.visits["v0"]) != 1 {
		t.Fatalf("branch 0 visit counts = p0:%d v0:%d, want 4/1", len(interpreter.visits["p0"]), len(interpreter.visits["v0"]))
	}
	if len(interpreter.visits["p1"]) != 2 || len(interpreter.visits["v1"]) != 1 {
		t.Fatalf("failed rows were sent to branch 1: p1:%v v1:%v", interpreter.visits["p1"], interpreter.visits["v1"])
	}
}

func TestFalsePredicateDoesNotEvaluateItsValue(t *testing.T) {
	forbidden := errors.New("value for false predicate was evaluated")
	interpreter := newRowInterpreter()
	interpreter.setTruth("p0", 5, TruthOf(false))
	interpreter.fault("v0", forbidden, 5)
	interpreter.setTruth("p1", 5, TruthOf(true))
	interpreter.setValue("v1", 5, "ok")

	result := Evaluate([]int{5}, []Branch{
		{Predicate: interpreter.predicate("p0"), Value: interpreter.value("v0")},
		{Predicate: interpreter.predicate("p1"), Value: interpreter.value("v1")},
	}, Value{})

	assertResult(t, result, 0, "ok", false, 1)
	assertRows(t, accessRows(t, result, 0, KindPredicate), []int{5})
	assertRows(t, accessRows(t, result, 0, KindValue), nil)
	assertRows(t, accessRows(t, result, 1, KindPredicate), []int{5})
	assertRows(t, accessRows(t, result, 1, KindValue), []int{5})
}

func TestElseFaultsAreIsolatedPerRow(t *testing.T) {
	elseFault := errors.New("else fault")
	interpreter := newRowInterpreter()
	interpreter.setTruth("p0", 1, TruthOf(true))
	interpreter.setValue("v0", 1, "matched")
	interpreter.setValue("else", 0, "else-0")
	interpreter.setValue("else", 2, "else-2")
	interpreter.fault("else", elseFault, 0)

	result := Evaluate([]int{0, 1, 2}, []Branch{
		{Predicate: interpreter.predicate("p0"), Value: interpreter.value("v0")},
	}, interpreter.value("else"))

	if result.Rows[0].Err == nil || !errors.Is(result.Rows[0].Err, elseFault) {
		t.Fatalf("position 0 error = %v, want else fault", result.Rows[0].Err)
	}
	if result.Rows[0].Stage != StageElse || result.Rows[0].Branch != 1 {
		t.Fatalf("position 0 stage = %d/%s, want branch 1/else", result.Rows[0].Branch, result.Rows[0].Stage)
	}
	assertResult(t, result, 1, "matched", false, 0)
	assertResult(t, result, 2, "else-2", false, 1)

	assertRows(t, accessRows(t, result, 0, KindPredicate), []int{0, 1, 2})
	assertRows(t, accessRows(t, result, 0, KindValue), []int{1})
	assertRows(t, accessRows(t, result, 1, KindElse), []int{0, 2})
}

func TestMissingElseLeavesUnmatchedRowsNull(t *testing.T) {
	interpreter := newRowInterpreter()
	interpreter.setTruth("p0", 0, TruthOf(true))
	interpreter.setValue("v0", 0, "chosen")

	result := Evaluate([]int{0, 9}, []Branch{
		{Predicate: interpreter.predicate("p0"), Value: interpreter.value("v0")},
	}, Value{})

	assertResult(t, result, 0, "chosen", false, 0)
	row := result.Rows[1]
	if row.Err != nil || row.Value != nil || !row.Null || row.Branch != NoBranch {
		t.Fatalf("unmatched row without ELSE = %+v, want NULL with no branch", row)
	}
	if result.HasErrors() {
		t.Fatal("missing ELSE incorrectly produced row errors")
	}
	assertRows(t, accessRows(t, result, 0, KindPredicate), []int{0, 9})
}

func TestNilAndNullValueExpressionsAreLazy(t *testing.T) {
	interpreter := newRowInterpreter()
	interpreter.setTruth("p0", 4, TruthOf(true))
	interpreter.setTruth("p1", 6, TruthOf(true))

	result := Evaluate([]int{4, 6}, []Branch{
		{Predicate: interpreter.predicate("p0"), Value: Value{}},
		{Predicate: Predicate{}, Value: interpreter.value("v1")},
		{Predicate: interpreter.predicate("p1"), Value: Value{}},
	}, Value{})

	// Row 4 matches a branch with a nil (constant NULL) value expression.
	assertResult(t, result, 0, nil, true, 0)
	// Row 6 falls through the nil predicate (constant NULL), which keeps it
	// unresolved without recording a visit, and then matches branch 2.
	assertResult(t, result, 1, nil, true, 2)
	assertRows(t, accessRows(t, result, 0, KindPredicate), []int{4, 6})
	assertRows(t, accessRows(t, result, 0, KindValue), nil)
	assertRows(t, accessRows(t, result, 1, KindPredicate), nil)
	assertRows(t, accessRows(t, result, 1, KindValue), nil)
	assertRows(t, accessRows(t, result, 2, KindPredicate), []int{6})
	assertRows(t, accessRows(t, result, 2, KindValue), nil)
}

func TestDuplicateInputRowsRemainIndependent(t *testing.T) {
	interpreter := newRowInterpreter()
	interpreter.setTruth("p0", 5, TruthOf(true))
	interpreter.setValue("v0", 5, "same")

	result := Evaluate([]int{5, 5, 1}, []Branch{
		{Predicate: interpreter.predicate("p0"), Value: interpreter.value("v0")},
	}, interpreter.value("else"))

	assertResult(t, result, 0, "same", false, 0)
	assertResult(t, result, 1, "same", false, 0)
	assertRows(t, accessRows(t, result, 0, KindPredicate), []int{5, 5, 1})
	assertRows(t, accessRows(t, result, 0, KindValue), []int{5, 5})
	assertRows(t, accessRows(t, result, 1, KindElse), []int{1})
}

func TestEmptyRowSetStillReportsExpressionSlots(t *testing.T) {
	interpreter := newRowInterpreter()
	result := Evaluate(nil, []Branch{
		{Predicate: interpreter.predicate("p0"), Value: interpreter.value("v0")},
	}, interpreter.value("else"))

	if len(result.Rows) != 0 {
		t.Fatalf("empty row set produced %d results", len(result.Rows))
	}
	if got := len(result.Accesses); got != 3 {
		t.Fatalf("access slots = %d, want 3", got)
	}
	for _, access := range result.Accesses {
		if access.Count() != 0 {
			t.Fatalf("empty row set visited rows for %s: %v", access.Name, access.Rows)
		}
	}
}

func TestDefaultAccessNames(t *testing.T) {
	interpreter := newRowInterpreter()
	result := Evaluate([]int{2}, []Branch{
		{Name: "take", Predicate: interpreter.predicate(""), Value: interpreter.value("")},
	}, interpreter.value(""))

	want := []string{
		"branch[0].predicate(take)",
		"branch[0].value(take)",
		"branch[1].else",
	}
	got := make([]string, 0, len(result.Accesses))
	for _, access := range result.Accesses {
		got = append(got, access.Name)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("access names = %q, want %q", got, want)
	}
}

func TestValuesAndErrorsAreParallelAndSameLength(t *testing.T) {
	fault := fmt.Errorf("boom")
	interpreter := newRowInterpreter()
	interpreter.setTruth("p0", 0, TruthOf(true))
	interpreter.fault("v0", fault, 0)
	interpreter.setTruth("p0", 1, TruthOf(false))
	interpreter.setValue("else", 1, 7)

	result := Evaluate([]int{0, 1}, []Branch{
		{Predicate: interpreter.predicate("p0"), Value: interpreter.value("v0")},
	}, interpreter.value("else"))

	values := result.Values()
	errs := result.Errors()
	if len(values) != 2 || len(errs) != 2 {
		t.Fatalf("parallel output lengths = %d/%d, want 2/2", len(values), len(errs))
	}
	if values[0] != nil || !errors.Is(errs[0], fault) {
		t.Fatalf("failed row = value:%v err:%v", values[0], errs[0])
	}
	if values[1] != 7 || errs[1] != nil {
		t.Fatalf("successful row = value:%v err:%v", values[1], errs[1])
	}
}
