package filetrace

// Snapshot captures the complete file state at a persistence point.
type Snapshot struct {
	PersistSeq int    // index of the persistence point
	Data       []byte // volatile contents
	Durable    []byte // persisted bytes
	Off        int64  // file offset
}

// Snapshot saves the current file state, tagged with persistence index seq.
func (f *MemFile) Snapshot(seq int) Snapshot {
	return Snapshot{
		PersistSeq: seq,
		Data:       f.Data(),
		Durable:    f.Durable(),
		Off:        f.off,
	}
}

// Restore replaces the file state with a previously saved snapshot.
func (f *MemFile) Restore(s Snapshot) {
	f.data = append([]byte(nil), s.Data...)
	f.durable = append([]byte(nil), s.Durable...)
	f.off = s.Off
	f.closed = false
}
