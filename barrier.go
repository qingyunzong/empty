package dataeng

// Record is a unit of stream data travelling through an operator's
// input channels.
type Record struct {
	Value any
}

// Barrier marks a checkpoint boundary inside one input channel.
//
// A barrier is either a regular checkpoint barrier or a cancellation
// marker. Regular barriers come in two flavours: aligned barriers ask
// the operator to hold back post-barrier data until every channel has
// reported the checkpoint, while unaligned barriers overtake in-flight
// data so the checkpoint can complete without blocking the channels.
type Barrier struct {
	CheckpointID int64
	// Unaligned selects unaligned checkpoint behaviour for this
	// checkpoint. All barriers of one checkpoint must agree on it.
	Unaligned bool
	// Cancellation marks this barrier as a cancellation marker for
	// CheckpointID instead of a regular checkpoint barrier.
	Cancellation bool
}

// NewBarrier returns an aligned checkpoint barrier for the given
// checkpoint ID.
func NewBarrier(checkpointID int64) Barrier {
	return Barrier{CheckpointID: checkpointID}
}

// NewUnalignedBarrier returns an unaligned checkpoint barrier for the
// given checkpoint ID.
func NewUnalignedBarrier(checkpointID int64) Barrier {
	return Barrier{CheckpointID: checkpointID, Unaligned: true}
}

// NewCancellation returns a cancellation marker for the given
// checkpoint ID.
func NewCancellation(checkpointID int64) Barrier {
	return Barrier{CheckpointID: checkpointID, Cancellation: true}
}
