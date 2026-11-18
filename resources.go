package formal

import (
	"fmt"
	"math"
	"sort"
)

// Resource identifies a countable resource, such as "cpu" or "memory".
//
// Resource is an alias for string so callers can use ordinary string keys.
type Resource = string

// Resources is a vector of non-negative integer quantities. A missing key is
// treated as zero.
type Resources map[Resource]int64

// Clone returns an independent copy of r.
func (r Resources) Clone() Resources {
	if r == nil {
		return nil
	}
	clone := make(Resources, len(r))
	for name, amount := range r {
		clone[name] = amount
	}
	return clone
}

// Get returns the quantity of name, or zero when name is absent.
func (r Resources) Get(name Resource) int64 {
	return r[name]
}

// IsZero reports whether every quantity in r is zero.
func (r Resources) IsZero() bool {
	for _, amount := range r {
		if amount != 0 {
			return false
		}
	}
	return true
}

// Equal reports whether r and other contain the same non-zero quantities.
func (r Resources) Equal(other Resources) bool {
	return resourcesEqual(r, other)
}

// Keys returns the resource names in r sorted lexicographically.
func (r Resources) Keys() []string {
	keys := make([]string, 0, len(r))
	for name := range r {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	return keys
}

// Validate checks that every quantity is non-negative.
func (r Resources) Validate() error {
	for name, amount := range r {
		if amount < 0 {
			return fmt.Errorf("%w: resource %q has negative amount %d", ErrInvalidAmount, name, amount)
		}
	}
	return nil
}

func resourcesEqual(a, b Resources) bool {
	for name, amount := range a {
		if amount != 0 && amount != b[name] {
			return false
		}
	}
	for name, amount := range b {
		if amount != 0 && amount != a[name] {
			return false
		}
	}
	return true
}

func addResources(dst, src Resources) error {
	for name, amount := range src {
		if amount == 0 {
			continue
		}
		sum, ok := safeAdd(dst[name], amount)
		if !ok {
			return fmt.Errorf("%w: overflow adding resource %q", ErrInvalidAmount, name)
		}
		dst[name] = sum
	}
	return nil
}

func safeAdd(a, b int64) (int64, bool) {
	if b > 0 && a > math.MaxInt64-b {
		return 0, false
	}
	if b < 0 && a < math.MinInt64-b {
		return 0, false
	}
	return a + b, true
}

func saturatingAdd(a, b int64) int64 {
	if sum, ok := safeAdd(a, b); ok {
		return sum
	}
	if b > 0 {
		return math.MaxInt64
	}
	return math.MinInt64
}

// mulDiv returns floor(a*b/c) and (a*b)%c for non-negative a, b, and positive
// c. It falls back to arbitrary precision arithmetic when a*b would overflow.
func mulDiv(a, b, c int64) (int64, int64) {
	if a == 0 || b == 0 {
		return 0, 0
	}
	if a <= math.MaxInt64/b {
		product := a * b
		return product / c, product % c
	}
	return mulDivBig(a, b, c)
}
