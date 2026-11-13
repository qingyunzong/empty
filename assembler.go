package dataeng

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

// 隔离原因。
const (
	ReasonRowConflict       = "row conflict at same position"
	ReasonShardSetConflict  = "conflicting declared shard sets"
	ReasonGlobalSeqConflict = "conflicting global commit sequence"
	ReasonUndeclaredShard   = "event from undeclared shard"
	ReasonSeqReassigned     = "global commit sequence already assigned to another transaction"
)

// ErrInvalidEvent 表示事件本身缺少必要字段，未被应用。
var ErrInvalidEvent = errors.New("dataeng: invalid event")

// fragment 是事务在单个分片上的片段状态。
type fragment struct {
	begun     bool
	committed bool
	commitPos uint64
	rows      map[uint64]Row // pos -> row
}

// txnState 是一个事务的重组状态。
type txnState struct {
	id          string
	declared    []string // 排序后的声明分片集合，nil 表示尚未声明
	fragments   map[string]*fragment
	seq         uint64
	hasSeq      bool
	quarantined bool
	reason      string
	skipped     bool // 被 Skip 显式跳过：允许水位越过但不发布
	published   bool
}

func (t *txnState) declaredKnown() bool { return t.declared != nil }

func (t *txnState) isDeclared(shard string) bool {
	i := sort.SearchStrings(t.declared, shard)
	return i < len(t.declared) && t.declared[i] == shard
}

// complete 当且仅当已声明分片集合、已取得全局提交序，
// 且每个声明分片都已收到 Commit。
func (t *txnState) complete() bool {
	if t.quarantined || !t.declaredKnown() || !t.hasSeq || len(t.declared) == 0 {
		return false
	}
	for _, shard := range t.declared {
		frag := t.fragments[shard]
		if frag == nil || !frag.committed {
			return false
		}
	}
	return true
}

// Assembler 将多分片的 begin/row/commit 事件重组为按全局提交序
// 发布的事务批次。它可安全地被多个 goroutine 并发使用。
//
// 语义：
//   - 事务只有在所有声明分片都提交后才可见（被发布）。
//   - 同一事务的重复片段按 (分片, 位置) 去重；同位置内容冲突即隔离整个事务。
//   - 水位仅越过已知完整（或被显式跳过）的事务；被隔离的事务会挡住水位，
//     需运维确认后调用 Skip 放行。
//   - 对同一输入事件序列，Apply 返回的批次序列确定不变，重启重放结果一致。
type Assembler struct {
	mu        sync.Mutex
	txns      map[string]*txnState
	seqToTxn  map[uint64]string
	watermark uint64
}

// New 返回一个空的 Assembler。
func New() *Assembler {
	return &Assembler{
		txns:     make(map[string]*txnState),
		seqToTxn: make(map[uint64]string),
	}
}

// Watermark 返回当前水位：不超过它的全局提交序都已是已知完整事务。
func (a *Assembler) Watermark() uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.watermark
}

// Quarantined 返回当前被隔离事务及其原因的快照。
func (a *Assembler) Quarantined() map[string]string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make(map[string]string)
	for id, t := range a.txns {
		if t.quarantined && !t.skipped {
			out[id] = t.reason
		}
	}
	return out
}

// Apply 应用一条事件。若该事件使水位推进，返回包含本次越过事务的
// 批次（按 GlobalSeq 升序）；否则返回 nil。
// 被隔离事务的后续事件被忽略；字段缺失的事件返回 ErrInvalidEvent。
func (a *Assembler) Apply(ev Event) (*Batch, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if ev.Shard == "" || ev.TxnID == "" || ev.Kind < EventBegin || ev.Kind > EventCommit {
		return nil, fmt.Errorf("%w: shard, txn id and valid kind are required", ErrInvalidEvent)
	}
	if ev.Kind == EventCommit && ev.GlobalSeq == 0 {
		return nil, fmt.Errorf("%w: commit requires a positive global sequence", ErrInvalidEvent)
	}

	t := a.txns[ev.TxnID]
	if t == nil {
		t = &txnState{id: ev.TxnID, fragments: make(map[string]*fragment)}
		a.txns[ev.TxnID] = t
	}
	if t.quarantined {
		// 隔离事务不再重组，但仍记录其 Commit 携带的全局序，
		// 以便 Skip 后水位可以越过它。
		if ev.Kind == EventCommit && t.seq == 0 {
			t.seq = ev.GlobalSeq
		}
		return nil, nil
	}

	switch ev.Kind {
	case EventBegin:
		a.applyBegin(t, ev)
	case EventRow:
		a.applyRow(t, ev)
	case EventCommit:
		a.applyCommit(t, ev)
	}

	if t.quarantined {
		return nil, nil
	}
	return a.advanceLocked(), nil
}

func (a *Assembler) fragmentFor(t *txnState, shard string) *fragment {
	frag := t.fragments[shard]
	if frag == nil {
		frag = &fragment{rows: make(map[uint64]Row)}
		t.fragments[shard] = frag
	}
	return frag
}

// checkShardDeclared 在声明集合已知时校验事件来源分片。
func (a *Assembler) checkShardDeclared(t *txnState, shard string) bool {
	if t.declaredKnown() && !t.isDeclared(shard) {
		a.quarantine(t, ReasonUndeclaredShard+": "+shard)
		return false
	}
	return true
}

func (a *Assembler) applyBegin(t *txnState, ev Event) {
	if !a.checkShardDeclared(t, ev.Shard) {
		return
	}
	if len(ev.Shards) > 0 && !a.declareShards(t, ev.Shards) {
		return
	}
	a.fragmentFor(t, ev.Shard).begun = true
}

func (a *Assembler) applyRow(t *txnState, ev Event) {
	if !a.checkShardDeclared(t, ev.Shard) {
		return
	}
	frag := a.fragmentFor(t, ev.Shard)
	if prev, ok := frag.rows[ev.Pos]; ok {
		if !prev.equal(ev.Row) {
			a.quarantine(t, fmt.Sprintf("%s: shard %s pos %d", ReasonRowConflict, ev.Shard, ev.Pos))
		}
		return // 同位置同内容：重放重复片段，去重忽略
	}
	frag.rows[ev.Pos] = ev.Row
}

func (a *Assembler) applyCommit(t *txnState, ev Event) {
	if !a.checkShardDeclared(t, ev.Shard) {
		return
	}
	if len(ev.Shards) > 0 && !a.declareShards(t, ev.Shards) {
		return
	}
	frag := a.fragmentFor(t, ev.Shard)
	if frag.committed {
		if frag.commitPos == ev.Pos {
			return // 重复提交，去重忽略
		}
		// 同分片重复 Commit 位置不同但序号一致时仍视为重放。
		if t.hasSeq && t.seq == ev.GlobalSeq {
			return
		}
		a.quarantine(t, fmt.Sprintf("%s: shard %s", ReasonGlobalSeqConflict, ev.Shard))
		return
	}
	if t.hasSeq && t.seq != ev.GlobalSeq {
		a.quarantine(t, fmt.Sprintf("%s: shard %s seq %d != %d", ReasonGlobalSeqConflict, ev.Shard, ev.GlobalSeq, t.seq))
		return
	}
	if !t.hasSeq {
		if other, ok := a.seqToTxn[ev.GlobalSeq]; ok && other != t.id {
			a.quarantine(t, fmt.Sprintf("%s: seq %d held by %s", ReasonSeqReassigned, ev.GlobalSeq, other))
			return
		}
		t.seq = ev.GlobalSeq
		t.hasSeq = true
		a.seqToTxn[ev.GlobalSeq] = t.id
	}
	frag.committed = true
	frag.commitPos = ev.Pos
}

// declareShards 记录或校验声明分片集合，返回是否一致。
func (a *Assembler) declareShards(t *txnState, shards []string) bool {
	sorted := slicesOfSortedUnique(shards)
	if !t.declaredKnown() {
		t.declared = sorted
		// 声明到达前可能已收到其他分片的事件，回溯校验。
		for shard := range t.fragments {
			if !t.isDeclared(shard) {
				a.quarantine(t, ReasonUndeclaredShard+": "+shard)
				return false
			}
		}
		return true
	}
	if !equalStrings(t.declared, sorted) {
		a.quarantine(t, ReasonShardSetConflict)
		return false
	}
	return true
}

func (a *Assembler) quarantine(t *txnState, reason string) {
	t.quarantined = true
	t.reason = reason
	// 释放其占用的全局序号，避免误导调用方；该序号仍挡住水位，
	// 因为被隔离事务不是已知完整事务。
	if t.hasSeq {
		delete(a.seqToTxn, t.seq)
		t.hasSeq = false
	}
}

// advanceLocked 尽可能推进水位，并把本次越过的完整事务组成一个批次。
// 全局提交序按稠密整数处理：水位从当前值起逐个越过已知完整事务，
// 遇到未知序号、未完成事务或被显式跳过的事务时停止（跳过项允许越过）。
func (a *Assembler) advanceLocked() *Batch {
	var batch *Batch
	for {
		next := a.watermark + 1
		id, ok := a.seqToTxn[next]
		if !ok {
			break
		}
		t := a.txns[id]
		if t.skipped {
			a.watermark = next
			continue
		}
		if !t.complete() {
			break
		}
		t.published = true
		a.watermark = next
		if batch == nil {
			batch = &Batch{}
		}
		batch.Txns = append(batch.Txns, publishTxn(t))
	}
	if batch != nil {
		batch.Watermark = a.watermark
	}
	return batch
}

func publishTxn(t *txnState) PublishedTxn {
	shards := make([]string, 0, len(t.fragments))
	for shard := range t.fragments {
		shards = append(shards, shard)
	}
	sort.Strings(shards)
	var rows []PublishedRow
	for _, shard := range shards {
		frag := t.fragments[shard]
		positions := make([]uint64, 0, len(frag.rows))
		for pos := range frag.rows {
			positions = append(positions, pos)
		}
		sort.Slice(positions, func(i, j int) bool { return positions[i] < positions[j] })
		for _, pos := range positions {
			row := frag.rows[pos]
			rows = append(rows, PublishedRow{
				Shard: shard,
				Pos:   pos,
				Op:    row.Op,
				Key:   row.Key,
				Value: row.Value,
			})
		}
	}
	return PublishedTxn{TxnID: t.id, GlobalSeq: t.seq, Rows: rows}
}

// Skip 显式跳过一个被隔离的事务：它不会被发布，但不再阻挡水位。
// 用于运维确认冲突无法修复后放行后续事务。若调用使水位推进，
// 返回对应批次。
func (a *Assembler) Skip(txnID string) (*Batch, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	t := a.txns[txnID]
	if t == nil {
		return nil, fmt.Errorf("dataeng: unknown transaction %q", txnID)
	}
	if !t.quarantined {
		return nil, fmt.Errorf("dataeng: transaction %q is not quarantined", txnID)
	}
	t.skipped = true
	// 重新占位其全局序号，使水位可以越过它。
	if t.seq != 0 {
		if _, taken := a.seqToTxn[t.seq]; !taken {
			a.seqToTxn[t.seq] = t.id
			t.hasSeq = true
		}
	}
	return a.advanceLocked(), nil
}

func slicesOfSortedUnique(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
