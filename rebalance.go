package formal

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// DefaultSessionTimeout is used when JoinOptions.SessionTimeout is zero.
const DefaultSessionTimeout = 10 * time.Second

var (
	// ErrUnknownMember is returned when an operation names a member that is
	// not currently registered in the group.
	ErrUnknownMember = errors.New("rebalance: unknown member")
	// ErrInvalidMember is returned for an empty member ID.
	ErrInvalidMember = errors.New("rebalance: member ID must not be empty")
	// ErrUnknownPartition is returned when an operation names a partition that
	// was not registered with the coordinator.
	ErrUnknownPartition = errors.New("rebalance: unknown partition")
	// ErrSessionExpired is returned when a heartbeat arrives after the
	// member's session timeout. The member is evicted before the error is
	// returned.
	ErrSessionExpired = errors.New("rebalance: member session expired")
	// ErrInstanceMismatch is returned when a member reconnects with a
	// different static instance identity.
	ErrInstanceMismatch = errors.New("rebalance: static instance does not match member")
	// ErrStaleGeneration is returned when a commit or revocation acknowledgement
	// targets a generation that is not the relevant active/pending generation.
	ErrStaleGeneration = errors.New("rebalance: stale generation")
	// ErrNotOwner is returned when a member commits a partition that it does
	// not own in the active generation.
	ErrNotOwner = errors.New("rebalance: member does not own partition")
	// ErrRevoked is returned when a member commits a partition that it has been
	// asked to revoke but has not finished handing over.
	ErrRevoked = errors.New("rebalance: partition is being revoked")
	// ErrOffsetRegression is returned when a commit would lower the last
	// committed offset of a partition.
	ErrOffsetRegression = errors.New("rebalance: commit offset would regress")
	// ErrInvalidOffset is returned for a negative commit offset.
	ErrInvalidOffset = errors.New("rebalance: commit offset must be non-negative")
	// ErrInvalidTimeout is returned for a negative session timeout.
	ErrInvalidTimeout = errors.New("rebalance: session timeout must not be negative")
)

// JoinOptions controls membership properties. InstanceID makes the member a
// static member: disconnecting and reconnecting before the session timeout
// does not change its assignment or the group generation.
type JoinOptions struct {
	InstanceID string
	// SessionTimeout of zero uses DefaultSessionTimeout for a new member and
	// preserves the existing timeout on reconnect.
	SessionTimeout time.Duration
}

// JoinResult describes the state visible to a member after Join.
type JoinResult struct {
	MemberID    string
	Generation  int64
	Assignment  []Partition
	Reconnected bool
	Rebalancing bool
}

// HeartbeatResult describes the state visible to a member after a heartbeat.
type HeartbeatResult struct {
	Generation  int64
	Assignment  []Partition
	Rebalancing bool
}

// AckResult describes the state visible to a member after acknowledging a
// revocation. Complete is true once the pending generation has been activated.
type AckResult struct {
	Generation int64
	Assignment []Partition
	Complete   bool
}

// Coordinator owns group membership, generations and partition ownership. All
// operations are safe for concurrent use. Event time is supplied explicitly so
// callers and tests can replay a deterministic event sequence.
type Coordinator struct {
	mu sync.Mutex

	partitions      []Partition
	partitionExists map[Partition]struct{}

	members   map[string]*memberState
	instances map[string]string

	// generation is the active generation. issuedGeneration may be larger
	// while a rebalance is waiting for revocation acknowledgements.
	generation       int64
	issuedGeneration int64
	assignments      map[Partition]string
	committed        map[Partition]int64
	pending          *pendingRebalance
}

type memberState struct {
	id             string
	instanceID     string
	sessionTimeout time.Duration
	lastSeen       time.Time
	generation     int64
	assignment     []Partition
}

type pendingRebalance struct {
	generation int64
	target     map[Partition]string
	revokeFrom map[string][]Partition
	waiting    map[string]struct{}
}

// NewCoordinator creates a coordinator for a fixed partition set. Partition
// IDs are immutable after construction.
func NewCoordinator(partitions []Partition) (*Coordinator, error) {
	registered := append([]Partition(nil), partitions...)
	sortPartitions(registered)

	exists := make(map[Partition]struct{}, len(registered))
	for i, partition := range registered {
		if i > 0 && registered[i-1] == partition {
			return nil, fmt.Errorf("rebalance: duplicate partition %s", partition)
		}
		exists[partition] = struct{}{}
	}

	return &Coordinator{
		partitions:       registered,
		partitionExists:  exists,
		members:          make(map[string]*memberState),
		instances:        make(map[string]string),
		assignments:      make(map[Partition]string),
		committed:        make(map[Partition]int64),
		generation:       0,
		issuedGeneration: 0,
	}, nil
}

// Join adds a member or reconnects an existing member. A new member triggers a
// rebalance. Reconnecting a member whose session has not expired preserves its
// current assignment and generation.
func (c *Coordinator) Join(memberID string, opts JoinOptions, now time.Time) (JoinResult, error) {
	if memberID == "" {
		return JoinResult{}, ErrInvalidMember
	}
	if opts.SessionTimeout < 0 {
		return JoinResult{}, ErrInvalidTimeout
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if existing := c.members[memberID]; existing != nil {
		if c.expiredLocked(existing, now) {
			// A reconnect after the session deadline is a new membership. The
			// old assignment is released before processing the join.
			c.removeMemberLocked(memberID)
		} else {
			if opts.InstanceID != "" {
				if existing.instanceID == "" || existing.instanceID != opts.InstanceID {
					return JoinResult{}, fmt.Errorf("%w: member %q", ErrInstanceMismatch, memberID)
				}
			}
			if opts.SessionTimeout > 0 {
				existing.sessionTimeout = opts.SessionTimeout
			}
			if now.After(existing.lastSeen) {
				existing.lastSeen = now
			}
			result := c.joinResultLocked(existing)
			result.Reconnected = true
			return result, nil
		}
	}

	if opts.InstanceID != "" {
		if existingID, ok := c.instances[opts.InstanceID]; ok {
			existing := c.members[existingID]
			if existing == nil {
				delete(c.instances, opts.InstanceID)
			} else if c.expiredLocked(existing, now) {
				c.removeMemberLocked(existingID)
			} else {
				c.rebindMemberIDLocked(existing, memberID)
				if opts.SessionTimeout > 0 {
					existing.sessionTimeout = opts.SessionTimeout
				}
				if now.After(existing.lastSeen) {
					existing.lastSeen = now
				}
				result := c.joinResultLocked(existing)
				result.Reconnected = true
				return result, nil
			}
		}
	}

	sessionTimeout := opts.SessionTimeout
	if sessionTimeout == 0 {
		sessionTimeout = DefaultSessionTimeout
	}
	member := &memberState{
		id:             memberID,
		instanceID:     opts.InstanceID,
		sessionTimeout: sessionTimeout,
		lastSeen:       now,
	}
	c.members[memberID] = member
	if member.instanceID != "" {
		c.instances[member.instanceID] = memberID
	}

	c.scheduleRebalanceLocked()
	return c.joinResultLocked(member), nil
}

// Leave removes a member immediately and triggers a rebalance. For a static
// member this is an explicit departure; a brief disconnect that is followed by
// Join is handled by the reconnect path instead.
func (c *Coordinator) Leave(memberID string) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, ok := c.members[memberID]; !ok {
		return fmt.Errorf("%w: %q", ErrUnknownMember, memberID)
	}
	c.removeMemberLocked(memberID)
	c.scheduleRebalanceLocked()
	return nil
}

// Heartbeat refreshes a member's session. A heartbeat at or after the session
// deadline is rejected and evicts the member, which also triggers a rebalance.
func (c *Coordinator) Heartbeat(memberID string, now time.Time) (HeartbeatResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	member, ok := c.members[memberID]
	if !ok {
		return HeartbeatResult{}, fmt.Errorf("%w: %q", ErrUnknownMember, memberID)
	}
	if c.expiredLocked(member, now) {
		c.removeMemberLocked(memberID)
		c.scheduleRebalanceLocked()
		return HeartbeatResult{}, fmt.Errorf("%w: %q", ErrSessionExpired, memberID)
	}
	if now.After(member.lastSeen) {
		member.lastSeen = now
	}
	return HeartbeatResult{
		Generation:  c.generation,
		Assignment:  c.consumableLocked(member),
		Rebalancing: c.pending != nil,
	}, nil
}

// ExpireHeartbeats evicts every member whose session has timed out at now and
// schedules one rebalance for the resulting membership. It returns the evicted
// member IDs in deterministic order.
func (c *Coordinator) ExpireHeartbeats(now time.Time) []string {
	c.mu.Lock()
	defer c.mu.Unlock()

	var expired []string
	for memberID, member := range c.members {
		if c.expiredLocked(member, now) {
			expired = append(expired, memberID)
		}
	}
	if len(expired) == 0 {
		return nil
	}
	sort.Strings(expired)
	for _, memberID := range expired {
		c.removeMemberLocked(memberID)
	}
	c.scheduleRebalanceLocked()
	return expired
}

// AckRevocation confirms that a member stopped consuming the partitions it was
// asked to give up. The pending generation is activated only after every
// affected member has acknowledged. Acks are idempotent.
func (c *Coordinator) AckRevocation(memberID string, generation int64) (AckResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	member, ok := c.members[memberID]
	if !ok {
		return AckResult{}, fmt.Errorf("%w: %q", ErrUnknownMember, memberID)
	}

	if c.pending == nil {
		if generation != c.generation {
			return AckResult{}, fmt.Errorf("%w: got %d, active %d", ErrStaleGeneration, generation, c.generation)
		}
		return AckResult{
			Generation: c.generation,
			Assignment: c.consumableLocked(member),
			Complete:   true,
		}, nil
	}

	if generation != c.pending.generation {
		return AckResult{}, fmt.Errorf("%w: got %d, pending %d", ErrStaleGeneration, generation, c.pending.generation)
	}

	delete(c.pending.waiting, memberID)
	if len(c.pending.waiting) == 0 {
		c.finalizeLocked(c.pending)
	}

	return AckResult{
		Generation: c.generation,
		Assignment: c.consumableLocked(member),
		Complete:   c.pending == nil,
	}, nil
}

// Commit records a partition offset for the active generation. The member must
// own the partition, must not have been asked to revoke it, and the offset must
// not move backwards.
func (c *Coordinator) Commit(memberID string, generation int64, partition Partition, offset int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	member, ok := c.members[memberID]
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownMember, memberID)
	}
	if generation != c.generation {
		return fmt.Errorf("%w: got %d, active %d", ErrStaleGeneration, generation, c.generation)
	}
	if _, ok := c.partitionExists[partition]; !ok {
		return fmt.Errorf("%w: %s", ErrUnknownPartition, partition)
	}
	if offset < 0 {
		return fmt.Errorf("%w: %d", ErrInvalidOffset, offset)
	}
	if c.pending != nil && containsPartition(c.pending.revokeFrom[member.id], partition) {
		return fmt.Errorf("%w: member %q partition %s", ErrRevoked, memberID, partition)
	}
	if c.assignments[partition] != memberID {
		return fmt.Errorf("%w: member %q partition %s", ErrNotOwner, memberID, partition)
	}
	if previous, ok := c.committed[partition]; ok && offset < previous {
		return fmt.Errorf("%w: partition %s got %d after %d", ErrOffsetRegression, partition, offset, previous)
	}

	c.committed[partition] = offset
	return nil
}

// Assignment returns the partitions the member may consume right now. During a
// rebalance, partitions awaiting revocation are excluded. A newly joined member
// has no consumable assignment until the pending generation is activated.
func (c *Coordinator) Assignment(memberID string) ([]Partition, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	member, ok := c.members[memberID]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownMember, memberID)
	}
	return c.consumableLocked(member), nil
}

// Generation returns the active generation. A pending generation is not
// visible here until all revocations have been acknowledged.
func (c *Coordinator) Generation() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.generation
}

// CommittedOffset returns the last committed offset for a partition.
func (c *Coordinator) CommittedOffset(partition Partition) (int64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	offset, ok := c.committed[partition]
	return offset, ok
}

func (c *Coordinator) joinResultLocked(member *memberState) JoinResult {
	return JoinResult{
		MemberID:    member.id,
		Generation:  c.generation,
		Assignment:  c.consumableLocked(member),
		Rebalancing: c.pending != nil,
	}
}

func (c *Coordinator) expiredLocked(member *memberState, now time.Time) bool {
	deadline := member.lastSeen.Add(member.sessionTimeout)
	return !now.Before(deadline)
}

func (c *Coordinator) removeMemberLocked(memberID string) {
	member, ok := c.members[memberID]
	if !ok {
		return
	}
	delete(c.members, memberID)
	if member.instanceID != "" {
		delete(c.instances, member.instanceID)
	}
	for partition, owner := range c.assignments {
		if owner == memberID {
			delete(c.assignments, partition)
		}
	}
}

// rebindMemberIDLocked attaches a static member's preserved state to a new
// session ID. This is the restart path for a static member that has not yet
// exceeded its session timeout.
func (c *Coordinator) rebindMemberIDLocked(member *memberState, newID string) {
	oldID := member.id
	if oldID == newID {
		return
	}

	delete(c.members, oldID)
	member.id = newID
	c.members[newID] = member
	if member.instanceID != "" {
		c.instances[member.instanceID] = newID
	}

	for partition, owner := range c.assignments {
		if owner == oldID {
			c.assignments[partition] = newID
		}
	}
	if c.pending == nil {
		return
	}
	if partitions, ok := c.pending.revokeFrom[oldID]; ok {
		delete(c.pending.revokeFrom, oldID)
		c.pending.revokeFrom[newID] = partitions
	}
	if _, ok := c.pending.waiting[oldID]; ok {
		delete(c.pending.waiting, oldID)
		c.pending.waiting[newID] = struct{}{}
	}
	for partition, owner := range c.pending.target {
		if owner == oldID {
			c.pending.target[partition] = newID
		}
	}
}

func (c *Coordinator) consumableLocked(member *memberState) []Partition {
	if len(member.assignment) == 0 {
		return nil
	}

	result := make([]Partition, 0, len(member.assignment))
	for _, partition := range member.assignment {
		if c.pending != nil && containsPartition(c.pending.revokeFrom[member.id], partition) {
			continue
		}
		result = append(result, partition)
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func (c *Coordinator) scheduleRebalanceLocked() {
	c.issuedGeneration++

	target := c.computeTargetLocked()
	revokeFrom := c.computeRevocationsLocked(target)
	waiting := make(map[string]struct{}, len(revokeFrom))
	for memberID := range revokeFrom {
		waiting[memberID] = struct{}{}
	}

	pending := &pendingRebalance{
		generation: c.issuedGeneration,
		target:     target,
		revokeFrom: revokeFrom,
		waiting:    waiting,
	}
	if len(waiting) == 0 {
		c.finalizeLocked(pending)
		return
	}
	c.pending = pending
}

// computeTargetLocked keeps as much of the active ownership as possible and
// fills the remaining partitions from the least-loaded member. The result is a
// bijection from partitions to members (or empty when there are no members).
func (c *Coordinator) computeTargetLocked() map[Partition]string {
	target := make(map[Partition]string, len(c.partitions))
	if len(c.members) == 0 {
		return target
	}

	memberIDs := make([]string, 0, len(c.members))
	for memberID := range c.members {
		memberIDs = append(memberIDs, memberID)
	}
	sort.Strings(memberIDs)

	quota := (len(c.partitions) + len(memberIDs) - 1) / len(memberIDs)
	load := make(map[string]int, len(memberIDs))

	for _, partition := range c.partitions {
		owner, ok := c.assignments[partition]
		if !ok {
			continue
		}
		if _, active := c.members[owner]; !active {
			continue
		}
		if load[owner] >= quota {
			continue
		}
		target[partition] = owner
		load[owner]++
	}

	for _, partition := range c.partitions {
		if _, assigned := target[partition]; assigned {
			continue
		}
		selected := memberIDs[0]
		for _, memberID := range memberIDs[1:] {
			if load[memberID] < load[selected] {
				selected = memberID
			}
		}
		target[partition] = selected
		load[selected]++
	}

	return target
}

func (c *Coordinator) computeRevocationsLocked(target map[Partition]string) map[string][]Partition {
	revokeFrom := make(map[string][]Partition)
	for partition, owner := range c.assignments {
		if target[partition] == owner {
			continue
		}
		if _, active := c.members[owner]; !active {
			continue
		}
		revokeFrom[owner] = append(revokeFrom[owner], partition)
	}
	for memberID := range revokeFrom {
		sortPartitions(revokeFrom[memberID])
	}
	return revokeFrom
}

func (c *Coordinator) finalizeLocked(pending *pendingRebalance) {
	c.generation = pending.generation

	c.assignments = make(map[Partition]string, len(pending.target))
	for partition, owner := range pending.target {
		c.assignments[partition] = owner
	}

	for _, member := range c.members {
		member.generation = c.generation
		member.assignment = nil
	}
	for partition, owner := range pending.target {
		member := c.members[owner]
		member.assignment = append(member.assignment, partition)
	}
	for _, member := range c.members {
		sortPartitions(member.assignment)
	}

	c.pending = nil
}
