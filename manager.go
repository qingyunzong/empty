package formal

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
)

// TxID is a monotonically allocated transaction identifier.
type TxID uint64

// Snapshot is the MVCC visibility point captured when a transaction starts.
// Seq is an event sequence: every transaction whose commit sequence is less
// than Seq is visible. Safe is true only for a read-only transaction that
// started while no read-write transaction was active.
type Snapshot struct {
	Seq  uint64
	Safe bool
}

// TxStatus is the externally observable state of a transaction.
type TxStatus uint8

const (
	StatusActive TxStatus = iota
	StatusCommitted
	StatusAborted
)

func (s TxStatus) String() string {
	switch s {
	case StatusActive:
		return "active"
	case StatusCommitted:
		return "committed"
	case StatusAborted:
		return "aborted"
	default:
		return "unknown"
	}
}

// TxOptions controls transaction creation.
type TxOptions struct {
	// ReadOnly forbids writes and permits safe-snapshot tracking.
	ReadOnly bool
	// Deferrable waits until no read-write transaction is active before the
	// read-only transaction takes its snapshot. It is rejected for read-write
	// transactions.
	Deferrable bool
}

// Transaction contains the transaction state visible to callers. All other
// state is owned by its Manager.
type Transaction struct {
	ID       TxID
	Snapshot Snapshot
	ReadOnly bool

	manager *Manager

	status    TxStatus
	beginSeq  uint64
	endSeq    uint64
	commitSeq uint64
	abortWhy  string

	reads  map[string]struct{}
	writes map[string]struct{}

	in  map[TxID]*rwEdge
	out map[TxID]*rwEdge
}

// Status returns the transaction status. It is safe to call concurrently with
// Manager operations.
func (tx *Transaction) Status() TxStatus {
	tx.manager.mu.Lock()
	defer tx.manager.mu.Unlock()
	return tx.status
}

// Committed reports whether the transaction committed.
func (tx *Transaction) Committed() bool {
	return tx.Status() == StatusCommitted
}

// Read records a key read on the transaction.
func (tx *Transaction) Read(key string) error {
	return tx.manager.Read(tx, key)
}

// Write records a key write on the transaction.
func (tx *Transaction) Write(key string) error {
	return tx.manager.Write(tx, key)
}

// Commit runs the transaction's commit-time SSI check.
func (tx *Transaction) Commit() Decision {
	return tx.manager.Commit(tx)
}

// Abort rolls back an active transaction.
func (tx *Transaction) Abort() error {
	return tx.manager.Abort(tx)
}

// VictimPolicy selects the deterministic victim of a dangerous structure.
type VictimPolicy uint8

const (
	// VictimPivot aborts the committing pivot. It is the default and mirrors
	// the usual PostgreSQL-style SSI policy.
	VictimPivot VictimPolicy = iota
	// VictimLowestID chooses the lowest eligible transaction ID.
	VictimLowestID
	// VictimHighestID chooses the highest eligible transaction ID.
	VictimHighestID
)

func (p VictimPolicy) String() string {
	switch p {
	case VictimPivot:
		return "pivot"
	case VictimLowestID:
		return "lowest-id"
	case VictimHighestID:
		return "highest-id"
	default:
		return "unknown"
	}
}

// Option configures a Manager.
type Option func(*Manager)

// WithVictimPolicy changes the deterministic victim-selection policy.
func WithVictimPolicy(policy VictimPolicy) Option {
	return func(m *Manager) {
		m.policy = policy
	}
}

// DangerousStructure is a pair of adjacent rw-antidependencies:
//
//	In --rw--> Pivot --rw--> Out
//
// Out must have committed before the pivot is allowed to commit. The structure
// is reported even when the transaction that is ultimately chosen as the
// victim is not the pivot.
type DangerousStructure struct {
	In    TxID
	Pivot TxID
	Out   TxID
}

// Decision is the result of Commit.
type Decision struct {
	// Committed is true when the committing transaction was allowed to commit.
	Committed bool
	// Victim is zero when no transaction was aborted by this commit check.
	// Otherwise it is the transaction that must roll back.
	Victim TxID
	// Structures lists the dangerous structures that caused the decision.
	Structures []DangerousStructure
	// Reason is a stable, human-readable explanation.
	Reason string
}

// Stats is a snapshot of Manager bookkeeping.
type Stats struct {
	Active          int
	ActiveReadWrite int
	LiveEdges       int
	LiveKeyAccesses int
	Transactions    uint64
	Committed       uint64
	Aborted         uint64
	Dangerous       uint64
	WriteConflicts  uint64
	SafeSnapshotSeq uint64
	EdgesCreated    uint64
	EdgesReclaimed  uint64
}

// Errors returned by transaction operations.
var (
	ErrReadOnlyWrite       = errors.New("formal: write in read-only transaction")
	ErrDeferrableReadWrite = errors.New("formal: deferrable option requires a read-only transaction")
	ErrForeignTransaction  = errors.New("formal: transaction belongs to another manager")
	ErrTxClosed            = errors.New("formal: transaction is no longer active")
	ErrTxCommitted         = errors.New("formal: transaction already committed")
)

// Stable reasons used in Decision.Reason.
const (
	ReasonDangerousStructure = "dangerous structure"
	ReasonWriteWriteConflict = "write-write conflict"
	ReasonSelectedVictim     = "selected victim"
	ReasonCallerAbort        = "aborted by caller"
)

const noEnd = ^uint64(0)

type rwEdge struct {
	from *Transaction
	to   *Transaction
	keys map[string]struct{}
}

// Manager is the commit-time SSI oracle. It is safe for concurrent use. The
// manager serializes its own bookkeeping; the transaction manager remains
// responsible for making aborted transactions roll back their private writes.
type Manager struct {
	mu sync.Mutex

	clock  uint64
	nextID TxID
	txs    map[TxID]*Transaction
	active map[TxID]*Transaction

	readers map[string]map[TxID]*Transaction
	writers map[string]map[TxID]*Transaction

	activeRW    int
	lastSafeSeq uint64
	safeCh      chan struct{}

	policy VictimPolicy

	committed      uint64
	aborted        uint64
	dangerous      uint64
	writeConflicts uint64
	edgesCreated   uint64
	edgesReclaimed uint64
}

// NewManager creates an empty SSI manager.
func NewManager(options ...Option) *Manager {
	m := &Manager{
		txs:     make(map[TxID]*Transaction),
		active:  make(map[TxID]*Transaction),
		readers: make(map[string]map[TxID]*Transaction),
		writers: make(map[string]map[TxID]*Transaction),
		nextID:  1,
		policy:  VictimPivot,
	}
	for _, option := range options {
		option(m)
	}
	return m
}

// Begin starts a transaction with the current snapshot.
func (m *Manager) Begin(options TxOptions) (*Transaction, error) {
	return m.BeginContext(context.Background(), options)
}

// BeginContext starts a transaction. A deferrable read-only transaction waits
// for a safe snapshot. Waiting is canceled by ctx.
func (m *Manager) BeginContext(ctx context.Context, options TxOptions) (*Transaction, error) {
	if options.Deferrable && !options.ReadOnly {
		return nil, ErrDeferrableReadWrite
	}
	if ctx == nil {
		ctx = context.Background()
	}

	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		m.mu.Lock()
		if !options.Deferrable || m.activeRW == 0 {
			tx := m.beginLocked(options)
			m.mu.Unlock()
			return tx, nil
		}
		ch := m.safeWaitLocked()
		m.mu.Unlock()

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ch:
		}
	}
}

func (m *Manager) beginLocked(options TxOptions) *Transaction {
	begin := m.clock
	m.clock++

	id := m.nextID
	m.nextID++
	tx := &Transaction{
		ID:       id,
		Snapshot: Snapshot{Seq: begin, Safe: options.ReadOnly && m.activeRW == 0},
		ReadOnly: options.ReadOnly,
		manager:  m,
		beginSeq: begin,
		reads:    make(map[string]struct{}),
		writes:   make(map[string]struct{}),
		in:       make(map[TxID]*rwEdge),
		out:      make(map[TxID]*rwEdge),
	}
	if !options.ReadOnly {
		m.activeRW++
	}
	m.txs[id] = tx
	m.active[id] = tx
	return tx
}

// SafeSnapshot returns a read-only-safe snapshot when no read-write
// transaction is currently active.
func (m *Manager) SafeSnapshot() (Snapshot, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.activeRW != 0 {
		return Snapshot{}, false
	}
	return Snapshot{Seq: m.clock, Safe: true}, true
}

// LastSafeSnapshot returns the sequence of the most recent point at which no
// read-write transaction was active.
func (m *Manager) LastSafeSnapshot() Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	return Snapshot{Seq: m.lastSafeSeq, Safe: true}
}

// WaitForSafeSnapshot waits until a safe read-only snapshot can be taken.
func (m *Manager) WaitForSafeSnapshot(ctx context.Context) (Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		if err := ctx.Err(); err != nil {
			return Snapshot{}, err
		}
		m.mu.Lock()
		if m.activeRW == 0 {
			snapshot := Snapshot{Seq: m.clock, Safe: true}
			m.mu.Unlock()
			return snapshot, nil
		}
		ch := m.safeWaitLocked()
		m.mu.Unlock()

		select {
		case <-ctx.Done():
			return Snapshot{}, ctx.Err()
		case <-ch:
		}
	}
}

func (m *Manager) safeWaitLocked() <-chan struct{} {
	if m.safeCh == nil {
		m.safeCh = make(chan struct{})
	}
	return m.safeCh
}

func (m *Manager) signalSafeLocked() {
	if m.safeCh != nil {
		close(m.safeCh)
		m.safeCh = nil
	}
}

// Read records that tx read key at its snapshot.
func (m *Manager) Read(tx *Transaction, key string) error {
	if tx == nil || tx.manager != m {
		return ErrForeignTransaction
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if tx.status != StatusActive {
		return ErrTxClosed
	}

	tx.reads[key] = struct{}{}
	m.addKeyReaderLocked(key, tx)
	for _, writer := range m.writers[key] {
		if m.rwConflictLocked(tx, writer) {
			m.addEdgeLocked(tx, writer, key)
		}
	}
	return nil
}

// Write records that tx wrote key.
func (m *Manager) Write(tx *Transaction, key string) error {
	if tx == nil || tx.manager != m {
		return ErrForeignTransaction
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if tx.status != StatusActive {
		return ErrTxClosed
	}
	if tx.ReadOnly {
		return ErrReadOnlyWrite
	}

	tx.writes[key] = struct{}{}
	m.addKeyWriterLocked(key, tx)
	for _, reader := range m.readers[key] {
		if m.rwConflictLocked(reader, tx) {
			m.addEdgeLocked(reader, tx, key)
		}
	}
	return nil
}

// Commit performs write-write validation and SSI dangerous-structure
// detection. The returned victim is already marked aborted; a transaction
// manager can therefore use the decision directly on its commit path.
func (m *Manager) Commit(tx *Transaction) Decision {
	if tx == nil || tx.manager != m {
		return Decision{Reason: ErrForeignTransaction.Error()}
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	switch tx.status {
	case StatusCommitted:
		return Decision{Committed: true, Reason: "already committed"}
	case StatusAborted:
		return Decision{Victim: tx.ID, Reason: tx.abortWhy}
	}

	if other := m.writeConflictLocked(tx); other != 0 {
		m.writeConflicts++
		reason := fmt.Sprintf("%s with transaction %d", ReasonWriteWriteConflict, other)
		m.abortLocked(tx, reason)
		return Decision{Victim: tx.ID, Reason: reason}
	}

	structures := m.dangerousStructuresLocked(tx)
	structures = append(structures, m.lateDangerousStructuresLocked(tx)...)
	sort.Slice(structures, func(i, j int) bool {
		if structures[i].In != structures[j].In {
			return structures[i].In < structures[j].In
		}
		if structures[i].Pivot != structures[j].Pivot {
			return structures[i].Pivot < structures[j].Pivot
		}
		return structures[i].Out < structures[j].Out
	})
	if len(structures) != 0 {
		m.dangerous += uint64(len(structures))
		victim := m.chooseVictimLocked(tx, structures)
		if victim == tx.ID {
			m.abortLocked(tx, ReasonDangerousStructure)
			return Decision{
				Victim:     tx.ID,
				Structures: structures,
				Reason:     ReasonDangerousStructure,
			}
		}

		if victimTx := m.txs[victim]; victimTx != nil && victimTx.status == StatusActive {
			m.abortLocked(victimTx, ReasonSelectedVictim)
		}
		m.commitLocked(tx)
		return Decision{
			Committed:  true,
			Victim:     victim,
			Structures: structures,
			Reason:     ReasonSelectedVictim,
		}
	}

	m.commitLocked(tx)
	return Decision{Committed: true}
}

// Abort rolls back an active transaction. Aborting an already aborted
// transaction is a no-op.
func (m *Manager) Abort(tx *Transaction) error {
	if tx == nil || tx.manager != m {
		return ErrForeignTransaction
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	switch tx.status {
	case StatusAborted:
		return nil
	case StatusCommitted:
		return ErrTxCommitted
	default:
		m.abortLocked(tx, ReasonCallerAbort)
		return nil
	}
}

// Stats returns a consistent snapshot of manager counters.
func (m *Manager) Stats() Stats {
	m.mu.Lock()
	defer m.mu.Unlock()

	stats := Stats{
		Active:          len(m.active),
		ActiveReadWrite: m.activeRW,
		Transactions:    uint64(m.nextID - 1),
		Committed:       m.committed,
		Aborted:         m.aborted,
		Dangerous:       m.dangerous,
		WriteConflicts:  m.writeConflicts,
		SafeSnapshotSeq: m.lastSafeSeq,
		EdgesCreated:    m.edgesCreated,
		EdgesReclaimed:  m.edgesReclaimed,
	}
	for _, tx := range m.txs {
		stats.LiveEdges += len(tx.out)
		stats.LiveKeyAccesses += len(tx.reads) + len(tx.writes)
	}
	return stats
}

func (m *Manager) rwConflictLocked(reader, writer *Transaction) bool {
	if reader == nil || writer == nil || reader == writer {
		return false
	}
	if reader.status == StatusAborted || writer.status == StatusAborted {
		return false
	}
	if !m.concurrentLocked(reader, writer) {
		return false
	}
	if writer.status == StatusCommitted && writer.commitSeq < reader.beginSeq {
		return false
	}
	return true
}

func (m *Manager) concurrentLocked(a, b *Transaction) bool {
	aEnd := a.endSeq
	if a.status == StatusActive {
		aEnd = noEnd
	}
	bEnd := b.endSeq
	if b.status == StatusActive {
		bEnd = noEnd
	}
	return a.beginSeq < bEnd && b.beginSeq < aEnd
}

func (m *Manager) addKeyReaderLocked(key string, tx *Transaction) {
	set := m.readers[key]
	if set == nil {
		set = make(map[TxID]*Transaction)
		m.readers[key] = set
	}
	set[tx.ID] = tx
}

func (m *Manager) addKeyWriterLocked(key string, tx *Transaction) {
	set := m.writers[key]
	if set == nil {
		set = make(map[TxID]*Transaction)
		m.writers[key] = set
	}
	set[tx.ID] = tx
}

func (m *Manager) addEdgeLocked(from, to *Transaction, key string) {
	if from == to || from.status == StatusAborted || to.status == StatusAborted {
		return
	}
	if edge := from.out[to.ID]; edge != nil {
		edge.keys[key] = struct{}{}
		return
	}
	edge := &rwEdge{
		from: from,
		to:   to,
		keys: map[string]struct{}{key: {}},
	}
	from.out[to.ID] = edge
	to.in[from.ID] = edge
	m.edgesCreated++
}

func (m *Manager) removeEdgeLocked(edge *rwEdge) {
	if edge == nil {
		return
	}
	if current := edge.from.out[edge.to.ID]; current == edge {
		delete(edge.from.out, edge.to.ID)
	}
	if current := edge.to.in[edge.from.ID]; current == edge {
		delete(edge.to.in, edge.from.ID)
	}
	m.edgesReclaimed++
}

func (m *Manager) removeAllEdgesLocked(tx *Transaction) {
	edges := make([]*rwEdge, 0, len(tx.in)+len(tx.out))
	for _, edge := range tx.in {
		edges = append(edges, edge)
	}
	for _, edge := range tx.out {
		edges = append(edges, edge)
	}
	for _, edge := range edges {
		m.removeEdgeLocked(edge)
	}
}

func (m *Manager) edgeNeededLocked(edge *rwEdge) bool {
	if edge == nil {
		return false
	}
	if edge.from.status == StatusActive || edge.to.status == StatusActive {
		return true
	}
	// A committed pivot's out-edges can still participate in a dangerous
	// structure if a transaction that overlapped it later publishes an edge
	// into the pivot.
	return edge.from.status == StatusCommitted && m.hasActiveOverlapLocked(edge.from)
}

func (m *Manager) retireUnneededEdgesLocked(tx *Transaction) {
	edges := make([]*rwEdge, 0, len(tx.in)+len(tx.out))
	for _, edge := range tx.in {
		edges = append(edges, edge)
	}
	for _, edge := range tx.out {
		edges = append(edges, edge)
	}
	for _, edge := range edges {
		if !m.edgeNeededLocked(edge) {
			m.removeEdgeLocked(edge)
		}
	}
}

func (m *Manager) removeAccessLocked(tx *Transaction) {
	for key := range tx.reads {
		if set := m.readers[key]; set != nil {
			delete(set, tx.ID)
			if len(set) == 0 {
				delete(m.readers, key)
			}
		}
	}
	for key := range tx.writes {
		if set := m.writers[key]; set != nil {
			delete(set, tx.ID)
			if len(set) == 0 {
				delete(m.writers, key)
			}
		}
	}
}

func (m *Manager) hasActiveOverlapLocked(tx *Transaction) bool {
	for _, active := range m.active {
		if active.beginSeq < tx.endSeq {
			return true
		}
	}
	return false
}

func (m *Manager) gcLocked() {
	for id, tx := range m.txs {
		if tx.status == StatusActive {
			continue
		}
		if tx.status == StatusAborted {
			m.removeAllEdgesLocked(tx)
			m.removeAccessLocked(tx)
			delete(m.txs, id)
			continue
		}
		if m.hasActiveOverlapLocked(tx) {
			continue
		}
		m.retireUnneededEdgesLocked(tx)
		m.removeAccessLocked(tx)
		delete(m.txs, id)
	}
}

func (m *Manager) commitLocked(tx *Transaction) {
	delete(m.active, tx.ID)
	tx.status = StatusCommitted
	tx.commitSeq = m.clock
	tx.endSeq = m.clock
	m.clock++
	m.committed++

	if !tx.ReadOnly {
		m.activeRW--
		if m.activeRW == 0 {
			m.lastSafeSeq = m.clock
			m.signalSafeLocked()
		}
	} else if m.activeRW == 0 {
		m.lastSafeSeq = m.clock
	}

	m.retireUnneededEdgesLocked(tx)
	m.gcLocked()
}

func (m *Manager) abortLocked(tx *Transaction, reason string) {
	delete(m.active, tx.ID)
	tx.status = StatusAborted
	tx.endSeq = m.clock
	tx.abortWhy = reason
	m.clock++
	m.aborted++

	if !tx.ReadOnly {
		m.activeRW--
		if m.activeRW == 0 {
			m.lastSafeSeq = m.clock
			m.signalSafeLocked()
		}
	} else if m.activeRW == 0 {
		m.lastSafeSeq = m.clock
	}

	m.gcLocked()
}

func (m *Manager) writeConflictLocked(tx *Transaction) TxID {
	for key := range tx.writes {
		for _, writer := range m.writers[key] {
			if writer == tx || writer.status != StatusCommitted {
				continue
			}
			if writer.commitSeq > tx.beginSeq {
				return writer.ID
			}
		}
	}
	return 0
}

func (m *Manager) dangerousStructuresLocked(pivot *Transaction) []DangerousStructure {
	if pivot.ReadOnly || len(pivot.in) == 0 || len(pivot.out) == 0 {
		return nil
	}

	structures := make([]DangerousStructure, 0)
	for _, inEdge := range pivot.in {
		in := inEdge.from
		if in.status == StatusAborted {
			continue
		}
		// A safe read-only transaction has no incoming serialization path, so
		// it cannot close a cycle through the pivot.
		if in.ReadOnly && in.Snapshot.Safe {
			continue
		}
		for _, outEdge := range pivot.out {
			out := outEdge.to
			if out.status != StatusCommitted {
				continue
			}
			if in.status == StatusCommitted && in.ID != out.ID && in.commitSeq < out.commitSeq {
				continue
			}
			structures = append(structures, DangerousStructure{
				In:    in.ID,
				Pivot: pivot.ID,
				Out:   out.ID,
			})
		}
	}

	return structures
}

// lateDangerousStructuresLocked checks structures whose pivot committed before
// the current transaction published its edge into that pivot. The pivot was
// unable to see the edge when it committed, so the current transaction (the
// source of the structure) must perform the check.
func (m *Manager) lateDangerousStructuresLocked(source *Transaction) []DangerousStructure {
	if source.ReadOnly && source.Snapshot.Safe {
		return nil
	}

	structures := make([]DangerousStructure, 0)
	for _, outEdge := range source.out {
		pivot := outEdge.to
		if pivot.status != StatusCommitted || pivot.ReadOnly {
			continue
		}
		for _, pivotOut := range pivot.out {
			target := pivotOut.to
			if target.status != StatusCommitted {
				continue
			}
			if target.ID == source.ID || target.ID == pivot.ID {
				continue
			}
			// This is the missing first-committer check from the pivot's commit
			// time. The target must have committed before the pivot and before
			// the source now committing.
			if target.commitSeq >= pivot.commitSeq {
				continue
			}
			structures = append(structures, DangerousStructure{
				In:    source.ID,
				Pivot: pivot.ID,
				Out:   target.ID,
			})
		}
	}
	return structures
}

func (m *Manager) chooseVictimLocked(pivot *Transaction, structures []DangerousStructure) TxID {
	if m.policy != VictimLowestID && m.policy != VictimHighestID {
		return pivot.ID
	}

	// The default pivot choice always covers every structure. For the ID
	// policies only choose another transaction if it occurs in every structure;
	// otherwise aborting it could leave a second dangerous structure intact.
	common := make(map[TxID]bool)
	common[pivot.ID] = true
	for _, structure := range structures {
		if tx := m.txs[structure.In]; tx != nil && tx.status == StatusActive {
			common[tx.ID] = true
		}
	}
	for _, structure := range structures {
		for id := range common {
			if id != structure.In && id != structure.Pivot {
				delete(common, id)
			}
		}
	}

	var victim TxID
	found := false
	for id := range common {
		if !found {
			victim = id
			found = true
			continue
		}
		switch m.policy {
		case VictimLowestID:
			if id < victim {
				victim = id
			}
		case VictimHighestID:
			if id > victim {
				victim = id
			}
		}
	}
	if !found {
		return pivot.ID
	}
	return victim
}
