package dataeng

import (
	"reflect"
)

// Predicate is a partition predicate used to prune data files.  It must return
// true whenever the partition could contain matching rows.  Implementations are
// allowed to be conservative: a false negative would silently lose rows, while
// a false positive only costs I/O.
type Predicate interface {
	MatchPartition(spec *PartitionSpec, partition Partition) bool
}

// PredicateFunc adapts a function to Predicate.
type PredicateFunc func(spec *PartitionSpec, partition Partition) bool

// MatchPartition implements Predicate.
func (f PredicateFunc) MatchPartition(spec *PartitionSpec, partition Partition) bool {
	if f == nil {
		return true
	}
	return f(spec, partition)
}

// All selects every partition.
func All() Predicate {
	return PredicateFunc(func(*PartitionSpec, Partition) bool { return true })
}

// None selects no partition.  It is useful for metadata-only checks.
func None() Predicate {
	return PredicateFunc(func(*PartitionSpec, Partition) bool { return false })
}

// PartitionEquals selects partitions whose named field equals value.
func PartitionEquals(field string, value any) Predicate {
	return PredicateFunc(func(_ *PartitionSpec, partition Partition) bool {
		return valuesEqual(partition[field], value)
	})
}

// PartitionIn selects partitions whose named field is one of values.
func PartitionIn(field string, values ...any) Predicate {
	return PredicateFunc(func(_ *PartitionSpec, partition Partition) bool {
		got := partition[field]
		for _, want := range values {
			if valuesEqual(got, want) {
				return true
			}
		}
		return false
	})
}

// And combines predicates and short-circuits on the first false result.
func And(predicates ...Predicate) Predicate {
	return PredicateFunc(func(spec *PartitionSpec, partition Partition) bool {
		for _, p := range predicates {
			if p == nil {
				continue
			}
			if !p.MatchPartition(spec, partition) {
				return false
			}
		}
		return true
	})
}

// Or combines predicates and short-circuits on the first true result.
func Or(predicates ...Predicate) Predicate {
	return PredicateFunc(func(spec *PartitionSpec, partition Partition) bool {
		for _, p := range predicates {
			if p == nil {
				continue
			}
			if p.MatchPartition(spec, partition) {
				return true
			}
		}
		return false
	})
}

// Not negates a predicate.
func Not(predicate Predicate) Predicate {
	return PredicateFunc(func(spec *PartitionSpec, partition Partition) bool {
		if predicate == nil {
			return false
		}
		return !predicate.MatchPartition(spec, partition)
	})
}

// NormalizePredicate accepts the convenient forms used by callers and returns a
// Predicate.  Unknown or nil values mean "do not prune".
func NormalizePredicate(value any) Predicate {
	switch p := value.(type) {
	case nil:
		return nil
	case Predicate:
		return p
	case func(*PartitionSpec, Partition) bool:
		return PredicateFunc(p)
	case func(Partition) bool:
		if p == nil {
			return nil
		}
		return PredicateFunc(func(_ *PartitionSpec, partition Partition) bool {
			return p(partition)
		})
	case map[string]any:
		if len(p) == 0 {
			return nil
		}
		parts := make([]Predicate, 0, len(p))
		for name, want := range p {
			parts = append(parts, PartitionEquals(name, want))
		}
		return And(parts...)
	default:
		return nil
	}
}

// DataFileMatches applies a partition predicate to a data file.  A missing spec
// or an unpartitioned spec cannot be pruned, so such files are always retained.
func DataFileMatches(file *DataFile, spec *PartitionSpec, predicate Predicate) bool {
	if predicate == nil || file == nil {
		return true
	}
	if spec == nil || spec.IsUnpartitioned() {
		return true
	}
	partition := file.PartitionFor(spec)
	if len(partition) == 0 {
		// Missing partition metadata is not proof that the file cannot match.
		return true
	}
	return predicate.MatchPartition(spec, partition)
}

// DeleteMayMatchData reports whether a delete file's partition scope can
// contain rows from the data file.  This function is intentionally biased
// toward true: partition-spec evolution must not cause a delete file to be
// dropped merely because the two files were written under different specs.
func DeleteMayMatchData(dataFile *DataFile, dataSpec *PartitionSpec, deleteFile *DataFile, deleteSpec *PartitionSpec) bool {
	if dataFile == nil || deleteFile == nil {
		return false
	}

	// File-scoped deletion vectors and position deletes name their target.
	if deleteFile.ReferencedDataFile != "" {
		return deleteFile.ReferencedDataFile == dataFile.FilePath
	}

	// Equality deletes written under an unpartitioned spec are global.  An
	// unpartitioned position delete also carries explicit file paths and cannot
	// be ruled out from partition metadata alone.
	if deleteSpec == nil || deleteSpec.IsUnpartitioned() {
		return true
	}
	if dataSpec == nil || dataSpec.IsUnpartitioned() {
		// A partitioned delete may still address an unpartitioned data file
		// after a partition-spec change.  Keep it rather than risk a false
		// negative.
		return true
	}

	if dataSpec.SpecID != deleteSpec.SpecID && !structurallyEquivalentSpecs(dataSpec, deleteSpec) {
		// Comparing tuples from different partition layouts is not generally
		// valid.  The planner keeps the delete and lets the reader evaluate it.
		return true
	}

	dataPartition := dataFile.PartitionFor(dataSpec)
	deletePartition := deleteFile.PartitionFor(deleteSpec)
	return partitionsEqual(dataSpec, dataPartition, deleteSpec, deletePartition)
}

func structurallyEquivalentSpecs(a, b *PartitionSpec) bool {
	if a == nil || b == nil {
		return a == b
	}
	if len(a.Fields) != len(b.Fields) {
		return false
	}
	for i := range a.Fields {
		af, bf := a.Fields[i], b.Fields[i]
		if af.SourceID != bf.SourceID || af.Name != bf.Name || af.Transform != bf.Transform {
			return false
		}
	}
	return true
}

func partitionsEqual(aSpec *PartitionSpec, a Partition, bSpec *PartitionSpec, b Partition) bool {
	fields := partitionFieldNames(aSpec, bSpec)
	if len(fields) == 0 {
		return true
	}
	for _, name := range fields {
		if !valuesEqual(a[name], b[name]) {
			return false
		}
	}
	return true
}

func partitionFieldNames(specs ...*PartitionSpec) []string {
	seen := make(map[string]struct{})
	var names []string
	for _, spec := range specs {
		if spec == nil {
			continue
		}
		for _, f := range spec.Fields {
			if f.Transform == TransformVoid {
				continue
			}
			if _, ok := seen[f.Name]; ok {
				continue
			}
			seen[f.Name] = struct{}{}
			names = append(names, f.Name)
		}
	}
	return names
}

func valuesEqual(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if af, ok := numericValue(a); ok {
		if bf, ok := numericValue(b); ok {
			return af == bf
		}
	}
	return reflect.DeepEqual(a, b)
}

func numericValue(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int8:
		return float64(n), true
	case int16:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint:
		return float64(n), true
	case uint8:
		return float64(n), true
	case uint16:
		return float64(n), true
	case uint32:
		return float64(n), true
	case uint64:
		return float64(n), true
	case float32:
		return float64(n), true
	case float64:
		return n, true
	default:
		return 0, false
	}
}
