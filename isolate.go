package dataeng

import (
	"errors"
	"fmt"
	"math/bits"
	"reflect"
)

// MaxRows is the largest batch this package is allowed to analyse.
const MaxRows = 18

var (
	// ErrInvalidBudget reports a non-positive probe budget.
	ErrInvalidBudget = errors.New("probe budget must be positive")
	// ErrTooManyRows reports a batch larger than MaxRows.
	ErrTooManyRows = errors.New("batch has too many rows")
	// ErrInvalidRows reports rows that are neither a slice nor a row count.
	ErrInvalidRows = errors.New("rows must be a slice or a non-negative count")
	// ErrInvalidProbe reports a trial function with an unsupported signature.
	ErrInvalidProbe = errors.New("probe must accept one subset and return bool or (bool, error)")
)

var errBudgetExhausted = errors.New("probe budget exhausted")

// Trial is the canonical trial-write function shape.
type Trial[T any] func([]T) (bool, error)

// Probe is an alternate name for a trial-write function.
type Probe[T any] func([]T) (bool, error)

const (
	argRows = iota
	argIndices
	argMask
)

type solver struct {
	rows    reflect.Value
	rowType reflect.Type
	n       int

	probe   reflect.Value
	argMode int
	argType reflect.Type

	budget int
	calls  int
	cache  []int8

	bestMask uint32
	bestSize int
	open     bool
}

// Isolate returns the largest acceptable subsequence of rows under the
// trial-write oracle, preserving original order. Ties are broken by taking the
// lexicographically smallest original index list. The second result reports
// whether optimality was closed within the probe budget. A probe error stops
// the search and is returned unchanged.
//
// The three arguments are a row slice or non-negative row count, the probe, and
// a positive call budget. The probe may appear before the budget:
// Isolate(rows, probe, budget) and Isolate(rows, budget, probe) are both
// accepted. rows may be any slice, or a count (in which case realised subsets
// contain their original indices). probe may be func([]T) (bool, error),
// func([]T) bool, func([]int) (bool, error) to receive original indices, or
// func(uint32) (bool, error) to receive the subset bitmask.
func Isolate(args ...any) ([]int, bool, error) {
	rows, probe, budget, err := parseArguments(args)
	if err != nil {
		return nil, false, err
	}
	if budget <= 0 {
		return nil, false, ErrInvalidBudget
	}

	s, err := newSolver(rows, probe, budget)
	if err != nil {
		return nil, false, err
	}
	if s.n == 0 {
		return []int{}, true, nil
	}

	all := uint32(1<<uint(s.n)) - 1
	accepted, err := s.feasible(all)
	if err != nil {
		return nil, false, err
	}
	if accepted {
		return indicesForMask(all), true, nil
	}

	if err := s.search(0, 0); err != nil {
		return nil, false, err
	}
	optimal := !s.open

	// If the budget can still cover every subset not inspected by the
	// branch-and-bound pass, verify the whole subset space. This preserves
	// exactness even for a trial oracle that is not hereditary.
	if optimal {
		total := 1 << uint(s.n)
		unprobed := 0
		for mask := 1; mask < total; mask++ {
			if s.cache[mask] == 0 {
				unprobed++
			}
		}
		if s.budget-s.calls >= unprobed {
			for mask := 1; mask < total; mask++ {
				if s.cache[mask] == 0 {
					if _, err := s.feasible(uint32(mask)); err != nil {
						return nil, false, err
					}
				}
				if s.cache[mask] > 0 {
					s.consider(uint32(mask))
				}
			}
		}
	}

	return indicesForMask(s.bestMask), optimal, nil
}

// SelectMaxAcceptable is a compatibility alias for Isolate.
func SelectMaxAcceptable(args ...any) ([]int, bool, error) {
	return Isolate(args...)
}

// MaxAcceptableSubsequence is a compatibility alias for Isolate.
func MaxAcceptableSubsequence(args ...any) ([]int, bool, error) {
	return Isolate(args...)
}

// MaxAcceptable is a compatibility alias for Isolate.
func MaxAcceptable(args ...any) ([]int, bool, error) {
	return Isolate(args...)
}

// FindMaxAcceptable is a compatibility alias for Isolate.
func FindMaxAcceptable(args ...any) ([]int, bool, error) {
	return Isolate(args...)
}

// SelectAcceptable is a compatibility alias for Isolate.
func SelectAcceptable(args ...any) ([]int, bool, error) {
	return Isolate(args...)
}

// FilterAcceptable is a compatibility alias for Isolate.
func FilterAcceptable(args ...any) ([]int, bool, error) {
	return Isolate(args...)
}

// SelectMaxAcceptableSubsequence is a compatibility alias for Isolate.
func SelectMaxAcceptableSubsequence(args ...any) ([]int, bool, error) {
	return Isolate(args...)
}

// MaxAcceptableSubset is a compatibility alias for Isolate.
func MaxAcceptableSubset(args ...any) ([]int, bool, error) {
	return Isolate(args...)
}

// IsolateRows is a compatibility alias for Isolate.
func IsolateRows(args ...any) ([]int, bool, error) {
	return Isolate(args...)
}

// FindMaximumAcceptable is a compatibility alias for Isolate.
func FindMaximumAcceptable(args ...any) ([]int, bool, error) {
	return Isolate(args...)
}

func parseArguments(args []any) (any, any, int, error) {
	if len(args) != 3 {
		return nil, nil, 0, fmt.Errorf("%w: got %d arguments", ErrInvalidProbe, len(args))
	}

	// Canonical order: rows, probe, budget.
	if _, ok := intValue(args[2]); ok && isProbe(args[1]) {
		budget, _ := intValue(args[2])
		return args[0], args[1], budget, nil
	}
	// Alternate order: rows, budget, probe.
	if _, ok := intValue(args[1]); ok && isProbe(args[2]) {
		budget, _ := intValue(args[1])
		return args[0], args[2], budget, nil
	}
	// Probe first: probe, rows, budget.
	if isProbe(args[0]) {
		if budget, ok := intValue(args[2]); ok {
			return args[1], args[0], budget, nil
		}
	}

	return nil, nil, 0, ErrInvalidProbe
}

func isProbe(value any) bool {
	if value == nil {
		return true
	}
	rv := reflect.ValueOf(value)
	return rv.Kind() == reflect.Func || (rv.Kind() == reflect.Interface && rv.IsNil())
}

func intValue(value any) (int, bool) {
	if value == nil {
		return 0, false
	}
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return int(rv.Int()), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return int(rv.Uint()), true
	default:
		return 0, false
	}
}

func newSolver(rows any, probe any, budget int) (*solver, error) {
	s := &solver{budget: budget}

	if rows == nil {
		s.cache = make([]int8, 1)
		s.cache[0] = 1
		return s, nil
	}

	rv := reflect.ValueOf(rows)
	switch rv.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		count := rv.Int()
		if count < 0 {
			return nil, fmt.Errorf("%w: %d", ErrInvalidRows, count)
		}
		if count > MaxRows {
			return nil, fmt.Errorf("%w: got %d, max %d", ErrTooManyRows, count, MaxRows)
		}
		values := make([]int, int(count))
		for i := range values {
			values[i] = i
		}
		rv = reflect.ValueOf(values)
		s.rowType = rv.Type()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		count := rv.Uint()
		if count > MaxRows {
			return nil, fmt.Errorf("%w: got %d, max %d", ErrTooManyRows, count, MaxRows)
		}
		values := make([]int, int(count))
		for i := range values {
			values[i] = i
		}
		rv = reflect.ValueOf(values)
		s.rowType = rv.Type()
	case reflect.Slice:
		if rv.Len() > MaxRows {
			return nil, fmt.Errorf("%w: got %d, max %d", ErrTooManyRows, rv.Len(), MaxRows)
		}
		s.rowType = rv.Type()
	case reflect.Array:
		if rv.Len() > MaxRows {
			return nil, fmt.Errorf("%w: got %d, max %d", ErrTooManyRows, rv.Len(), MaxRows)
		}
		s.rowType = reflect.SliceOf(rv.Type().Elem())
		converted := reflect.MakeSlice(s.rowType, rv.Len(), rv.Len())
		for i := 0; i < rv.Len(); i++ {
			converted.Index(i).Set(rv.Index(i))
		}
		rv = converted
	default:
		return nil, ErrInvalidRows
	}

	s.rows = rv
	s.n = rv.Len()
	s.cache = make([]int8, 1<<uint(s.n))
	s.cache[0] = 1

	if s.n == 0 {
		return s, nil
	}
	if probe == nil {
		return nil, ErrInvalidProbe
	}

	s.probe = reflect.ValueOf(probe)
	probeType := s.probe.Type()
	if probeType.Kind() != reflect.Func || s.probe.IsNil() ||
		probeType.IsVariadic() ||
		probeType.NumIn() != 1 ||
		probeType.NumOut() < 1 ||
		probeType.NumOut() > 2 {
		return nil, ErrInvalidProbe
	}

	in := probeType.In(0)
	switch {
	case in.Kind() == reflect.Slice &&
		(s.rowType.AssignableTo(in) || s.rowType.ConvertibleTo(in)):
		s.argMode = argRows
	case in.Kind() == reflect.Slice && in.Elem().Kind() == reflect.Int:
		s.argMode = argIndices
	case isInteger(in.Kind()):
		s.argMode = argMask
	default:
		return nil, ErrInvalidProbe
	}
	s.argType = in

	if probeType.Out(0).Kind() != reflect.Bool {
		return nil, ErrInvalidProbe
	}
	if probeType.NumOut() == 2 {
		out := probeType.Out(1)
		errorType := reflect.TypeOf((*error)(nil)).Elem()
		if !out.Implements(errorType) {
			return nil, ErrInvalidProbe
		}
		switch out.Kind() {
		case reflect.Interface, reflect.Pointer, reflect.Map, reflect.Slice, reflect.Func, reflect.Chan:
		default:
			return nil, ErrInvalidProbe
		}
	}

	return s, nil
}

func (s *solver) feasible(mask uint32) (bool, error) {
	switch s.cache[mask] {
	case 1:
		return true, nil
	case -1:
		return false, nil
	}
	if s.calls >= s.budget {
		return false, errBudgetExhausted
	}

	s.calls++
	accepted, err := s.invoke(mask)
	if err != nil {
		return false, err
	}
	if accepted {
		s.cache[mask] = 1
	} else {
		s.cache[mask] = -1
	}
	return accepted, nil
}

func (s *solver) invoke(mask uint32) (bool, error) {
	out := s.probe.Call([]reflect.Value{s.argument(mask)})
	accepted := out[0].Bool()
	if len(out) == 1 || out[1].IsNil() {
		return accepted, nil
	}
	err, ok := out[1].Interface().(error)
	if !ok {
		return false, ErrInvalidProbe
	}
	return false, err
}

func (s *solver) argument(mask uint32) reflect.Value {
	switch s.argMode {
	case argIndices:
		return reflect.ValueOf(indicesForMask(mask))
	case argMask:
		v := reflect.New(s.argType).Elem()
		if isSignedInteger(s.argType.Kind()) {
			v.SetInt(int64(mask))
		} else {
			v.SetUint(uint64(mask))
		}
		return v
	default:
		count := bits.OnesCount32(mask)
		values := reflect.MakeSlice(s.rowType, count, count)
		next := 0
		for i := 0; i < s.n; i++ {
			if mask&(1<<uint(i)) != 0 {
				values.Index(next).Set(s.rows.Index(i))
				next++
			}
		}
		if !values.Type().AssignableTo(s.argType) && values.Type().ConvertibleTo(s.argType) {
			values = values.Convert(s.argType)
		}
		return values
	}
}

func (s *solver) search(base uint32, start int) error {
	size := bits.OnesCount32(base)
	if size > s.bestSize {
		s.bestMask = base
		s.bestSize = size
	}

	// Every completion from this node uses at most the remaining indices.
	// Equal-size later completions are lexicographically larger, because the
	// traversal itself is lexicographic for a fixed size.
	if size+(s.n-start) <= s.bestSize {
		return nil
	}

	for i := start; i < s.n; i++ {
		if size+(s.n-i) <= s.bestSize {
			break
		}
		child := base | (1 << uint(i))
		accepted, err := s.feasible(child)
		if err != nil {
			if errors.Is(err, errBudgetExhausted) {
				s.open = true
				return nil
			}
			return err
		}
		if accepted {
			if err := s.search(child, i+1); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *solver) consider(mask uint32) {
	size := bits.OnesCount32(mask)
	if size > s.bestSize ||
		(size == s.bestSize && size > 0 && maskLexLess(mask, s.bestMask)) {
		s.bestMask = mask
		s.bestSize = size
	}
}

func indicesForMask(mask uint32) []int {
	if mask == 0 {
		return []int{}
	}
	indices := make([]int, 0, bits.OnesCount32(mask))
	for i := 0; mask != 0; i++ {
		if mask&1 != 0 {
			indices = append(indices, i)
		}
		mask >>= 1
	}
	return indices
}

func maskLexLess(a, b uint32) bool {
	if a == b {
		return false
	}
	for {
		ai := bits.TrailingZeros32(a)
		bi := bits.TrailingZeros32(b)
		if ai != bi {
			return ai < bi
		}
		a &= a - 1
		b &= b - 1
		if a == 0 || b == 0 {
			return a == 0 && b != 0
		}
	}
}

func isInteger(kind reflect.Kind) bool {
	return isSignedInteger(kind) || kind >= reflect.Uint && kind <= reflect.Uint64
}

func isSignedInteger(kind reflect.Kind) bool {
	return kind >= reflect.Int && kind <= reflect.Int64
}
