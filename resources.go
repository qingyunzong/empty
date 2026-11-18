package formal

import (
	"fmt"
	"sort"
	"strings"
)

// Vector is a multi-dimensional resource vector. Resource quantities are
// integer units (for example millicores or MiB) so that shares can be compared
// exactly. All public constructors copy vectors and never retain caller-owned
// maps.
type Vector map[string]int64

// ResourceVector and Resources are descriptive aliases for Vector.
type ResourceVector = Vector
type Resources = Vector

// Clone returns an independent copy of v.
func (v Vector) Clone() Vector {
	out := make(Vector, len(v))
	for name, amount := range v {
		out[name] = amount
	}
	return out
}

// Add returns v + other without modifying either operand.
func (v Vector) Add(other Vector) Vector {
	out := v.Clone()
	for name, amount := range other {
		out[name] += amount
	}
	return out
}

// Sub returns v - other without modifying either operand.
func (v Vector) Sub(other Vector) Vector {
	out := v.Clone()
	for name, amount := range other {
		out[name] -= amount
	}
	return out
}

// Mul returns v scaled by n without modifying v.
func (v Vector) Mul(n int64) Vector {
	out := make(Vector, len(v))
	for name, amount := range v {
		out[name] = amount * n
	}
	return out
}

// Fits reports whether every component of v fits within capacity.
func (v Vector) Fits(capacity Vector) bool {
	for name, amount := range v {
		if amount < 0 || amount > capacity[name] {
			return false
		}
	}
	return true
}

// Covers reports whether v covers every component of other.
func (v Vector) Covers(other Vector) bool {
	for name, amount := range other {
		if v[name] < amount {
			return false
		}
	}
	return true
}

// IsZero reports whether every component of v is zero.
func (v Vector) IsZero() bool {
	for _, amount := range v {
		if amount != 0 {
			return false
		}
	}
	return true
}

// Equal reports whether v and other contain the same resources.
func (v Vector) Equal(other Vector) bool {
	for name, amount := range v {
		if other[name] != amount {
			return false
		}
	}
	for name, amount := range other {
		if v[name] != amount {
			return false
		}
	}
	return true
}

// Names returns the resource names in sorted order.
func (v Vector) Names() []string {
	names := make([]string, 0, len(v))
	for name := range v {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// String renders a vector deterministically.
func (v Vector) String() string {
	parts := make([]string, 0, len(v))
	for _, name := range v.Names() {
		parts = append(parts, fmt.Sprintf("%s=%d", name, v[name]))
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func (v Vector) addInPlace(other Vector) {
	for name, amount := range other {
		v[name] += amount
	}
}

func (v Vector) subInPlace(other Vector) {
	for name, amount := range other {
		v[name] -= amount
	}
}

func (v Vector) nonNegative() bool {
	for _, amount := range v {
		if amount < 0 {
			return false
		}
	}
	return true
}

func validateCapacity(capacity Vector) error {
	if len(capacity) == 0 {
		return fmt.Errorf("%w: at least one resource is required", ErrInvalidCapacity)
	}
	for name, amount := range capacity {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("%w: resource name must not be empty", ErrInvalidCapacity)
		}
		if amount < 0 {
			return fmt.Errorf("%w: resource %q has negative capacity %d", ErrInvalidCapacity, name, amount)
		}
	}
	return nil
}

func validateDemand(demand, capacity Vector) error {
	if len(demand) == 0 {
		return fmt.Errorf("%w: task demand must not be empty", ErrInvalidTask)
	}
	for name, amount := range demand {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("%w: resource name must not be empty", ErrInvalidTask)
		}
		if amount < 0 {
			return fmt.Errorf("%w: resource %q has negative demand %d", ErrInvalidTask, name, amount)
		}
		if _, ok := capacity[name]; !ok {
			return fmt.Errorf("%w: resource %q is not part of the cluster capacity", ErrInvalidTask, name)
		}
	}
	return nil
}
