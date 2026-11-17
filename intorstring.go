package formal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Type describes how an IntOrString value is interpreted.
type Type uint8

const (
	// IntType is an absolute replica count.
	IntType Type = iota
	// PercentType is an integer percentage of the desired replica count.
	PercentType
)

// IntOrString is a replica limit that is either an absolute count or an
// integer percentage. It deliberately mirrors the useful part of Kubernetes'
// intstr.IntOrString without taking a dependency on Kubernetes.
type IntOrString struct {
	Type  Type
	Value int
}

// Int returns an absolute replica limit.
func Int(n int) IntOrString {
	return IntOrString{Type: IntType, Value: n}
}

// Percent returns a percentage replica limit. Percentages must be integers.
func Percent(n int) IntOrString {
	return IntOrString{Type: PercentType, Value: n}
}

// ParseIntOrString parses either "3" or "25%".
func ParseIntOrString(s string) (IntOrString, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return IntOrString{}, fmt.Errorf("empty replica limit")
	}
	if strings.HasSuffix(s, "%") {
		number := strings.TrimSpace(strings.TrimSuffix(s, "%"))
		n, err := strconv.Atoi(number)
		if err != nil {
			return IntOrString{}, fmt.Errorf("invalid percentage %q: %w", s, err)
		}
		v := Percent(n)
		if err := v.Validate(); err != nil {
			return IntOrString{}, err
		}
		return v, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return IntOrString{}, fmt.Errorf("invalid replica limit %q: %w", s, err)
	}
	v := Int(n)
	if err := v.Validate(); err != nil {
		return IntOrString{}, err
	}
	return v, nil
}

// Validate checks that the value has a known type and is non-negative.
func (v IntOrString) Validate() error {
	switch v.Type {
	case IntType, PercentType:
	default:
		return fmt.Errorf("unknown replica-limit type %d", v.Type)
	}
	if v.Value < 0 {
		return fmt.Errorf("replica limit must not be negative: %d", v.Value)
	}
	if v.Value > math.MaxInt32 {
		return fmt.Errorf("replica limit is too large: %d", v.Value)
	}
	return nil
}

// String renders the value using Kubernetes' usual notation.
func (v IntOrString) String() string {
	switch v.Type {
	case PercentType:
		return strconv.Itoa(v.Value) + "%"
	default:
		return strconv.Itoa(v.Value)
	}
}

// MarshalJSON encodes an absolute value as a number and a percentage as a
// string, matching Kubernetes API conventions.
func (v IntOrString) MarshalJSON() ([]byte, error) {
	if err := v.Validate(); err != nil {
		return nil, err
	}
	if v.Type == PercentType {
		return json.Marshal(v.String())
	}
	return []byte(strconv.Itoa(v.Value)), nil
}

// UnmarshalJSON accepts both "3" / 3 and "25%" / "25".
func (v *IntOrString) UnmarshalJSON(data []byte) error {
	if v == nil {
		return fmt.Errorf("cannot unmarshal into a nil IntOrString")
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return fmt.Errorf("empty replica limit")
	}
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(trimmed, &s); err != nil {
			return err
		}
		parsed, err := ParseIntOrString(s)
		if err != nil {
			return err
		}
		*v = parsed
		return nil
	}
	parsed, err := ParseIntOrString(string(trimmed))
	if err != nil {
		return err
	}
	*v = parsed
	return nil
}

func (v IntOrString) isZero() bool {
	return v.Value == 0
}

// resolve converts the limit to a replica count. maxSurge resolves with
// roundUp=true and maxUnavailable with roundUp=false.
func (v IntOrString) resolve(replicas int, roundUp bool) (int, error) {
	if err := v.Validate(); err != nil {
		return 0, err
	}
	if replicas < 0 {
		return 0, fmt.Errorf("replica count must not be negative: %d", replicas)
	}
	if v.Type == IntType {
		return v.Value, nil
	}

	// Both operands are bounded by MaxInt32, so the int64 product cannot
	// overflow. Integer arithmetic also avoids floating point boundary bugs.
	product := int64(replicas) * int64(v.Value)
	if roundUp {
		product = (product + 99) / 100
	} else {
		product /= 100
	}
	if product > int64(math.MaxInt) {
		return 0, fmt.Errorf("resolved replica count is too large: %d", product)
	}
	return int(product), nil
}
