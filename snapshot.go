package formal

import (
	"bytes"
	"encoding/gob"
)

type snapshotAssigner struct {
	Kind  assignerKind
	Param int64
}

type snapshotWindow struct {
	Start int64
	End   int64
	Count int64
	Sum   int64
	Fired bool
}

type snapshotTimer struct {
	When  int64
	Kind  uint8
	Start int64
	End   int64
}

type operatorSnapshot struct {
	Watermark       int64
	AllowedLateness int64
	NextSeq         int64
	DroppedLate     int64
	Changes         []Change
	Assigner        snapshotAssigner
	Windows         []snapshotWindow
	Timers          []snapshotTimer
}

func init() {
	gob.Register(operatorSnapshot{})
}

// Snapshot serializes the full operator state (watermark, changelog, window
// aggregates and live timers) so a task can resume after a failure.
func (op *WindowOperator) Snapshot() ([]byte, error) {
	snap := operatorSnapshot{
		Watermark:       op.watermark,
		AllowedLateness: op.allowedLateness,
		NextSeq:         op.nextSeq,
		DroppedLate:     op.droppedLate,
		Changes:         op.Changes(),
		Assigner:        op.snapshotAssigner(),
	}
	for _, group := range op.windows {
		for _, state := range group {
			snap.Windows = append(snap.Windows, snapshotWindow{
				Start: state.window.Start,
				End:   state.window.End,
				Count: state.count,
				Sum:   state.sum,
				Fired: state.fired,
			})
		}
	}
	for _, t := range op.timers.heap {
		snap.Timers = append(snap.Timers, snapshotTimer{
			When:  t.when,
			Kind:  uint8(t.kind),
			Start: t.window.Start,
			End:   t.window.End,
		})
	}
	var buffer bytes.Buffer
	encoder := gob.NewEncoder(&buffer)
	if err := encoder.Encode(&snap); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// Restore builds an operator from a snapshot produced by Snapshot.
func Restore(data []byte) (*WindowOperator, error) {
	var snap operatorSnapshot
	if err := gob.NewDecoder(bytes.NewReader(data)).Decode(&snap); err != nil {
		return nil, err
	}
	var assigner Assigner
	switch snap.Assigner.Kind {
	case kindSession:
		assigner = NewSessionAssigner(snap.Assigner.Param)
	default:
		assigner = NewTumblingAssigner(snap.Assigner.Param)
	}
	op := NewWindowOperator(assigner, snap.AllowedLateness)
	op.watermark = snap.Watermark
	op.nextSeq = snap.NextSeq
	op.droppedLate = snap.DroppedLate
	op.changes = append([]Change(nil), snap.Changes...)
	for _, window := range snap.Windows {
		op.putWindow(&windowState{
			window: Window{Start: window.Start, End: window.End},
			count:  window.Count,
			sum:    window.Sum,
			fired:  window.Fired,
		})
	}
	for _, timerSnapshot := range snap.Timers {
		op.timers.register(
			Window{Start: timerSnapshot.Start, End: timerSnapshot.End},
			timerKind(timerSnapshot.Kind),
			timerSnapshot.When,
		)
	}
	return op, nil
}

func (op *WindowOperator) snapshotAssigner() snapshotAssigner {
	switch a := op.assigner.(type) {
	case *SessionAssigner:
		return snapshotAssigner{Kind: kindSession, Param: a.Gap}
	default:
		return snapshotAssigner{Kind: kindTumbling, Param: a.(*TumblingAssigner).Size}
	}
}
