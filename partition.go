package formal

import (
	"fmt"
	"sort"
)

// Partition identifies one partition of a topic.
type Partition struct {
	Topic string
	ID    int32
}

func (p Partition) String() string {
	if p.Topic == "" {
		return fmt.Sprintf("%d", p.ID)
	}
	return fmt.Sprintf("%s/%d", p.Topic, p.ID)
}

// Partitions builds a partition list for a topic. It is a convenience helper
// for callers that do not need to construct Partition values by hand.
func Partitions(topic string, ids ...int32) []Partition {
	partitions := make([]Partition, len(ids))
	for i, id := range ids {
		partitions[i] = Partition{Topic: topic, ID: id}
	}
	return partitions
}

func partitionLess(a, b Partition) bool {
	if a.Topic != b.Topic {
		return a.Topic < b.Topic
	}
	return a.ID < b.ID
}

func sortPartitions(partitions []Partition) {
	sort.Slice(partitions, func(i, j int) bool {
		return partitionLess(partitions[i], partitions[j])
	})
}

func clonePartitions(partitions []Partition) []Partition {
	if len(partitions) == 0 {
		return nil
	}
	return append([]Partition(nil), partitions...)
}

func containsPartition(partitions []Partition, wanted Partition) bool {
	for _, partition := range partitions {
		if partition == wanted {
			return true
		}
	}
	return false
}
