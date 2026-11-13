package dataeng

import (
	"reflect"
	"testing"
)

type sumOperator struct {
	sum     int
	emitted []int
}

func (op *sumOperator) apply(res Result) {
	for _, r := range res.Emit {
		op.sum += r.Value.(int)
		op.emitted = append(op.emitted, op.sum)
	}
}

func TestUnalignedRecoveryMatchesFaultFree(t *testing.T) {
	type event struct {
		channel int
		record  *Record
		barrier *Barrier
	}
	r := func(ch, v int) event { return event{channel: ch, record: &Record{Value: v}} }
	b := func(ch int, bar Barrier) event { return event{channel: ch, barrier: &bar} }

	inputs := []event{
		r(0, 10),
		r(1, 20),
		b(0, NewUnalignedBarrier(1)),
		r(0, 1),
		r(1, 2),
		b(1, NewUnalignedBarrier(1)),
		r(0, 100),
		r(1, 200),
	}

	aligner, err := NewBarrierAligner(2)
	if err != nil {
		t.Fatal(err)
	}
	faultFree := &sumOperator{}
	var stateAtSnapshot int
	var snapshot *Snapshot
	var committedPrefix []int
	for _, ev := range inputs {
		var res Result
		var err error
		if ev.record != nil {
			res, err = aligner.ProcessRecord(ev.channel, *ev.record)
		} else {
			res, err = aligner.ProcessBarrier(ev.channel, *ev.barrier)
			if _, pending := aligner.Pending(); pending && snapshot == nil && stateAtSnapshot == 0 {
				stateAtSnapshot = faultFree.sum
				committedPrefix = append([]int(nil), faultFree.emitted...)
			}
		}
		if err != nil {
			t.Fatal(err)
		}
		faultFree.apply(res)
		if res.Snapshot != nil {
			snapshot = res.Snapshot
		}
	}
	if snapshot == nil {
		t.Fatal("checkpoint never completed")
	}
	want := []int{10, 30, 31, 33, 133, 333}
	if !reflect.DeepEqual(faultFree.emitted, want) {
		t.Fatalf("fault-free output = %v, want %v", faultFree.emitted, want)
	}

	recovered := &sumOperator{sum: stateAtSnapshot, emitted: append([]int(nil), committedPrefix...)}
	for _, rec := range snapshot.Inflight {
		recovered.sum += rec.Value.(int)
		recovered.emitted = append(recovered.emitted, recovered.sum)
	}
	resumed, err := NewBarrierAligner(2)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range inputs[6:] {
		var res Result
		var err error
		if ev.record != nil {
			res, err = resumed.ProcessRecord(ev.channel, *ev.record)
		} else {
			res, err = resumed.ProcessBarrier(ev.channel, *ev.barrier)
		}
		if err != nil {
			t.Fatal(err)
		}
		recovered.apply(res)
	}

	if !reflect.DeepEqual(recovered.emitted, faultFree.emitted) {
		t.Fatalf("recovered output = %v, want fault-free %v", recovered.emitted, faultFree.emitted)
	}
}

func TestAlignedRecoveryMatchesFaultFree(t *testing.T) {
	// Fault-free run through one aligned checkpoint. Outputs produced
	// before the checkpoint completes are committed; the records the
	// aligner releases afterwards are tentative and would be rolled
	// back together with downstream state on a crash.
	aligner, err := NewBarrierAligner(2)
	if err != nil {
		t.Fatal(err)
	}
	op := &sumOperator{}
	var committed []int
	var released []Record
	feed := func(res Result, err error) {
		if err != nil {
			t.Fatal(err)
		}
		op.apply(res)
		if res.Snapshot != nil {
			committed = append([]int(nil), op.emitted[:len(op.emitted)-len(res.Emit)]...)
			released = res.Emit
		}
	}

	feed(aligner.ProcessRecord(0, rec(1)))
	feed(aligner.ProcessBarrier(0, NewBarrier(1)))
	feed(aligner.ProcessRecord(0, rec(2))) // held back on blocked channel
	feed(aligner.ProcessRecord(1, rec(10)))
	feed(aligner.ProcessRecord(0, rec(3))) // held back on blocked channel
	feed(aligner.ProcessBarrier(1, NewBarrier(1)))

	stateAtSnapshot := 11 // operator sum when checkpoint 1 completed
	faultFree := op.emitted
	if want := []int{1, 11, 13, 16}; !reflect.DeepEqual(faultFree, want) {
		t.Fatalf("fault-free output = %v, want %v", faultFree, want)
	}
	if got := values(released); !reflect.DeepEqual(got, []int{2, 3}) {
		t.Fatalf("released records = %v, want arrival order [2 3]", got)
	}
	if want := []int{1, 11}; !reflect.DeepEqual(committed, want) {
		t.Fatalf("committed prefix = %v, want %v", committed, want)
	}

	// Crash and recover: restore the operator to the snapshot state,
	// drop the tentative outputs, and replay the released records in
	// the order the aligner emitted them, exactly as resent upstream
	// channels would deliver them.
	recovered := &sumOperator{sum: stateAtSnapshot, emitted: append([]int(nil), committed...)}
	for _, r := range released {
		recovered.sum += r.Value.(int)
		recovered.emitted = append(recovered.emitted, recovered.sum)
	}

	if !reflect.DeepEqual(recovered.emitted, faultFree) {
		t.Fatalf("recovered output = %v, want fault-free %v", recovered.emitted, faultFree)
	}
}
