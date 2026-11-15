package dataeng

import (
	"bytes"
	"fmt"
	"math"
	"math/big"
	"strings"
	"time"
)

// ValueKind identifies the type of a predicate literal.
type ValueKind int

const (
	ValueNull ValueKind = iota
	ValueBool
	ValueInt
	ValueFloat
	ValueString
	ValueBytes
	ValueTimestamp
	ValueDate
	ValueDecimal
)

// Value is a predicate literal. Only the field matching Kind is used.
type Value struct {
	Kind ValueKind

	Bool   bool
	Int    int64
	Float  float64
	String string
	Bytes  []byte

	// Timestamp values are stored as milliseconds since the Unix epoch plus a
	// sub-millisecond remainder in [0,999999].
	Millis int64
	Nanos  int32
}

func NullValue() Value            { return Value{Kind: ValueNull} }
func BoolValue(v bool) Value      { return Value{Kind: ValueBool, Bool: v} }
func IntValue(v int64) Value      { return Value{Kind: ValueInt, Int: v} }
func Int64Value(v int64) Value    { return IntValue(v) }
func FloatValue(v float64) Value  { return Value{Kind: ValueFloat, Float: v} }
func DoubleValue(v float64) Value { return FloatValue(v) }
func StringValue(v string) Value  { return Value{Kind: ValueString, String: v} }
func BytesValue(v []byte) Value   { return Value{Kind: ValueBytes, Bytes: append([]byte(nil), v...)} }
func DateValue(days int32) Value  { return Value{Kind: ValueDate, Int: int64(days)} }
func DecimalValue(v string) Value { return Value{Kind: ValueDecimal, String: v} }

// Short constructor aliases.
func Bool(v bool) Value           { return BoolValue(v) }
func Int(v int64) Value           { return IntValue(v) }
func Long(v int64) Value          { return IntValue(v) }
func Float(v float64) Value       { return FloatValue(v) }
func Double(v float64) Value      { return FloatValue(v) }
func Str(v string) Value          { return StringValue(v) }
func Bytes(v []byte) Value        { return BytesValue(v) }
func Date(days int32) Value       { return DateValue(days) }
func Decimal(v string) Value      { return DecimalValue(v) }
func Timestamp(t time.Time) Value { return TimestampValue(t) }

// ValueOf converts common Go scalar types into a predicate literal.
func ValueOf(v any) (Value, error) {
	switch x := v.(type) {
	case nil:
		return NullValue(), nil
	case Value:
		return x, nil
	case bool:
		return BoolValue(x), nil
	case int:
		return IntValue(int64(x)), nil
	case int8:
		return IntValue(int64(x)), nil
	case int16:
		return IntValue(int64(x)), nil
	case int32:
		return IntValue(int64(x)), nil
	case int64:
		return IntValue(x), nil
	case uint:
		return IntValue(int64(x)), nil
	case uint8:
		return IntValue(int64(x)), nil
	case uint16:
		return IntValue(int64(x)), nil
	case uint32:
		return IntValue(int64(x)), nil
	case uint64:
		if x > math.MaxInt64 {
			return Value{}, fmt.Errorf("dataeng: uint64 %d overflows int64", x)
		}
		return IntValue(int64(x)), nil
	case float32:
		return FloatValue(float64(x)), nil
	case float64:
		return FloatValue(x), nil
	case string:
		return StringValue(x), nil
	case []byte:
		return BytesValue(x), nil
	case time.Time:
		return TimestampValue(x), nil
	default:
		return Value{}, fmt.Errorf("dataeng: unsupported literal type %T", v)
	}
}

func TimestampValue(t time.Time) Value {
	p := timePoint(t)
	return Value{Kind: ValueTimestamp, Millis: p.ms, Nanos: p.ns}
}

func TimestampMillisValue(ms int64) Value {
	return Value{Kind: ValueTimestamp, Millis: ms}
}

// TimeValue is an alias for TimestampValue.
func TimeValue(t time.Time) Value { return TimestampValue(t) }

// TimestampMillis is an alias for TimestampMillisValue.
func TimestampMillis(ms int64) Value { return TimestampMillisValue(ms) }

// Time returns a time.Time for timestamp values.
func (v Value) Time() (time.Time, bool) {
	if v.Kind != ValueTimestamp {
		return time.Time{}, false
	}
	return time.UnixMilli(v.Millis).Add(time.Duration(v.Nanos) * time.Nanosecond), true
}

// IsNull reports whether the literal is SQL NULL.
func (v Value) IsNull() bool { return v.Kind == ValueNull }

// Op is a comparison operator.
type Op int

const (
	OpEqual Op = iota
	OpLess
	OpLessEqual
	OpGreater
	OpGreaterEqual
	OpIn
	OpIsNull
	OpIsNotNull
)

// Short operator aliases.
const (
	OpEq = OpEqual
	OpLt = OpLess
	OpLe = OpLessEqual
	OpGt = OpGreater
	OpGe = OpGreaterEqual
)

// Truth is a three-valued result used for safe pruning.
type Truth uint8

const (
	TruthNo Truth = iota
	TruthMaybe
	TruthYes
)

func (t Truth) CouldMatch() bool { return t != TruthNo }

func andTruth(a, b Truth) Truth {
	if a == TruthNo || b == TruthNo {
		return TruthNo
	}
	if a == TruthYes && b == TruthYes {
		return TruthYes
	}
	return TruthMaybe
}

func orTruth(a, b Truth) Truth {
	if a == TruthYes || b == TruthYes {
		return TruthYes
	}
	if a == TruthNo && b == TruthNo {
		return TruthNo
	}
	return TruthMaybe
}

func notTruth(t Truth) Truth {
	switch t {
	case TruthYes:
		return TruthNo
	case TruthNo:
		return TruthYes
	default:
		return TruthMaybe
	}
}

// Predicate is an ORC pruning predicate. The zero value matches no rows.
type Predicate struct {
	op       Op
	column   string
	values   []Value
	children []Predicate
}

func Eq(column string, v Value) Predicate {
	return Predicate{op: OpEqual, column: column, values: []Value{v}}
}
func Lt(column string, v Value) Predicate {
	return Predicate{op: OpLess, column: column, values: []Value{v}}
}
func Le(column string, v Value) Predicate {
	return Predicate{op: OpLessEqual, column: column, values: []Value{v}}
}
func Gt(column string, v Value) Predicate {
	return Predicate{op: OpGreater, column: column, values: []Value{v}}
}
func Ge(column string, v Value) Predicate {
	return Predicate{op: OpGreaterEqual, column: column, values: []Value{v}}
}
func In(column string, values ...Value) Predicate {
	return Predicate{op: OpIn, column: column, values: append([]Value(nil), values...)}
}
func IsNull(column string) Predicate    { return Predicate{op: OpIsNull, column: column} }
func IsNotNull(column string) Predicate { return Predicate{op: OpIsNotNull, column: column} }

// Descriptive aliases.
func Equal(column string, v Value) Predicate            { return Eq(column, v) }
func Less(column string, v Value) Predicate             { return Lt(column, v) }
func LessEqual(column string, v Value) Predicate        { return Le(column, v) }
func Greater(column string, v Value) Predicate          { return Gt(column, v) }
func GreaterEqual(column string, v Value) Predicate     { return Ge(column, v) }
func InValues(column string, values ...Value) Predicate { return In(column, values...) }
func NotEqual(column string, v Value) Predicate         { return Not(Eq(column, v)) }

func Range(column string, op Op, v Value) Predicate {
	return Predicate{op: op, column: column, values: []Value{v}}
}

func Between(column string, lo, hi Value) Predicate {
	return And(Ge(column, lo), Le(column, hi))
}

func And(preds ...Predicate) Predicate {
	return Predicate{op: opAnd, children: append([]Predicate(nil), preds...)}
}

func Or(preds ...Predicate) Predicate {
	return Predicate{op: opOr, children: append([]Predicate(nil), preds...)}
}

func Not(p Predicate) Predicate {
	return Predicate{op: opNot, children: []Predicate{p}}
}

const (
	opAnd = Op(-100)
	opOr  = Op(-101)
	opNot = Op(-102)
)

// Columns returns all column names referenced by the predicate.
func (p Predicate) Columns() []string {
	var out []string
	var walk func(Predicate)
	walk = func(q Predicate) {
		if q.op == opAnd || q.op == opOr {
			for _, c := range q.children {
				walk(c)
			}
			return
		}
		if q.op == opNot {
			if len(q.children) == 1 {
				walk(q.children[0])
			}
			return
		}
		if q.column != "" {
			out = append(out, q.column)
		}
	}
	walk(p)
	return out
}

func (p Predicate) String() string {
	switch p.op {
	case opAnd:
		return "and(" + predicateListString(p.children) + ")"
	case opOr:
		return "or(" + predicateListString(p.children) + ")"
	case opNot:
		if len(p.children) == 1 {
			return "not(" + p.children[0].String() + ")"
		}
		return "not()"
	case OpIsNull:
		return p.column + " is null"
	case OpIsNotNull:
		return p.column + " is not null"
	case OpIn:
		parts := make([]string, len(p.values))
		for i, v := range p.values {
			parts[i] = valueString(v)
		}
		return p.column + " in (" + strings.Join(parts, ", ") + ")"
	default:
		op := map[Op]string{OpEqual: "=", OpLess: "<", OpLessEqual: "<=", OpGreater: ">", OpGreaterEqual: ">="}[p.op]
		if len(p.values) > 0 {
			return p.column + " " + op + " " + valueString(p.values[0])
		}
		return p.column + " " + op
	}
}

func predicateListString(p []Predicate) string {
	parts := make([]string, len(p))
	for i := range p {
		parts[i] = p[i].String()
	}
	return strings.Join(parts, ", ")
}

func valueString(v Value) string {
	switch v.Kind {
	case ValueNull:
		return "null"
	case ValueBool:
		return fmt.Sprintf("%t", v.Bool)
	case ValueInt:
		return fmt.Sprintf("%d", v.Int)
	case ValueFloat:
		return fmt.Sprintf("%g", v.Float)
	case ValueString:
		return fmt.Sprintf("%q", v.String)
	case ValueBytes:
		return fmt.Sprintf("%x", v.Bytes)
	case ValueTimestamp:
		t, _ := v.Time()
		return t.UTC().Format(time.RFC3339Nano)
	case ValueDate:
		return time.Unix(v.Int*86400, 0).UTC().Format("2006-01-02")
	case ValueDecimal:
		return v.String
	default:
		return "?"
	}
}

// Evaluate performs row-level SQL evaluation. Unknown (NULL) comparisons are
// false in a WHERE clause.
func (p Predicate) Evaluate(row map[string]Value) bool {
	return p.Truth(row) == TruthYes
}

// Truth performs row-level three-valued evaluation.
func (p Predicate) Truth(row map[string]Value) Truth {
	switch p.op {
	case opAnd:
		t := TruthYes
		for _, c := range p.children {
			t = andTruth(t, c.Truth(row))
		}
		return t
	case opOr:
		t := TruthNo
		for _, c := range p.children {
			t = orTruth(t, c.Truth(row))
		}
		return t
	case opNot:
		if len(p.children) == 1 {
			return notTruth(p.children[0].Truth(row))
		}
		return TruthMaybe
	}
	v, ok := lookupRowValue(row, p.column)
	if !ok {
		return TruthMaybe
	}
	switch p.op {
	case OpIsNull:
		if v.Kind == ValueNull {
			return TruthYes
		}
		return TruthNo
	case OpIsNotNull:
		if v.Kind == ValueNull {
			return TruthNo
		}
		return TruthYes
	}
	if v.Kind == ValueNull {
		return TruthMaybe
	}
	if len(p.values) == 0 {
		return TruthNo
	}
	switch p.op {
	case OpEqual:
		if p.values[0].Kind == ValueNull {
			return TruthMaybe
		}
		cmp, ok := compareValues(v, p.values[0])
		if !ok {
			return TruthMaybe
		}
		if cmp == 0 {
			return TruthYes
		}
		return TruthNo
	case OpLess, OpLessEqual, OpGreater, OpGreaterEqual:
		if p.values[0].Kind == ValueNull {
			return TruthMaybe
		}
		cmp, ok := compareValues(v, p.values[0])
		if !ok {
			return TruthMaybe
		}
		return truthFromCmp(p.op, cmp)
	case OpIn:
		unknown := false
		for _, lit := range p.values {
			if lit.Kind == ValueNull {
				unknown = true
				continue
			}
			cmp, ok := compareValues(v, lit)
			if !ok {
				unknown = true
				continue
			}
			if cmp == 0 {
				return TruthYes
			}
		}
		if unknown {
			return TruthMaybe
		}
		return TruthNo
	}
	return TruthMaybe
}

func truthFromCmp(op Op, cmp int) Truth {
	ok := false
	switch op {
	case OpLess:
		ok = cmp < 0
	case OpLessEqual:
		ok = cmp <= 0
	case OpGreater:
		ok = cmp > 0
	case OpGreaterEqual:
		ok = cmp >= 0
	}
	if ok {
		return TruthYes
	}
	return TruthNo
}

func lookupRowValue(row map[string]Value, name string) (Value, bool) {
	if v, ok := row[name]; ok {
		return v, true
	}
	for k, v := range row {
		if strings.EqualFold(k, name) {
			return v, true
		}
	}
	return Value{}, false
}

func compareValues(a, b Value) (int, bool) {
	if a.Kind == ValueNull || b.Kind == ValueNull {
		return 0, false
	}
	switch {
	case isIntLike(a) && isIntLike(b):
		return cmpInt(a.Int, b.Int), true
	case a.Kind == ValueDecimal && b.Kind == ValueDecimal:
		return cmpDecimal(a.String, b.String)
	case isNumeric(a) && isNumeric(b):
		af, ok := numericFloat(a)
		if !ok {
			return 0, false
		}
		bf, ok := numericFloat(b)
		if !ok {
			return 0, false
		}
		return cmpFloat(af, bf)
	case a.Kind == ValueString && b.Kind == ValueString:
		return strings.Compare(a.String, b.String), true
	case a.Kind == ValueBytes && b.Kind == ValueBytes:
		return bytes.Compare(a.Bytes, b.Bytes), true
	case a.Kind == ValueTimestamp && b.Kind == ValueTimestamp:
		return timestampPoint{ms: a.Millis, ns: a.Nanos}.compare(timestampPoint{ms: b.Millis, ns: b.Nanos}), true
	case a.Kind == ValueBool && b.Kind == ValueBool:
		if a.Bool == b.Bool {
			return 0, true
		}
		if !a.Bool {
			return -1, true
		}
		return 1, true
	}
	return 0, false
}

func isIntLike(v Value) bool { return v.Kind == ValueInt || v.Kind == ValueDate }

func isNumeric(v Value) bool {
	return v.Kind == ValueInt || v.Kind == ValueFloat || v.Kind == ValueDate || v.Kind == ValueDecimal
}

func numericFloat(v Value) (float64, bool) {
	switch v.Kind {
	case ValueInt, ValueDate:
		return float64(v.Int), true
	case ValueFloat:
		if math.IsNaN(v.Float) {
			return 0, false
		}
		return v.Float, true
	case ValueDecimal:
		r, ok := new(big.Rat).SetString(v.String)
		if !ok {
			return 0, false
		}
		f, _ := r.Float64()
		return f, true
	}
	return 0, false
}

func cmpInt(a, b int64) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

func cmpFloat(a, b float64) (int, bool) {
	if math.IsNaN(a) || math.IsNaN(b) {
		return 0, false
	}
	if a < b {
		return -1, true
	}
	if a > b {
		return 1, true
	}
	return 0, true
}

func cmpDecimal(a, b string) (int, bool) {
	ar, ok := new(big.Rat).SetString(a)
	if !ok {
		return 0, false
	}
	br, ok := new(big.Rat).SetString(b)
	if !ok {
		return 0, false
	}
	return ar.Cmp(br), true
}

func coerceValue(v Value, kind ColumnKind) (Value, bool) {
	if v.Kind == ValueNull {
		return v, true
	}
	switch kind {
	case KindBoolean:
		if v.Kind == ValueBool {
			return v, true
		}
	case KindByte, KindShort, KindInt, KindLong:
		switch v.Kind {
		case ValueInt, ValueDate:
			return Value{Kind: ValueInt, Int: v.Int}, true
		case ValueFloat:
			if !math.IsNaN(v.Float) && v.Float >= math.MinInt64 && v.Float <= math.MaxInt64 && math.Trunc(v.Float) == v.Float {
				return Value{Kind: ValueInt, Int: int64(v.Float)}, true
			}
		}
	case KindFloat, KindDouble:
		switch v.Kind {
		case ValueInt, ValueDate:
			return Value{Kind: ValueFloat, Float: float64(v.Int)}, true
		case ValueFloat:
			return v, true
		}
	case KindString, KindVarchar, KindChar:
		switch v.Kind {
		case ValueString:
			return v, true
		case ValueBytes:
			return Value{Kind: ValueString, String: string(v.Bytes)}, true
		}
	case KindBinary:
		switch v.Kind {
		case ValueBytes:
			return v, true
		case ValueString:
			return Value{Kind: ValueBytes, Bytes: []byte(v.String)}, true
		}
	case KindTimestamp, KindTimestampInstant:
		switch v.Kind {
		case ValueTimestamp:
			return v, true
		case ValueInt:
			return Value{Kind: ValueTimestamp, Millis: v.Int}, true
		}
	case KindDate:
		switch v.Kind {
		case ValueDate:
			return v, true
		case ValueInt:
			return Value{Kind: ValueDate, Int: v.Int}, true
		}
	case KindDecimal:
		switch v.Kind {
		case ValueDecimal:
			return v, true
		case ValueString:
			return Value{Kind: ValueDecimal, String: v.String}, true
		case ValueInt:
			return Value{Kind: ValueDecimal, String: fmt.Sprintf("%d", v.Int)}, true
		case ValueFloat:
			if !math.IsNaN(v.Float) {
				return Value{Kind: ValueDecimal, String: fmt.Sprintf("%v", v.Float)}, true
			}
		}
	}
	return Value{}, false
}

type valueBounds struct {
	kind  ColumnKind
	hasLo bool
	hasHi bool
	lo    Value
	hi    Value
	// Timestamp bounds use a dedicated span because they may cross a DST
	// transition and therefore are not a single wall-clock millisecond.
	timestamp timestampSpan
	// Boolean stats use bucket counts rather than min/max.
	boolCounts bool
	falseCount uint64
	trueCount  uint64
}

func (b valueBounds) contains(v Value) (bool, bool) {
	if b.boolCounts {
		if v.Kind != ValueBool {
			return false, false
		}
		count := b.falseCount
		if v.Bool {
			count = b.trueCount
		}
		return count > 0, true
	}
	if v.Kind == ValueTimestamp && b.kind == KindTimestamp || v.Kind == ValueTimestamp && b.kind == KindTimestampInstant {
		p := timestampPoint{ms: v.Millis, ns: v.Nanos}
		return b.timestamp.contains(p), true
	}
	if b.hasLo {
		cmp, ok := compareValues(v, b.lo)
		if !ok {
			return false, false
		}
		if cmp < 0 {
			return false, true
		}
	}
	if b.hasHi {
		cmp, ok := compareValues(v, b.hi)
		if !ok {
			return false, false
		}
		if cmp > 0 {
			return false, true
		}
	}
	return true, true
}

func boundsForColumn(col *Column, stats *ColumnStatistics, writerVersion uint32, versionKnown bool, timezone string, mode TimestampMode) (valueBounds, bool) {
	if stats == nil {
		return valueBounds{}, false
	}
	b := valueBounds{kind: col.Kind}
	switch col.Kind {
	case KindByte, KindShort, KindInt, KindLong:
		if stats.Integer == nil {
			return b, false
		}
		s := stats.Integer
		if !s.HasMinimum && !s.HasMaximum {
			return b, false
		}
		b.hasLo, b.hasHi = s.HasMinimum, s.HasMaximum
		b.lo = Value{Kind: ValueInt, Int: s.Minimum}
		b.hi = Value{Kind: ValueInt, Int: s.Maximum}
	case KindFloat, KindDouble:
		if stats.Double == nil {
			return b, false
		}
		s := stats.Double
		if (!s.HasMinimum || !validDouble(s.Minimum)) && (!s.HasMaximum || !validDouble(s.Maximum)) {
			return b, false
		}
		b.hasLo = s.HasMinimum && validDouble(s.Minimum)
		b.hasHi = s.HasMaximum && validDouble(s.Maximum)
		b.lo = Value{Kind: ValueFloat, Float: s.Minimum}
		b.hi = Value{Kind: ValueFloat, Float: s.Maximum}
	case KindString, KindVarchar, KindChar:
		if stats.String == nil {
			return b, false
		}
		s := stats.String
		if s.HasLower {
			b.hasLo, b.lo = true, Value{Kind: ValueString, String: s.LowerBound}
		} else if s.HasMinimum {
			b.hasLo, b.lo = true, Value{Kind: ValueString, String: s.Minimum}
		}
		if s.HasUpper {
			b.hasHi, b.hi = true, Value{Kind: ValueString, String: s.UpperBound}
		} else if s.HasMaximum {
			b.hasHi, b.hi = true, Value{Kind: ValueString, String: s.Maximum}
		}
		if !b.hasLo && !b.hasHi {
			return b, false
		}
	case KindDate:
		if stats.Date == nil {
			return b, false
		}
		s := stats.Date
		if s.HasLower {
			b.hasLo, b.lo = true, Value{Kind: ValueDate, Int: int64(s.LowerBound)}
		} else if s.HasMinimum {
			b.hasLo, b.lo = true, Value{Kind: ValueDate, Int: int64(s.Minimum)}
		}
		if s.HasUpper {
			b.hasHi, b.hi = true, Value{Kind: ValueDate, Int: int64(s.UpperBound)}
		} else if s.HasMaximum {
			b.hasHi, b.hi = true, Value{Kind: ValueDate, Int: int64(s.Maximum)}
		}
		if !b.hasLo && !b.hasHi {
			return b, false
		}
	case KindTimestamp, KindTimestampInstant:
		span, ok := timestampBounds(stats.Timestamp, writerVersion, versionKnown, timezone, mode)
		if !ok {
			return b, false
		}
		b.timestamp = span
		b.lo = Value{Kind: ValueTimestamp, Millis: span.lo.ms, Nanos: span.lo.ns}
		b.hi = Value{Kind: ValueTimestamp, Millis: span.hi.ms, Nanos: span.hi.ns}
		b.hasLo, b.hasHi = true, true
	case KindBoolean:
		if stats.Bucket == nil || len(stats.Bucket.Count) < 2 {
			return b, false
		}
		b.boolCounts = true
		b.falseCount = stats.Bucket.Count[0]
		b.trueCount = stats.Bucket.Count[1]
	case KindDecimal:
		if stats.Decimal == nil {
			return b, false
		}
		s := stats.Decimal
		if s.HasMinimum {
			if _, ok := new(big.Rat).SetString(s.Minimum); !ok {
				return b, false
			}
			b.hasLo, b.lo = true, Value{Kind: ValueDecimal, String: s.Minimum}
		}
		if s.HasMaximum {
			if _, ok := new(big.Rat).SetString(s.Maximum); !ok {
				return b, false
			}
			b.hasHi, b.hi = true, Value{Kind: ValueDecimal, String: s.Maximum}
		}
		if !b.hasLo && !b.hasHi {
			return b, false
		}
	default:
		return b, false
	}
	return b, true
}

type nullInfo struct {
	known   bool
	hasNull bool
	allNull bool
}

func nullInfoFor(stats *ColumnStatistics, rowCount uint64) nullInfo {
	if stats == nil {
		return nullInfo{}
	}
	if rowCount == 0 {
		return nullInfo{known: true}
	}
	if stats.HasNumberOfValues {
		n := stats.NumberOfValues
		if n == 0 {
			if statsHasAnyTypedValue(stats) {
				// An all-NULL group should not carry value bounds. Treat an
				// inconsistency as untrusted.
				return nullInfo{}
			}
			return nullInfo{known: true, hasNull: true, allNull: true}
		}
		if n > rowCount {
			// A count larger than the row group means the statistics are
			// inconsistent; do not use them to rule out NULLs.
			return nullInfo{}
		}
		if stats.HasNullSet {
			if stats.HasNull && n == rowCount {
				return nullInfo{}
			}
			if !stats.HasNull && n < rowCount {
				return nullInfo{}
			}
		}
		if n == rowCount {
			return nullInfo{known: true}
		}
		return nullInfo{known: true, hasNull: true}
	}
	if stats.HasNullSet {
		return nullInfo{known: true, hasNull: stats.HasNull}
	}
	return nullInfo{}
}

func statsHasAnyTypedValue(s *ColumnStatistics) bool {
	return s.Integer != nil || s.Double != nil || s.String != nil ||
		s.Bucket != nil || s.Decimal != nil || s.Date != nil ||
		s.Binary != nil || s.Timestamp != nil
}

type evalGroup struct {
	reader             *Reader
	stripe             int
	column             *Column
	rowStats           *ColumnStatistics
	stripeStats        *ColumnStatistics
	nullStats          *ColumnStatistics
	aggregateNullStats *ColumnStatistics
	bloom              *BloomFilter
	bloomEncoding      uint32
	rows               uint64
}

func (r *Reader) eligibleStats(rowStats, stripeStats *ColumnStatistics, kind ColumnKind) *ColumnStatistics {
	if statsHasKind(rowStats, kind) {
		return rowStats
	}
	if statsHasKind(stripeStats, kind) {
		return stripeStats
	}
	if rowStats != nil {
		return rowStats
	}
	return stripeStats
}

func statsHasKind(s *ColumnStatistics, kind ColumnKind) bool {
	if s == nil {
		return false
	}
	switch kind {
	case KindByte, KindShort, KindInt, KindLong:
		return s.Integer != nil
	case KindFloat, KindDouble:
		return s.Double != nil
	case KindString, KindVarchar, KindChar:
		return s.String != nil
	case KindDate:
		return s.Date != nil
	case KindTimestamp, KindTimestampInstant:
		return s.Timestamp != nil
	case KindBoolean:
		return s.Bucket != nil
	case KindDecimal:
		return s.Decimal != nil
	}
	return false
}

func (r *Reader) evalLeaf(g evalGroup, op Op, values []Value) Truth {
	rowCount := g.rows
	ninfo := nullInfoFor(g.nullStats, rowCount)
	if !ninfo.known {
		ninfo = nullInfoFor(g.aggregateNullStats, rowCount)
	}

	switch op {
	case OpIsNull:
		if ninfo.known {
			if ninfo.allNull {
				return TruthYes
			}
			if !ninfo.hasNull {
				return TruthNo
			}
		}
		return TruthMaybe
	case OpIsNotNull:
		if ninfo.known {
			if ninfo.allNull {
				return TruthNo
			}
			if !ninfo.hasNull {
				return TruthYes
			}
		}
		return TruthMaybe
	}

	if rowCount == 0 || ninfo.allNull {
		return TruthNo
	}
	if len(values) == 0 {
		return TruthNo
	}
	if op == OpIn {
		result := TruthNo
		for _, v := range values {
			t := r.evalLeaf(g, OpEqual, []Value{v})
			if t == TruthYes {
				return TruthYes
			}
			if t == TruthMaybe {
				result = TruthMaybe
			}
		}
		return result
	}
	target, ok := coerceValue(values[0], g.column.Kind)
	if !ok {
		return TruthMaybe
	}
	if target.Kind == ValueNull {
		return TruthNo
	}

	stats := r.eligibleStats(g.rowStats, g.stripeStats, g.column.Kind)
	bounds, haveBounds := boundsForColumn(g.column, stats, r.ps.WriterVersion, r.ps.HasWriterVersion, r.stripeTimezone(g.stripe), r.opts.TimestampMode)
	if !haveBounds && stats != g.stripeStats && g.stripeStats != nil {
		bounds, haveBounds = boundsForColumn(g.column, g.stripeStats, r.ps.WriterVersion, r.ps.HasWriterVersion, r.stripeTimezone(g.stripe), r.opts.TimestampMode)
	}
	if haveBounds && isStringKind(g.column.Kind) {
		// Java's string comparison is UTF-16 code-unit order, which can differ
		// from Go's byte order for non-ASCII text. Do not use string bounds for
		// pruning in that case.
		if valueHasNonASCII(target) || boundsHaveNonASCII(bounds) {
			haveBounds = false
		}
	}

	if r.opts.DisableBloomFilters == false && g.bloom != nil && g.bloom.Trusted() && (op == OpEqual) {
		if !r.bloomMightContain(g, target) {
			return TruthNo
		}
	}

	if !haveBounds {
		return TruthMaybe
	}

	if op == OpEqual {
		inside, comparable := bounds.contains(target)
		if comparable && !inside {
			return TruthNo
		}
		if comparable && inside && bounds.hasLo && bounds.hasHi && ninfo.known && !ninfo.hasNull {
			loCmp, ok1 := compareValues(target, bounds.lo)
			hiCmp, ok2 := compareValues(target, bounds.hi)
			if ok1 && ok2 && loCmp == 0 && hiCmp == 0 {
				return TruthYes
			}
		}
		return TruthMaybe
	}

	okCmp, comparable := boundsCompareToOp(bounds, op, target)
	if !comparable {
		return TruthMaybe
	}
	switch okCmp {
	case -1: // definitely outside
		return TruthNo
	case 1: // definitely inside for every non-null row
		if ninfo.known && !ninfo.hasNull {
			return TruthYes
		}
		return TruthMaybe
	default:
		return TruthMaybe
	}
}

func isStringKind(k ColumnKind) bool {
	return k == KindString || k == KindVarchar || k == KindChar
}

func valueHasNonASCII(v Value) bool {
	if v.Kind != ValueString {
		return false
	}
	for i := 0; i < len(v.String); i++ {
		if v.String[i] >= 0x80 {
			return true
		}
	}
	return false
}

func boundsHaveNonASCII(b valueBounds) bool {
	return valueHasNonASCII(b.lo) || valueHasNonASCII(b.hi)
}

// boundsCompareToOp returns -1 if no value in bounds satisfies op, 1 if every
// value in bounds satisfies it, and 0 if the result depends on the row.
func boundsCompareToOp(b valueBounds, op Op, target Value) (int, bool) {
	if b.boolCounts {
		// Boolean ranges are uncommon; use the endpoints.
		if !b.hasLo && !b.hasHi {
			return 0, false
		}
	}
	lo, hi := b.lo, b.hi
	hasLo, hasHi := b.hasLo, b.hasHi
	if b.boolCounts {
		hasLo, hasHi = true, true
		lo = Value{Kind: ValueBool, Bool: false}
		hi = Value{Kind: ValueBool, Bool: true}
	}
	switch op {
	case OpLess:
		if hasLo {
			cmp, ok := compareValues(lo, target)
			if !ok {
				return 0, false
			}
			if cmp >= 0 {
				return -1, true
			}
		}
		if hasHi {
			cmp, ok := compareValues(hi, target)
			if !ok {
				return 0, false
			}
			if cmp < 0 {
				return 1, true
			}
		}
	case OpLessEqual:
		if hasLo {
			cmp, ok := compareValues(lo, target)
			if !ok {
				return 0, false
			}
			if cmp > 0 {
				return -1, true
			}
		}
		if hasHi {
			cmp, ok := compareValues(hi, target)
			if !ok {
				return 0, false
			}
			if cmp <= 0 {
				return 1, true
			}
		}
	case OpGreater:
		if hasHi {
			cmp, ok := compareValues(hi, target)
			if !ok {
				return 0, false
			}
			if cmp <= 0 {
				return -1, true
			}
		}
		if hasLo {
			cmp, ok := compareValues(lo, target)
			if !ok {
				return 0, false
			}
			if cmp > 0 {
				return 1, true
			}
		}
	case OpGreaterEqual:
		if hasHi {
			cmp, ok := compareValues(hi, target)
			if !ok {
				return 0, false
			}
			if cmp < 0 {
				return -1, true
			}
		}
		if hasLo {
			cmp, ok := compareValues(lo, target)
			if !ok {
				return 0, false
			}
			if cmp >= 0 {
				return 1, true
			}
		}
	}
	return 0, true
}

func (r *Reader) stripeTimezone(stripe int) string {
	if stripe < 0 || stripe >= len(r.stripes) {
		return ""
	}
	return r.stripes[stripe].WriterTimezone
}

func (r *Reader) bloomMightContain(g evalGroup, target Value) bool {
	if g.bloom == nil || !g.bloom.Trusted() {
		return true
	}
	switch g.column.Kind {
	case KindByte, KindShort, KindInt, KindLong:
		if target.Kind == ValueInt {
			return g.bloom.MightContainLong(target.Int)
		}
	case KindFloat, KindDouble:
		if target.Kind == ValueFloat {
			return g.bloom.MightContainDouble(target.Float)
		}
	case KindString, KindVarchar, KindChar:
		if target.Kind == ValueString {
			return g.bloom.MightContainString(target.String)
		}
	case KindBinary:
		if target.Kind == ValueBytes {
			return g.bloom.MightContainBytes(target.Bytes)
		}
	case KindDate:
		if target.Kind == ValueDate {
			return g.bloom.MightContainLong(target.Int)
		}
	case KindTimestamp, KindTimestampInstant:
		if target.Kind == ValueTimestamp {
			return r.bloomMightContainTimestamp(g, target)
		}
	case KindDecimal, KindBoolean:
		// ORC does not have a stable cross-version bloom-filter encoding for
		// these types. A false miss would be unsafe, so keep them may-match.
		return true
	}
	return true
}

func (r *Reader) bloomMightContainTimestamp(g evalGroup, target Value) bool {
	ms := target.Millis
	if g.bloom.MightContainLong(ms) || g.bloom.MightContainLong(ms/1000) {
		return true
	}
	loc, err := loadWriterTimezone(r.stripeTimezone(g.stripe))
	if err != nil && (!r.ps.HasWriterVersion || r.ps.WriterVersion < writerVersionORC135) {
		// Legacy timestamp bloom filters hash local wall-clock values. Without
		// the writer timezone we cannot safely conclude absence.
		return true
	}
	if err == nil {
		for _, off := range offsetsAroundInstant(ms, loc) {
			wall := ms + int64(off)*1000
			if g.bloom.MightContainLong(wall) {
				return true
			}
			if g.bloom.MightContainLong(wall / 1000) {
				return true
			}
			if g.bloom.MightContainLong(wall - orc2015EpochMillis) {
				return true
			}
			if g.bloom.MightContainLong((wall - orc2015EpochMillis) / 1000) {
				return true
			}
		}
	}
	// Some legacy writers hash the value relative to ORC's 2015 epoch.
	if g.bloom.MightContainLong(ms-orc2015EpochMillis) || g.bloom.MightContainLong((ms-orc2015EpochMillis)/1000) {
		return true
	}
	return false
}

func offsetsAroundInstant(ms int64, loc *time.Location) []int {
	seen := map[int]struct{}{}
	var out []int
	add := func(t int64) {
		_, off := time.UnixMilli(t).In(loc).Zone()
		if _, ok := seen[off]; !ok {
			seen[off] = struct{}{}
			out = append(out, off)
		}
	}
	for d := int64(-3 * 24 * time.Hour / time.Millisecond); d <= int64(3*24*time.Hour/time.Millisecond); d += int64(6 * time.Hour / time.Millisecond) {
		add(ms + d)
	}
	for d := int64(-200 * 24 * time.Hour / time.Millisecond); d <= int64(200*24*time.Hour/time.Millisecond); d += int64(7 * 24 * time.Hour / time.Millisecond) {
		add(ms + d)
	}
	return out
}
