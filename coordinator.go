package formal

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// MemberID identifies one worker process. IDs must be unique inside a
// generation and must not be reused for a different process incarnation
// without a generation change.
type MemberID string

// Generation is a monotonically increasing membership epoch. Every
// Reconfigure call creates exactly one new generation.
type Generation uint64

// Step is the logical synchronous training step. It advances only when every
// member of exactly one generation has contributed to the step.
type Step uint64

// CheckpointID identifies a checkpoint barrier.
type CheckpointID uint64

// Member is a rank assignment in the current generation.
type Member struct {
	ID       MemberID
	Rank     int
	JoinedAt Generation
}

// Gradient is a worker's contribution for one step. Digest identifies the
// contribution: retrying the same digest is idempotent, while submitting a
// different digest for the same member and step is rejected.
type Gradient struct {
	Member     MemberID
	Generation Generation
	Step       Step
	Digest     [32]byte
}

// Heartbeat proves liveness for the active (generation, step). Sequence must
// increase strictly for each member inside a generation, which makes delayed
// or replayed heartbeats observable instead of refreshing liveness.
type Heartbeat struct {
	Member     MemberID
	Generation Generation
	Step       Step
	Sequence   uint64
}

// CheckpointAck is one member's confirmation of a checkpoint barrier.
type CheckpointAck struct {
	ID         CheckpointID
	Member     MemberID
	Generation Generation
}

// StepRef names a completed step and the generation that completed it.
type StepRef struct {
	Generation Generation
	Step       Step
}

// StepRecord is immutable evidence of one completed step. Members contains
// the complete contributor set, in rank order, from a single generation.
type StepRecord struct {
	Generation Generation
	Step       Step
	Members    []MemberID
}

// GenerationRecord describes a retired generation.
type GenerationRecord struct {
	Generation         Generation
	Members            []Member
	StartStep          Step
	EndStep            Step
	Frozen             bool // retired while the frozen step still had partial gradients
	DiscardedGradients int
	AbortedCheckpoints []CheckpointID
}

// Transition is returned by Reconfigure. FrozenStep is the step at which the
// old generation stopped accepting work. StartStep is the first step owned by
// the new generation; partial work for FrozenStep is discarded, not mixed.
type Transition struct {
	PreviousGeneration Generation
	Generation         Generation
	FrozenStep         Step
	StartStep          Step
	Members            []Member
	DiscardedGradients int
	AbortedCheckpoints []CheckpointID
}

// Status is a point-in-time view of the coordinator.
type Status struct {
	Initialized        bool
	Generation         Generation
	Step               Step
	Members            []Member
	AcceptedGradients  int
	RequiredGradients  int
	LastCompleted      *StepRef // may name a step completed by a retired generation
	PendingCheckpoints int
}

// Contribution is an accepted gradient in the active step.
type Contribution struct {
	Member     MemberID
	Generation Generation
	Step       Step
	Digest     [32]byte
}

// CheckpointState is the lifecycle state of a checkpoint barrier.
type CheckpointState uint8

const (
	CheckpointPending CheckpointState = iota
	CheckpointVisible
	CheckpointAborted
)

func (s CheckpointState) String() string {
	switch s {
	case CheckpointPending:
		return "pending"
	case CheckpointVisible:
		return "visible"
	case CheckpointAborted:
		return "aborted"
	default:
		return "unknown"
	}
}

// CheckpointInfo reports barrier progress without exposing the checkpoint
// artifact. A checkpoint is readable through Coordinator.Checkpoint only when
// State is CheckpointVisible.
type CheckpointInfo struct {
	ID            CheckpointID
	Generation    Generation
	Step          Step
	State         CheckpointState
	Confirmations int
	Required      int
}

// Checkpoint is an immutable, fully confirmed checkpoint.
type Checkpoint struct {
	ID          CheckpointID
	Generation  Generation
	Step        Step
	ConfirmedBy []MemberID
}

type memberState struct {
	member           Member
	lastHeartbeatSeq uint64
}

type checkpointState struct {
	id            CheckpointID
	generation    Generation
	step          Step
	state         CheckpointState
	expectedOrder []MemberID
	expected      map[MemberID]struct{}
	confirmed     map[MemberID]struct{}
}

// Coordinator is a concurrency-safe membership coordinator for synchronous
// distributed training. All operations are linearized by one mutex, so a
// reconfiguration freezes the current step atomically with respect to
// gradient, heartbeat, and checkpoint messages.
type Coordinator struct {
	mu sync.Mutex

	initialized bool
	generation  Generation
	step        Step
	startStep   Step

	members     []Member
	membersByID map[MemberID]*memberState

	contributions map[MemberID]Contribution
	lastCompleted *StepRef

	stepHistory       []StepRecord
	generationHistory []GenerationRecord

	checkpoints      map[CheckpointID]*checkpointState
	checkpointByStep map[StepRef]CheckpointID
	nextCheckpoint   CheckpointID
}

// New creates a coordinator at generation 1, step 0. Rank is assigned by the
// position in members, so callers that need stable ranks must pass a stable
// order.
func New(members []MemberID) (*Coordinator, error) {
	c := &Coordinator{}
	if err := c.Bootstrap(members); err != nil {
		return nil, err
	}
	return c, nil
}

// Bootstrap initializes a zero-value Coordinator. It can be called at most
// once.
func (c *Coordinator) Bootstrap(members []MemberID) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.initialized {
		return ErrAlreadyInitialized
	}
	built, byID, err := buildMembers(members, 1)
	if err != nil {
		return err
	}

	c.initialized = true
	c.generation = 1
	c.step = 0
	c.startStep = 0
	c.members = built
	c.membersByID = byID
	c.contributions = make(map[MemberID]Contribution, len(built))
	c.checkpoints = make(map[CheckpointID]*checkpointState)
	c.checkpointByStep = make(map[StepRef]CheckpointID)
	return nil
}

// Reconfigure freezes the current step, retires the active generation,
// discards its partial gradients, aborts its pending checkpoints, and creates
// a new generation at the same step with caller-supplied rank order.
//
// Completed steps are never reopened. A step advances only when every member
// of one generation has contributed, so a StepRecord always contains exactly
// one generation's membership.
func (c *Coordinator) Reconfigure(members []MemberID) (Transition, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.initialized {
		return Transition{}, ErrNotInitialized
	}

	nextGeneration := c.generation + 1
	if nextGeneration < c.generation {
		return Transition{}, fmt.Errorf("formal: generation counter exhausted at %d", c.generation)
	}
	built, byID, err := buildMembers(members, nextGeneration)
	if err != nil {
		return Transition{}, err
	}

	frozenStep := c.step
	discarded := len(c.contributions)
	aborted := c.abortPendingCheckpoints()

	oldMembers := cloneMembers(c.members)
	c.generationHistory = append(c.generationHistory, GenerationRecord{
		Generation:         c.generation,
		Members:            oldMembers,
		StartStep:          c.startStep,
		EndStep:            frozenStep,
		Frozen:             discarded > 0,
		DiscardedGradients: discarded,
		AbortedCheckpoints: cloneCheckpointIDs(aborted),
	})

	previous := c.generation
	c.generation = nextGeneration
	c.members = built
	c.membersByID = byID
	c.contributions = make(map[MemberID]Contribution, len(built))
	c.startStep = frozenStep

	return Transition{
		PreviousGeneration: previous,
		Generation:         c.generation,
		FrozenStep:         frozenStep,
		StartStep:          frozenStep,
		Members:            cloneMembers(built),
		DiscardedGradients: discarded,
		AbortedCheckpoints: aborted,
	}, nil
}

// SubmitGradient records one member's contribution for the active step. The
// step advances as soon as every member of the active generation has
// contributed. Submissions from retired generations, removed members, stale
// or future steps, and conflicting duplicate digests are rejected.
func (c *Coordinator) SubmitGradient(g Gradient) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.initialized {
		return ErrNotInitialized
	}
	if isBlank(g.Member) {
		return ErrInvalidMember
	}
	if err := c.checkGeneration(g.Generation); err != nil {
		return err
	}
	if g.Step < c.step {
		return fmt.Errorf("%w: gradient step %d, active step %d", ErrStaleStep, g.Step, c.step)
	}
	if g.Step > c.step {
		return fmt.Errorf("%w: gradient step %d, active step %d", ErrFutureStep, g.Step, c.step)
	}
	if _, ok := c.membersByID[g.Member]; !ok {
		return fmt.Errorf("%w: %q", ErrUnknownMember, g.Member)
	}

	if previous, ok := c.contributions[g.Member]; ok {
		if previous.Digest == g.Digest {
			return nil
		}
		return fmt.Errorf("%w: member %q step %d", ErrConflictingGradient, g.Member, g.Step)
	}

	c.contributions[g.Member] = Contribution{
		Member:     g.Member,
		Generation: g.Generation,
		Step:       g.Step,
		Digest:     g.Digest,
	}
	if len(c.contributions) != len(c.members) {
		return nil
	}

	record := StepRecord{
		Generation: c.generation,
		Step:       c.step,
		Members:    make([]MemberID, len(c.members)),
	}
	for i, member := range c.members {
		record.Members[i] = member.ID
	}
	c.stepHistory = append(c.stepHistory, record)
	c.lastCompleted = &StepRef{Generation: c.generation, Step: c.step}
	c.step++
	c.contributions = make(map[MemberID]Contribution, len(c.members))
	return nil
}

// Heartbeat records liveness only for the active generation and step. A late,
// replayed, or out-of-order heartbeat does not refresh liveness.
func (c *Coordinator) Heartbeat(hb Heartbeat) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.initialized {
		return ErrNotInitialized
	}
	if isBlank(hb.Member) {
		return ErrInvalidMember
	}
	if hb.Sequence == 0 {
		return ErrInvalidHeartbeat
	}
	if err := c.checkGeneration(hb.Generation); err != nil {
		return err
	}
	member, ok := c.membersByID[hb.Member]
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownMember, hb.Member)
	}
	if hb.Step < c.step {
		return fmt.Errorf("%w: heartbeat step %d, active step %d", ErrStaleStep, hb.Step, c.step)
	}
	if hb.Step > c.step {
		return fmt.Errorf("%w: heartbeat step %d, active step %d", ErrFutureStep, hb.Step, c.step)
	}
	if hb.Sequence <= member.lastHeartbeatSeq {
		return fmt.Errorf("%w: member %q sequence %d, last %d", ErrStaleHeartbeat,
			hb.Member, hb.Sequence, member.lastHeartbeatSeq)
	}
	member.lastHeartbeatSeq = hb.Sequence
	return nil
}

// CreateCheckpoint starts a checkpoint barrier for the latest step completed
// by the active generation. Creation is idempotent for that (generation,
// step). The returned ID is not readable through Checkpoint until every
// expected member has confirmed.
func (c *Coordinator) CreateCheckpoint() (CheckpointID, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.initialized {
		return 0, ErrNotInitialized
	}
	if c.lastCompleted == nil || c.lastCompleted.Generation != c.generation {
		return 0, ErrNoCompletedStep
	}
	key := *c.lastCompleted
	if id, ok := c.checkpointByStep[key]; ok {
		cp := c.checkpoints[id]
		if cp.state == CheckpointAborted {
			return 0, fmt.Errorf("%w: checkpoint %d", ErrCheckpointAborted, id)
		}
		return id, nil
	}

	c.nextCheckpoint++
	cp := &checkpointState{
		id:            c.nextCheckpoint,
		generation:    c.generation,
		step:          key.Step,
		state:         CheckpointPending,
		expectedOrder: make([]MemberID, len(c.members)),
		expected:      make(map[MemberID]struct{}, len(c.members)),
		confirmed:     make(map[MemberID]struct{}, len(c.members)),
	}
	for i, member := range c.members {
		cp.expectedOrder[i] = member.ID
		cp.expected[member.ID] = struct{}{}
	}
	c.checkpoints[cp.id] = cp
	c.checkpointByStep[key] = cp.id
	return cp.id, nil
}

// ConfirmCheckpoint records one member's confirmation. Repeated confirmations
// from the same member are idempotent and never count twice. A checkpoint
// becomes visible atomically when the last expected member confirms.
//
// Pending checkpoints are aborted by Reconfigure. Confirmations that arrive
// after that point are rejected and can never make the checkpoint visible.
func (c *Coordinator) ConfirmCheckpoint(ack CheckpointAck) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.initialized {
		return ErrNotInitialized
	}
	if isBlank(ack.Member) {
		return ErrInvalidMember
	}
	cp, ok := c.checkpoints[ack.ID]
	if !ok {
		return fmt.Errorf("%w: %d", ErrCheckpointNotFound, ack.ID)
	}
	if cp.state == CheckpointAborted {
		return fmt.Errorf("%w: checkpoint %d", ErrCheckpointAborted, ack.ID)
	}
	if ack.Generation < cp.generation {
		return fmt.Errorf("%w: confirmation generation %d, checkpoint generation %d",
			ErrStaleGeneration, ack.Generation, cp.generation)
	}
	if ack.Generation > cp.generation {
		return fmt.Errorf("%w: confirmation generation %d, checkpoint generation %d",
			ErrUnknownGeneration, ack.Generation, cp.generation)
	}
	if _, expected := cp.expected[ack.Member]; !expected {
		return fmt.Errorf("%w: %q", ErrUnknownMember, ack.Member)
	}
	if cp.state == CheckpointVisible {
		return nil
	}
	if _, done := cp.confirmed[ack.Member]; done {
		return nil
	}

	cp.confirmed[ack.Member] = struct{}{}
	if len(cp.confirmed) == len(cp.expected) {
		cp.state = CheckpointVisible
	}
	return nil
}

// Checkpoint returns a checkpoint only when it is fully confirmed and visible.
// Pending and aborted barriers are indistinguishable from missing ones.
func (c *Coordinator) Checkpoint(id CheckpointID) (Checkpoint, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	cp, ok := c.checkpoints[id]
	if !ok || cp.state != CheckpointVisible {
		return Checkpoint{}, false
	}
	return cp.snapshot(), true
}

// CheckpointStatus reports barrier progress. It does not expose the
// checkpoint artifact.
func (c *Coordinator) CheckpointStatus(id CheckpointID) (CheckpointInfo, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	cp, ok := c.checkpoints[id]
	if !ok {
		return CheckpointInfo{}, false
	}
	return CheckpointInfo{
		ID:            cp.id,
		Generation:    cp.generation,
		Step:          cp.step,
		State:         cp.state,
		Confirmations: len(cp.confirmed),
		Required:      len(cp.expected),
	}, true
}

// VisibleCheckpoints returns fully confirmed checkpoints ordered by ID.
func (c *Coordinator) VisibleCheckpoints() []Checkpoint {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := make([]Checkpoint, 0, len(c.checkpoints))
	for _, cp := range c.checkpoints {
		if cp.state == CheckpointVisible {
			out = append(out, cp.snapshot())
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Status returns a consistent snapshot of the coordinator.
func (c *Coordinator) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.initialized {
		return Status{}
	}
	status := Status{
		Initialized:       true,
		Generation:        c.generation,
		Step:              c.step,
		Members:           cloneMembers(c.members),
		AcceptedGradients: len(c.contributions),
		RequiredGradients: len(c.members),
	}
	if c.lastCompleted != nil {
		last := *c.lastCompleted
		status.LastCompleted = &last
	}
	for _, cp := range c.checkpoints {
		if cp.state == CheckpointPending {
			status.PendingCheckpoints++
		}
	}
	return status
}

// Members returns the active rank assignment in rank order.
func (c *Coordinator) Members() []Member {
	c.mu.Lock()
	defer c.mu.Unlock()
	return cloneMembers(c.members)
}

// Contributions returns the accepted gradients for the active step in rank
// order. All entries carry the active generation.
func (c *Coordinator) Contributions() []Contribution {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := make([]Contribution, 0, len(c.contributions))
	for _, member := range c.members {
		if contribution, ok := c.contributions[member.ID]; ok {
			out = append(out, contribution)
		}
	}
	return out
}

// StepHistory returns immutable records of completed steps. A step appears at
// most once, and each record names exactly one generation.
func (c *Coordinator) StepHistory() []StepRecord {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := make([]StepRecord, len(c.stepHistory))
	for i, record := range c.stepHistory {
		out[i] = StepRecord{
			Generation: record.Generation,
			Step:       record.Step,
			Members:    append([]MemberID(nil), record.Members...),
		}
	}
	return out
}

// GenerationHistory returns retired generations in creation order.
func (c *Coordinator) GenerationHistory() []GenerationRecord {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := make([]GenerationRecord, len(c.generationHistory))
	for i, record := range c.generationHistory {
		out[i] = GenerationRecord{
			Generation:         record.Generation,
			Members:            cloneMembers(record.Members),
			StartStep:          record.StartStep,
			EndStep:            record.EndStep,
			Frozen:             record.Frozen,
			DiscardedGradients: record.DiscardedGradients,
			AbortedCheckpoints: cloneCheckpointIDs(record.AbortedCheckpoints),
		}
	}
	return out
}

func (c *Coordinator) checkGeneration(g Generation) error {
	if g < c.generation {
		return fmt.Errorf("%w: request generation %d, active generation %d",
			ErrStaleGeneration, g, c.generation)
	}
	if g > c.generation {
		return fmt.Errorf("%w: request generation %d, active generation %d",
			ErrUnknownGeneration, g, c.generation)
	}
	return nil
}

func (c *Coordinator) abortPendingCheckpoints() []CheckpointID {
	var aborted []CheckpointID
	for id, cp := range c.checkpoints {
		if cp.state == CheckpointPending {
			cp.state = CheckpointAborted
			aborted = append(aborted, id)
		}
	}
	sort.Slice(aborted, func(i, j int) bool { return aborted[i] < aborted[j] })
	return aborted
}

func (cp *checkpointState) snapshot() Checkpoint {
	confirmed := make([]MemberID, 0, len(cp.confirmed))
	for _, id := range cp.expectedOrder {
		if _, ok := cp.confirmed[id]; ok {
			confirmed = append(confirmed, id)
		}
	}
	return Checkpoint{
		ID:          cp.id,
		Generation:  cp.generation,
		Step:        cp.step,
		ConfirmedBy: confirmed,
	}
}

func buildMembers(ids []MemberID, generation Generation) ([]Member, map[MemberID]*memberState, error) {
	if len(ids) == 0 {
		return nil, nil, ErrEmptyMembership
	}
	members := make([]Member, len(ids))
	byID := make(map[MemberID]*memberState, len(ids))
	for rank, id := range ids {
		if isBlank(id) {
			return nil, nil, ErrInvalidMember
		}
		if _, exists := byID[id]; exists {
			return nil, nil, fmt.Errorf("%w: %q", ErrDuplicateMember, id)
		}
		member := Member{ID: id, Rank: rank, JoinedAt: generation}
		members[rank] = member
		byID[id] = &memberState{member: member}
	}
	return members, byID, nil
}

func isBlank(id MemberID) bool {
	return strings.TrimSpace(string(id)) == ""
}

func cloneMembers(members []Member) []Member {
	if members == nil {
		return nil
	}
	out := make([]Member, len(members))
	copy(out, members)
	return out
}

func cloneCheckpointIDs(ids []CheckpointID) []CheckpointID {
	if ids == nil {
		return nil
	}
	out := make([]CheckpointID, len(ids))
	copy(out, ids)
	return out
}
