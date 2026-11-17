package formal

import (
	"fmt"
	"sort"
	"time"
)

// PartitionAssignment associates one partition with its active owner.
type PartitionAssignment struct {
	Partition Partition
	MemberID  string
}

// PartitionOffset is one committed offset in a snapshot.
type PartitionOffset struct {
	Partition Partition
	Offset    int64
}

// MemberSnapshot is the externally visible state of one member.
type MemberSnapshot struct {
	ID                 string
	InstanceID         string
	Generation         int64
	Assignment         []Partition
	Consumable         []Partition
	Revoking           []Partition
	AwaitingRevocation bool
	LastSeen           time.Time
	SessionTimeout     time.Duration
}

// Snapshot is a consistent copy of the coordinator state. Assignments only
// contains the active generation. PendingAssignments is populated while a
// rebalance is waiting for revocation acknowledgements and must not be used for
// consumption.
type Snapshot struct {
	Generation         int64
	Rebalancing        bool
	PendingGeneration  int64
	Partitions         []Partition
	Assignments        []PartitionAssignment
	PendingAssignments []PartitionAssignment
	Members            []MemberSnapshot
	Committed          []PartitionOffset
}

// Snapshot returns a consistent copy of the coordinator state.
func (c *Coordinator) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()

	snapshot := Snapshot{
		Generation:  c.generation,
		Rebalancing: c.pending != nil,
		Partitions:  clonePartitions(c.partitions),
		Assignments: assignmentList(c.assignments),
		Committed:   committedList(c.committed),
	}
	if c.pending != nil {
		snapshot.PendingGeneration = c.pending.generation
		snapshot.PendingAssignments = assignmentList(c.pending.target)
	}

	memberIDs := make([]string, 0, len(c.members))
	for memberID := range c.members {
		memberIDs = append(memberIDs, memberID)
	}
	sort.Strings(memberIDs)

	for _, memberID := range memberIDs {
		member := c.members[memberID]
		view := MemberSnapshot{
			ID:             member.id,
			InstanceID:     member.instanceID,
			Generation:     member.generation,
			Assignment:     clonePartitions(member.assignment),
			Consumable:     c.consumableLocked(member),
			LastSeen:       member.lastSeen,
			SessionTimeout: member.sessionTimeout,
		}
		if c.pending != nil {
			view.Revoking = clonePartitions(c.pending.revokeFrom[memberID])
			_, view.AwaitingRevocation = c.pending.waiting[memberID]
		}
		snapshot.Members = append(snapshot.Members, view)
	}

	return snapshot
}

// Validate checks the core ownership invariants. It is intended for assertions
// in tests and for defensive checks in coordinator call sites.
func (c *Coordinator) Validate() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	seen := make(map[Partition]string, len(c.partitions))
	for _, member := range c.members {
		for _, partition := range member.assignment {
			if _, ok := c.partitionExists[partition]; !ok {
				return fmt.Errorf("rebalance: member %q has unknown partition %s", member.id, partition)
			}
			if owner, ok := seen[partition]; ok {
				return fmt.Errorf("rebalance: partition %s owned by both %q and %q", partition, owner, member.id)
			}
			seen[partition] = member.id
			if owner := c.assignments[partition]; owner != member.id {
				return fmt.Errorf("rebalance: member %q assignment disagrees with active owner %q for %s", member.id, owner, partition)
			}
		}
	}

	for partition, owner := range c.assignments {
		if _, ok := c.partitionExists[partition]; !ok {
			return fmt.Errorf("rebalance: active assignment contains unknown partition %s", partition)
		}
		member := c.members[owner]
		if member == nil {
			return fmt.Errorf("rebalance: partition %s is owned by unknown member %q", partition, owner)
		}
		if !containsPartition(member.assignment, partition) {
			return fmt.Errorf("rebalance: partition %s missing from owner %q assignment", partition, owner)
		}
		if member.generation != c.generation {
			return fmt.Errorf("rebalance: member %q generation %d, active generation %d", owner, member.generation, c.generation)
		}
	}
	if c.pending == nil {
		if len(c.members) == 0 && len(c.assignments) != 0 {
			return fmt.Errorf("rebalance: group has no members but %d active assignments", len(c.assignments))
		}
		if len(c.members) > 0 && len(c.assignments) != len(c.partitions) {
			return fmt.Errorf("rebalance: active generation covers %d/%d partitions", len(c.assignments), len(c.partitions))
		}
		for _, member := range c.members {
			if member.generation != c.generation {
				return fmt.Errorf("rebalance: member %q generation %d, active generation %d",
					member.id, member.generation, c.generation)
			}
		}
	}

	if c.pending != nil {
		if c.pending.generation <= c.generation {
			return fmt.Errorf("rebalance: pending generation %d is not after active generation %d", c.pending.generation, c.generation)
		}
		for partition, owner := range c.pending.target {
			if _, ok := c.partitionExists[partition]; !ok {
				return fmt.Errorf("rebalance: pending target contains unknown partition %s", partition)
			}
			if c.members[owner] == nil {
				return fmt.Errorf("rebalance: pending target for %s names unknown member %q", partition, owner)
			}
		}
		if len(c.members) > 0 && len(c.pending.target) != len(c.partitions) {
			return fmt.Errorf("rebalance: pending generation covers %d/%d partitions", len(c.pending.target), len(c.partitions))
		}
		for memberID := range c.pending.waiting {
			if c.members[memberID] == nil {
				return fmt.Errorf("rebalance: waiting for unknown member %q", memberID)
			}
			if len(c.pending.revokeFrom[memberID]) == 0 {
				return fmt.Errorf("rebalance: member %q is waiting but has no revocations", memberID)
			}
		}
		for memberID, partitions := range c.pending.revokeFrom {
			if c.members[memberID] == nil {
				return fmt.Errorf("rebalance: revocation from unknown member %q", memberID)
			}
			for _, partition := range partitions {
				if c.assignments[partition] != memberID {
					return fmt.Errorf("rebalance: member %q cannot revoke unowned partition %s", memberID, partition)
				}
			}
		}
	}

	return nil
}

func assignmentList(assignments map[Partition]string) []PartitionAssignment {
	result := make([]PartitionAssignment, 0, len(assignments))
	for partition, memberID := range assignments {
		result = append(result, PartitionAssignment{
			Partition: partition,
			MemberID:  memberID,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		return partitionLess(result[i].Partition, result[j].Partition)
	})
	return result
}

func committedList(committed map[Partition]int64) []PartitionOffset {
	result := make([]PartitionOffset, 0, len(committed))
	for partition, offset := range committed {
		result = append(result, PartitionOffset{
			Partition: partition,
			Offset:    offset,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		return partitionLess(result[i].Partition, result[j].Partition)
	})
	return result
}
