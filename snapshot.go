package dataeng

import (
	"encoding/json"
	"fmt"
)

// snapshot 是 Assembler 状态的可序列化形式。
// 快照与事件重放可混用：从快照恢复后继续应用同一事件序列，
// 与从头重放产生的发布批次一致。
type snapshot struct {
	Watermark uint64                 `json:"watermark"`
	Txns      map[string]txnSnapshot `json:"txns"`
}

type txnSnapshot struct {
	Declared    []string                    `json:"declared,omitempty"`
	Seq         uint64                      `json:"seq,omitempty"`
	HasSeq      bool                        `json:"has_seq,omitempty"`
	Quarantined bool                        `json:"quarantined,omitempty"`
	Reason      string                      `json:"reason,omitempty"`
	Skipped     bool                        `json:"skipped,omitempty"`
	Published   bool                        `json:"published,omitempty"`
	Fragments   map[string]fragmentSnapshot `json:"fragments,omitempty"`
}

type fragmentSnapshot struct {
	Begun     bool           `json:"begun,omitempty"`
	Committed bool           `json:"committed,omitempty"`
	CommitPos uint64         `json:"commit_pos,omitempty"`
	Rows      map[uint64]Row `json:"rows,omitempty"`
}

// Snapshot 序列化当前重组状态，可用于重启后快速恢复。
func (a *Assembler) Snapshot() ([]byte, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	snap := snapshot{
		Watermark: a.watermark,
		Txns:      make(map[string]txnSnapshot, len(a.txns)),
	}
	for id, t := range a.txns {
		ts := txnSnapshot{
			Declared:    t.declared,
			Seq:         t.seq,
			HasSeq:      t.hasSeq,
			Quarantined: t.quarantined,
			Reason:      t.reason,
			Skipped:     t.skipped,
			Published:   t.published,
			Fragments:   make(map[string]fragmentSnapshot, len(t.fragments)),
		}
		for shard, frag := range t.fragments {
			rows := make(map[uint64]Row, len(frag.rows))
			for pos, row := range frag.rows {
				rows[pos] = row
			}
			ts.Fragments[shard] = fragmentSnapshot{
				Begun:     frag.begun,
				Committed: frag.committed,
				CommitPos: frag.commitPos,
				Rows:      rows,
			}
		}
		snap.Txns[id] = ts
	}
	return json.Marshal(snap)
}

// Restore 从 Snapshot 产出的数据重建一个 Assembler。
func Restore(data []byte) (*Assembler, error) {
	var snap snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, fmt.Errorf("dataeng: invalid snapshot: %w", err)
	}
	a := New()
	a.watermark = snap.Watermark
	for id, ts := range snap.Txns {
		t := &txnState{
			id:          id,
			declared:    ts.Declared,
			seq:         ts.Seq,
			hasSeq:      ts.HasSeq,
			quarantined: ts.Quarantined,
			reason:      ts.Reason,
			skipped:     ts.Skipped,
			published:   ts.Published,
			fragments:   make(map[string]*fragment, len(ts.Fragments)),
		}
		for shard, fs := range ts.Fragments {
			rows := make(map[uint64]Row, len(fs.Rows))
			for pos, row := range fs.Rows {
				rows[pos] = row
			}
			t.fragments[shard] = &fragment{
				begun:     fs.Begun,
				committed: fs.Committed,
				commitPos: fs.CommitPos,
				rows:      rows,
			}
		}
		a.txns[id] = t
		if t.hasSeq {
			if other, ok := a.seqToTxn[t.seq]; ok && other != id {
				return nil, fmt.Errorf("dataeng: invalid snapshot: seq %d shared by %q and %q", t.seq, other, id)
			}
			a.seqToTxn[t.seq] = id
		}
	}
	return a, nil
}
