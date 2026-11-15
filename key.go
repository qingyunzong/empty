package dataeng

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"sort"
	"strings"
	"time"
)

// Value is one value in a primary-key tuple. A nil Value represents SQL NULL.
// The concrete types understood by the comparators are:
//
//	integers (signed and unsigned), float32/float64, json.Number,
//	*big.Int, *big.Rat, *big.Float, string, []byte, bool, and time.Time.
//
// Other types cause ErrIncomparable instead of being compared by their Go
// representation, which would not match any database ordering.
type Value = any

// Tuple is a composite primary-key value. Its length must match the number of
// KeyColumns passed to CompareTuples.
type Tuple []Value

// Kind describes the database type of a key column. KindAny accepts any of the
// supported Go representations.
type Kind uint8

const (
	KindAny Kind = iota
	KindBool
	KindInt
	KindUint
	KindFloat
	KindString
	KindBytes
	KindTime
)

func (k Kind) String() string {
	switch k {
	case KindAny:
		return "any"
	case KindBool:
		return "bool"
	case KindInt:
		return "int"
	case KindUint:
		return "uint"
	case KindFloat:
		return "float"
	case KindString:
		return "string"
	case KindBytes:
		return "bytes"
	case KindTime:
		return "time"
	default:
		return fmt.Sprintf("Kind(%d)", uint8(k))
	}
}

// NullOrder controls where NULLs appear independently of the direction of the
// column. NullsLast is the zero value because it is the PostgreSQL default for
// ascending indexes.
type NullOrder uint8

const (
	NullsLast NullOrder = iota
	NullsFirst
)

func (n NullOrder) String() string {
	if n == NullsFirst {
		return "NULLS FIRST"
	}
	return "NULLS LAST"
}

// Collation compares strings the same way the database does. Name must be the
// SQL collation name (for example "en_US" or "NOCASE"). An empty name means the
// database's default collation; in that case callers must still provide a
// comparator that matches that default.
type Collation interface {
	Compare(a, b string) int
	Name() string
}

// BinaryCollation compares strings byte-for-byte. Its empty SQL name leaves the
// database default in place, so use it only when the column's database collation
// is binary as well.
type BinaryCollation struct{}

func (BinaryCollation) Compare(a, b string) int { return strings.Compare(a, b) }
func (BinaryCollation) Name() string            { return "" }

// NamedCollation is a Collation backed by a function. A nil Cmp function
// falls back to strings.Compare.
type NamedCollation struct {
	SQLName string
	Cmp     func(a, b string) int
}

func (c NamedCollation) Name() string { return c.SQLName }

func (c NamedCollation) Compare(a, b string) int {
	if c.Cmp == nil {
		return strings.Compare(a, b)
	}
	return c.Cmp(a, b)
}

// KeyColumn describes one column of a primary key in the exact order the
// database uses for its primary-key index.
type KeyColumn struct {
	Name      string
	Kind      Kind
	Desc      bool
	Nulls     NullOrder
	Collation Collation
}

// IsNull reports whether v represents SQL NULL. Typed nil pointers, maps,
// slices and interfaces are also treated as NULL. A nil []byte is NULL.
func IsNull(v Value) bool {
	if v == nil {
		return true
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map,
		reflect.Pointer, reflect.Slice:
		return rv.IsNil()
	default:
		return false
	}
}

// CompareValues compares one column value using the column's direction,
// NULL ordering and string collation.
func CompareValues(a, b Value, col KeyColumn) (int, error) {
	aNull, bNull := IsNull(a), IsNull(b)
	if aNull || bNull {
		switch {
		case aNull && bNull:
			return 0, nil
		case aNull:
			if col.Nulls == NullsFirst {
				return -1, nil
			}
			return 1, nil
		default:
			if col.Nulls == NullsFirst {
				return 1, nil
			}
			return -1, nil
		}
	}

	cmp, err := compareNonNull(a, b, col)
	if err != nil {
		return 0, err
	}
	if col.Desc {
		cmp = -cmp
	}
	return cmp, nil
}

// CompareTuples compares two complete keys lexicographically.
func CompareTuples(a, b Tuple, cols []KeyColumn) (int, error) {
	if len(cols) == 0 {
		return 0, fmt.Errorf("%w: no key columns", ErrInvalidKey)
	}
	if len(a) != len(cols) || len(b) != len(cols) {
		return 0, fmt.Errorf("%w: got tuple lengths %d and %d, want %d",
			ErrInvalidKey, len(a), len(b), len(cols))
	}
	for i, col := range cols {
		cmp, err := CompareValues(a[i], b[i], col)
		if err != nil {
			return 0, fmt.Errorf("compare column %q: %w", col.Name, err)
		}
		if cmp != 0 {
			return cmp, nil
		}
	}
	return 0, nil
}

// SortTuples sorts tuples in the order described by cols. The sort is stable.
func SortTuples(rows []Tuple, cols []KeyColumn) error {
	var firstErr error
	sort.SliceStable(rows, func(i, j int) bool {
		if firstErr != nil {
			return false
		}
		cmp, err := CompareTuples(rows[i], rows[j], cols)
		if err != nil {
			firstErr = err
			return false
		}
		return cmp < 0
	})
	return firstErr
}

// FormatTuple returns a compact diagnostic representation of a key.
func FormatTuple(t Tuple) string {
	if t == nil {
		return "<unbounded>"
	}
	parts := make([]string, len(t))
	for i, v := range t {
		switch x := v.(type) {
		case nil:
			parts[i] = "NULL"
		case string:
			parts[i] = fmt.Sprintf("%q", x)
		case []byte:
			parts[i] = fmt.Sprintf("%x", x)
		default:
			parts[i] = fmt.Sprint(x)
		}
	}
	return "(" + strings.Join(parts, ", ") + ")"
}

func compareNonNull(a, b Value, col KeyColumn) (int, error) {
	if col.Kind != KindAny {
		if ac, ok := classify(a); !ok || !kindAccepts(col.Kind, ac) {
			return 0, fmt.Errorf("%w: column %q expects %s, got %T",
				ErrIncomparable, col.Name, col.Kind, a)
		}
		if bc, ok := classify(b); !ok || !kindAccepts(col.Kind, bc) {
			return 0, fmt.Errorf("%w: column %q expects %s, got %T",
				ErrIncomparable, col.Name, col.Kind, b)
		}
	}

	an, aIsNum := toNumber(a)
	bn, bIsNum := toNumber(b)
	if aIsNum || bIsNum {
		if !aIsNum || !bIsNum {
			return 0, fmt.Errorf("%w: column %q compares numeric %T with non-numeric %T",
				ErrIncomparable, col.Name, a, b)
		}
		return compareNumbers(an, bn)
	}

	switch av := a.(type) {
	case string:
		bv, ok := b.(string)
		if !ok {
			return 0, fmt.Errorf("%w: column %q compares string with %T",
				ErrIncomparable, col.Name, b)
		}
		if col.Collation != nil {
			return sign(col.Collation.Compare(av, bv)), nil
		}
		return strings.Compare(av, bv), nil

	case []byte:
		bv, ok := b.([]byte)
		if !ok {
			return 0, fmt.Errorf("%w: column %q compares []byte with %T",
				ErrIncomparable, col.Name, b)
		}
		return bytes.Compare(av, bv), nil

	case bool:
		bv, ok := b.(bool)
		if !ok {
			return 0, fmt.Errorf("%w: column %q compares bool with %T",
				ErrIncomparable, col.Name, b)
		}
		switch {
		case av == bv:
			return 0, nil
		case !av:
			return -1, nil
		default:
			return 1, nil
		}

	case time.Time:
		bv, ok := b.(time.Time)
		if !ok {
			return 0, fmt.Errorf("%w: column %q compares time.Time with %T",
				ErrIncomparable, col.Name, b)
		}
		switch {
		case av.Before(bv):
			return -1, nil
		case av.After(bv):
			return 1, nil
		default:
			return 0, nil
		}

	default:
		return 0, fmt.Errorf("%w: column %q has unsupported Go type %T",
			ErrIncomparable, col.Name, a)
	}
}

func classify(v Value) (Kind, bool) {
	switch v.(type) {
	case bool:
		return KindBool, true
	case int, int8, int16, int32, int64, *big.Int:
		return KindInt, true
	case uint, uint8, uint16, uint32, uint64, uintptr:
		return KindUint, true
	case float32, float64, json.Number, *big.Rat, *big.Float:
		return KindFloat, true
	case string:
		return KindString, true
	case []byte:
		return KindBytes, true
	case time.Time:
		return KindTime, true
	default:
		return KindAny, false
	}
}

func kindAccepts(want, got Kind) bool {
	if want == got {
		return true
	}
	if want == KindFloat {
		return got == KindInt || got == KindUint
	}
	return false
}

type number struct {
	rat *big.Rat
	inf int // -1 or +1 for infinities, 0 otherwise
	nan bool
}

func toNumber(v Value) (number, bool) {
	switch x := v.(type) {
	case int:
		return exactRat(new(big.Int).SetInt64(int64(x))), true
	case int8:
		return exactRat(big.NewInt(int64(x))), true
	case int16:
		return exactRat(big.NewInt(int64(x))), true
	case int32:
		return exactRat(big.NewInt(int64(x))), true
	case int64:
		return exactRat(big.NewInt(x)), true
	case uint:
		return exactRat(new(big.Int).SetUint64(uint64(x))), true
	case uint8:
		return exactRat(new(big.Int).SetUint64(uint64(x))), true
	case uint16:
		return exactRat(new(big.Int).SetUint64(uint64(x))), true
	case uint32:
		return exactRat(new(big.Int).SetUint64(uint64(x))), true
	case uint64:
		return exactRat(new(big.Int).SetUint64(x)), true
	case uintptr:
		return exactRat(new(big.Int).SetUint64(uint64(x))), true
	case *big.Int:
		if x == nil {
			return number{}, false
		}
		return exactRat(new(big.Int).Set(x)), true
	case *big.Rat:
		if x == nil {
			return number{}, false
		}
		return ratNumber(new(big.Rat).Set(x)), true
	case *big.Float:
		if x == nil {
			return number{}, false
		}
		if x.IsInf() {
			if x.Sign() < 0 {
				return number{inf: -1}, true
			}
			return number{inf: 1}, true
		}
		rat, _ := x.Rat(nil)
		if rat == nil {
			return number{}, false
		}
		return ratNumber(rat), true
	case float32:
		return floatNumber(float64(x), 32), true
	case float64:
		return floatNumber(x, 64), true
	case json.Number:
		rat, ok := new(big.Rat).SetString(string(x))
		if !ok {
			return number{}, false
		}
		return ratNumber(rat), true
	default:
		return number{}, false
	}
}

func floatNumber(f float64, bits int) number {
	switch {
	case math.IsNaN(f):
		return number{nan: true}
	case math.IsInf(f, -1):
		return number{inf: -1}
	case math.IsInf(f, 1):
		return number{inf: 1}
	default:
		// Rat.SetFloat64 is exact for a finite float64. For float32 the
		// value has already been widened exactly.
		return ratNumber(new(big.Rat).SetFloat64(f))
	}
}

func exactRat(i *big.Int) number {
	r := new(big.Rat)
	r.SetInt(i)
	return ratNumber(r)
}

func ratNumber(r *big.Rat) number {
	return number{rat: r}
}

func compareNumbers(a, b number) (int, error) {
	if a.nan || b.nan {
		return 0, fmt.Errorf("%w: NaN has no database ordering", ErrNaN)
	}
	if a.inf != 0 || b.inf != 0 {
		switch {
		case a.inf == b.inf:
			return 0, nil
		case a.inf < b.inf:
			return -1, nil
		default:
			return 1, nil
		}
	}
	return a.rat.Cmp(b.rat), nil
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	default:
		return 0
	}
}

var (
	// ErrInvalidKey reports a malformed key description or tuple.
	ErrInvalidKey = errors.New("dataeng: invalid key")
	// ErrIncomparable reports values whose ordering cannot be represented.
	ErrIncomparable = errors.New("dataeng: incomparable values")
	// ErrNaN reports NaN, which has no total order in SQL.
	ErrNaN = errors.New("dataeng: NaN cannot be used as a key value")
)
