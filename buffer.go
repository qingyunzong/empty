package dataeng

// Marker 标识事务事件携带的提交或中止标记。
type Marker int

const (
	// MarkerNone 表示事件不携带标记。
	MarkerNone Marker = iota
	// MarkerCommit 表示事务提交。
	MarkerCommit
	// MarkerAbort 表示事务中止。
	MarkerAbort
)

// Event 是同一事务下可能乱序到达的一条事件。
type Event struct {
	TxID   string
	Seq    int
	Digest string
	Marker Marker
}

type txState struct {
	events map[int]string
	maxSeq int
	marker Marker
}

// Buffer 是可导入的事务缓冲，决定已收事件能否公开。
type Buffer struct {
	txs    map[string]*txState
	closed map[string]bool
}

// NewBuffer 返回一个空的事务缓冲。
func NewBuffer() *Buffer {
	return &Buffer{
		txs:    make(map[string]*txState),
		closed: make(map[string]bool),
	}
}

// Add 接收一条事件，返回因此可以公开的事件（按序号升序）。
// 不能公开任何事件时返回 nil。
func (b *Buffer) Add(e Event) []Event {
	if b.closed[e.TxID] {
		return nil
	}
	if e.Seq < 1 {
		b.close(e.TxID)
		return nil
	}
	tx := b.txs[e.TxID]
	if tx == nil {
		tx = &txState{events: make(map[int]string)}
		b.txs[e.TxID] = tx
	}
	if digest, ok := tx.events[e.Seq]; ok {
		if digest != e.Digest {
			b.close(e.TxID)
			return nil
		}
	} else {
		tx.events[e.Seq] = e.Digest
		if e.Seq > tx.maxSeq {
			tx.maxSeq = e.Seq
		}
	}
	if tx.marker == MarkerNone && e.Marker != MarkerNone {
		tx.marker = e.Marker
	}
	switch tx.marker {
	case MarkerAbort:
		b.close(e.TxID)
		return nil
	case MarkerCommit:
		if len(tx.events) == tx.maxSeq {
			out := make([]Event, 0, tx.maxSeq)
			for seq := 1; seq <= tx.maxSeq; seq++ {
				out = append(out, Event{TxID: e.TxID, Seq: seq, Digest: tx.events[seq]})
			}
			b.close(e.TxID)
			return out
		}
	}
	return nil
}

func (b *Buffer) close(txID string) {
	delete(b.txs, txID)
	b.closed[txID] = true
}
