package dataeng

import (
	"errors"
	"fmt"
)

// FieldFact records the per-field containment evidence used in a proof.
type FieldFact struct {
	Field     string
	Contained bool
	Detail    string
}

// Proof is returned when the old domain is fully contained in the new domain.
type Proof struct {
	Contained     bool
	OldDomainSize uint64
	Checked       uint64
	FieldFacts    []FieldFact
}

// Counterexample is the minimal old-valid/new-rejected record.
type Counterexample struct {
	Record Record
	Reason string
}

// Result is either a counterexample or a containment proof.
type Result struct {
	Counterexample *Counterexample
	Proof          *Proof
}

// defaultEnumerationLimit bounds an exhaustive run; callers can override it.
const defaultEnumerationLimit = uint64(5_000_000)

// Check exhaustively proves oldSchema records remain accepted by newSchema,
// or returns the minimal rejected record under the task ordering: fewer
// present fields first, then lexicographic sorted-key sequence, then typed
// value order using the caller-provided enum ranks.
func Check(oldSchema, newSchema *Schema) (*Result, error) {
	return CheckWithLimit(oldSchema, newSchema, defaultEnumerationLimit)
}

// CheckWithLimit is Check with an explicit ceiling on enumerated records.
func CheckWithLimit(oldSchema, newSchema *Schema, limit uint64) (*Result, error) {
	if limit == 0 {
		return nil, errors.New("dataeng: enumeration limit must be positive")
	}
	oldC, err := compile(oldSchema)
	if err != nil {
		return nil, fmt.Errorf("old schema: %w", err)
	}
	newC, err := compile(newSchema)
	if err != nil {
		return nil, fmt.Errorf("new schema: %w", err)
	}
	size := oldC.domainSize()
	if size > limit {
		return nil, fmt.Errorf("dataeng: old domain size %d exceeds enumeration limit %d", size, limit)
	}

	values := oldC.buildPresentValues()
	n := len(oldC.fields)
	// Enumerate present-field count ascending; within a count, choose index
	// subsets in lexicographic order, then value tuples in lexicographic
	// order over the chosen fields. This produces exactly the requested
	// record ordering without materializing the whole domain.
	for k := 0; k <= n; k++ {
		indices := make([]int, k)
		for init := 0; init < k; init++ {
			indices[init] = init
		}
		for {
			domains := make([][]Value, k)
			for pos, idx := range indices {
				domains[pos] = values[idx]
			}
			counterexample, err := enumerateTuples(oldC, indices, domains, newC)
			if err != nil {
				return nil, err
			}
			if counterexample != nil {
				return &Result{Counterexample: counterexample}, nil
			}
			if !nextCombination(indices, n) {
				break
			}
		}
	}

	return &Result{Proof: buildProof(oldC, newC, size)}, nil
}

// enumerateTuples walks the Cartesian product of domains in lexicographic
// order using mixed radices, rebuilding a named record for each tuple.
func enumerateTuples(oldC *compiledSchema, indices []int, domains [][]Value, newC *compiledSchema) (*Counterexample, error) {
	k := len(domains)
	if k == 0 {
		empty := Record{}
		if ok, reason := newC.accept(empty); !ok {
			return &Counterexample{Record: empty, Reason: reason.Error()}, nil
		}
		return nil, nil
	}
	radices := make([]int, k)
	total := 1
	for i, d := range domains {
		if len(d) == 0 {
			return nil, errors.New("dataeng: internal error: empty field domain")
		}
		radices[i] = len(d)
		total *= radices[i]
	}
	tuple := make([]Value, k)
	for ordinal := 0; ordinal < total; ordinal++ {
		remainder := ordinal
		for i := 0; i < k; i++ {
			tuple[i] = domains[i][remainder%radices[i]]
			remainder /= radices[i]
		}
		rec := make(Record, k)
		for pos, idx := range indices {
			rec[oldC.fields[idx].Name] = tuple[pos]
		}
		if ok, reason := newC.accept(rec); !ok {
			return &Counterexample{Record: rec, Reason: reason.Error()}, nil
		}
	}
	return nil, nil
}

// nextCombination advances a sorted k-combination of [0,n), returning false
// once the lexicographically last combination has been consumed.
func nextCombination(idx []int, n int) bool {
	k := len(idx)
	i := k - 1
	for i >= 0 && idx[i] == n-k+i {
		i--
	}
	if i < 0 {
		return false
	}
	idx[i]++
	for j := i + 1; j < k; j++ {
		idx[j] = idx[j-1] + 1
	}
	return true
}

// buildPresentValues lists each field's present values in typed order:
// null first, then enum values in caller order; arrays by length then
// element-wise enum rank.
func (c *compiledSchema) buildPresentValues() [][]Value {
	out := make([][]Value, len(c.fields))
	for i, f := range c.fields {
		out[i] = c.fieldValues(f)
	}
	return out
}

func (c *compiledSchema) fieldValues(f FieldSpec) []Value {
	switch f.Kind {
	case IntegerEnum:
		values := make([]Value, 0, len(f.Enum)+1)
		if f.Nullable {
			values = append(values, NullValue())
		}
		for _, v := range f.Enum {
			values = append(values, IntValue(v))
		}
		return values
	case EnumArray:
		var values []Value
		e := len(f.Enum)
		pow := make([]int, f.MaxItems+1)
		pow[0] = 1
		for n := 1; n <= f.MaxItems; n++ {
			pow[n] = pow[n-1] * e
		}
		for length := f.MinItems; length <= f.MaxItems; length++ {
			count := pow[length]
			for ordinal := 0; ordinal < count; ordinal++ {
				elems := make([]int, length)
				remainder := ordinal
				for pos := 0; pos < length; pos++ {
					elems[pos] = f.Enum[remainder%e]
					remainder /= e
				}
				values = append(values, ArrayValue(elems...))
			}
		}
		return values
	default:
		panic(fmt.Sprintf("dataeng: unknown kind %d", f.Kind))
	}
}
