package savepoint_test

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"

	"example.org/dlks/formal/q10036/savepoint"
)

// Independent naive oracle.
//
// This state machine is deliberately written with a flat table rather than the
// linked layer frames used by the package under test. It only consumes the
// exported Event/Record inputs and independently computes the expected stack,
// ownership, undo order and error class. No value expected in the tests is
// produced by the savepoint package itself.

type oracleError string

const (
	errNone        oracleError = ""
	errDuplicate   oracleError = "duplicate"
	errNotFound    oracleError = "not-found"
	errEmpty       oracleError = "empty"
	errNoActive    oracleError = "no-active"
	errUnknownKind oracleError = "unknown-event"
)

// oracleFrame is one flat table row: the layer name and its owned records in
// registration order.
type oracleFrame struct {
	name    string
	records []savepoint.Record
}

type oracleStep struct {
	seq    int
	stack  []string
	frames []oracleFrame
	owners map[savepoint.Record]string
	undone []savepoint.Record
	err    oracleError
}

type oracle struct {
	frames []oracleFrame
	owners map[savepoint.Record]string
}

func newOracle() *oracle {
	return &oracle{owners: map[savepoint.Record]string{}}
}

func (o *oracle) frameIndex(name string) int {
	for i := range o.frames {
		if o.frames[i].name == name {
			return i
		}
	}
	return -1
}

func (o *oracle) establish(name string) oracleError {
	if o.frameIndex(name) >= 0 {
		return errDuplicate
	}
	o.frames = append(o.frames, oracleFrame{name: name})
	return errNone
}

func (o *oracle) register(rec savepoint.Record) oracleError {
	if len(o.frames) == 0 {
		return errNoActive
	}
	head := &o.frames[len(o.frames)-1]
	head.records = append(head.records, rec)
	o.owners[rec] = head.name
	return errNone
}

func (o *oracle) rollback(name string) ([]savepoint.Record, oracleError) {
	if len(o.frames) == 0 {
		return nil, errEmpty
	}
	target := o.frameIndex(name)
	if target < 0 {
		return nil, errNotFound
	}
	var undone []savepoint.Record
	for len(o.frames) > target+1 {
		top := o.frames[len(o.frames)-1]
		for i := len(top.records) - 1; i >= 0; i-- {
			rec := top.records[i]
			undone = append(undone, rec)
			delete(o.owners, rec)
		}
		o.frames = o.frames[:len(o.frames)-1]
	}
	return undone, errNone
}

func (o *oracle) release(name string) oracleError {
	if len(o.frames) == 0 {
		return errEmpty
	}
	target := o.frameIndex(name)
	if target < 0 {
		return errNotFound
	}
	frame := o.frames[target]
	if target == 0 {
		for _, rec := range frame.records {
			o.owners[rec] = "" // engine/root ownership
		}
	} else {
		parent := &o.frames[target-1]
		for _, rec := range frame.records {
			parent.records = append(parent.records, rec)
			o.owners[rec] = parent.name
		}
	}
	o.frames = append(o.frames[:target], o.frames[target+1:]...)
	return errNone
}

func (o *oracle) apply(event savepoint.Event) oracleStep {
	step := oracleStep{seq: event.Seq}
	switch event.Kind {
	case savepoint.KindEstablish:
		step.err = o.establish(event.Name)
	case savepoint.KindRegister:
		step.err = o.register(event.Record)
	case savepoint.KindRollback:
		step.undone, step.err = o.rollback(event.Name)
	case savepoint.KindRelease:
		step.err = o.release(event.Name)
	default:
		step.err = errUnknownKind
	}
	o.snapshot(&step)
	return step
}

func (o *oracle) snapshot(step *oracleStep) {
	step.stack = make([]string, len(o.frames))
	step.frames = make([]oracleFrame, len(o.frames))
	for i, frame := range o.frames {
		step.stack[i] = frame.name
		records := make([]savepoint.Record, len(frame.records))
		copy(records, frame.records)
		step.frames[i] = oracleFrame{name: frame.name, records: records}
	}
	step.owners = make(map[savepoint.Record]string, len(o.owners))
	for rec, name := range o.owners {
		step.owners[rec] = name
	}
}

func (o *oracle) deepCopy() *oracle {
	clone := newOracle()
	clone.frames = make([]oracleFrame, len(o.frames))
	for i, frame := range o.frames {
		records := make([]savepoint.Record, len(frame.records))
		copy(records, frame.records)
		clone.frames[i] = oracleFrame{name: frame.name, records: records}
	}
	for rec, owner := range o.owners {
		clone.owners[rec] = owner
	}
	return clone
}

// key canonicalizes the full oracle state for reachable-state deduplication.
func (o *oracle) key() string {
	var builder strings.Builder
	for _, frame := range o.frames {
		builder.WriteString(frame.name)
		builder.WriteByte('|')
		builder.WriteString(strings.Join(recordIDs(frame.records), ","))
		builder.WriteByte(';')
	}
	builder.WriteByte('#')
	type pair struct {
		rec   savepoint.Record
		owner string
	}
	pairs := make([]pair, 0, len(o.owners))
	for rec, owner := range o.owners {
		pairs = append(pairs, pair{rec: rec, owner: owner})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].rec.ID != pairs[j].rec.ID {
			return pairs[i].rec.ID < pairs[j].rec.ID
		}
		return pairs[i].rec.Kind < pairs[j].rec.Kind
	})
	for _, pair := range pairs {
		fmt.Fprintf(&builder, "%s/%d=%s;", pair.rec.ID, pair.rec.Kind, pair.owner)
	}
	return builder.String()
}

func recordIDs(records []savepoint.Record) []string {
	ids := make([]string, len(records))
	for i, rec := range records {
		ids[i] = fmt.Sprintf("%s:%d", rec.ID, rec.Kind)
	}
	return ids
}

func errorClass(err error) oracleError {
	switch {
	case err == nil:
		return errNone
	case errors.Is(err, savepoint.ErrDuplicateSavepoint):
		return errDuplicate
	case errors.Is(err, savepoint.ErrEmptyStack):
		return errEmpty
	case errors.Is(err, savepoint.ErrSavepointNotFound):
		return errNotFound
	case errors.Is(err, savepoint.ErrNoActiveSavepoint):
		return errNoActive
	case errors.Is(err, savepoint.ErrUnknownEvent):
		return errUnknownKind
	default:
		return oracleError("unmapped:" + err.Error())
	}
}

func sameRecords(a, b []savepoint.Record) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	return reflectDeepEqual(a, b)
}

func assertStep(t *testing.T, event savepoint.Event, got savepoint.StepResult, want oracleStep) {
	t.Helper()
	if got.Seq != want.seq {
		t.Fatalf("seq %d: got seq %d, want %d", event.Seq, got.Seq, want.seq)
	}
	if errorClass(got.Err) != want.err {
		t.Fatalf("seq %d (%+v): got error class %q (%v), want %q",
			event.Seq, event, errorClass(got.Err), got.Err, want.err)
	}
	if !reflectDeepEqual(got.Stack, want.stack) {
		t.Fatalf("seq %d (%+v): got stack %v, want %v", event.Seq, event, got.Stack, want.stack)
	}
	if !reflectDeepEqual(got.Owners, want.owners) {
		t.Fatalf("seq %d (%+v): got owners %v, want %v", event.Seq, event, got.Owners, want.owners)
	}
	if !sameRecords(got.Undone, want.undone) {
		t.Fatalf("seq %d (%+v): got undone %v, want %v", event.Seq, event, got.Undone, want.undone)
	}
}
