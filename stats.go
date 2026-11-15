package dataeng

import (
	"fmt"
	"math"
	"strconv"
)

// ColumnStatistics is the subset of ORC's ColumnStatistics message needed for
// pruning. Pointers are nil when the corresponding statistics message was not
// present in the file. Presence matters: a missing bound is not the same as a
// zero bound.
type ColumnStatistics struct {
	NumberOfValues    uint64
	HasNumberOfValues bool

	Integer   *IntegerStatistics
	Double    *DoubleStatistics
	String    *StringStatistics
	Bucket    *BucketStatistics
	Decimal   *DecimalStatistics
	Date      *DateStatistics
	Binary    *BinaryStatistics
	Timestamp *TimestampStatistics

	HasNull    bool
	HasNullSet bool
}

type IntegerStatistics struct {
	Minimum    int64
	Maximum    int64
	Sum        int64
	HasMinimum bool
	HasMaximum bool
	HasSum     bool
}

type DoubleStatistics struct {
	Minimum    float64
	Maximum    float64
	Sum        float64
	HasMinimum bool
	HasMaximum bool
	HasSum     bool
}

type StringStatistics struct {
	Minimum    string
	Maximum    string
	Sum        int64
	LowerBound string
	UpperBound string
	HasMinimum bool
	HasMaximum bool
	HasSum     bool
	HasLower   bool
	HasUpper   bool
}

type BucketStatistics struct {
	Count []uint64
}

type DecimalStatistics struct {
	Minimum    string
	Maximum    string
	Sum        string
	HasMinimum bool
	HasMaximum bool
	HasSum     bool
}

type DateStatistics struct {
	Minimum    int32
	Maximum    int32
	LowerBound int32
	UpperBound int32
	HasMinimum bool
	HasMaximum bool
	HasLower   bool
	HasUpper   bool
}

type BinaryStatistics struct {
	Sum    int64
	HasSum bool
}

// TimestampStatistics stores ORC's timestamp statistics. Minimum/Maximum are in
// milliseconds. For files written before ORC-135 they are local wall-clock
// values; MinimumUTC/MaximumUTC are UTC values written by newer writers.
type TimestampStatistics struct {
	Minimum    int64
	Maximum    int64
	MinimumUTC int64
	MaximumUTC int64

	MinimumNanos uint32
	MaximumNanos uint32

	LowerBound int64
	UpperBound int64

	HasMinimum      bool
	HasMaximum      bool
	HasMinimumUTC   bool
	HasMaximumUTC   bool
	HasMinimumNanos bool
	HasMaximumNanos bool
	HasLower        bool
	HasUpper        bool
}

func parseColumnStatistics(b []byte) (*ColumnStatistics, error) {
	p := newProtoReader(b)
	out := &ColumnStatistics{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		switch field {
		case 1:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: column numberOfValues has wire type %d", wire)
			}
			out.NumberOfValues, err = p.varint()
			out.HasNumberOfValues = true
		case 2:
			var sub []byte
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: intStatistics has wire type %d", wire)
			}
			sub, err = p.bytes()
			if err == nil {
				out.Integer, err = parseIntStatistics(sub)
			}
		case 3:
			var sub []byte
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: doubleStatistics has wire type %d", wire)
			}
			sub, err = p.bytes()
			if err == nil {
				out.Double, err = parseDoubleStatistics(sub)
			}
		case 4:
			var sub []byte
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: stringStatistics has wire type %d", wire)
			}
			sub, err = p.bytes()
			if err == nil {
				out.String, err = parseStringStatistics(sub)
			}
		case 5:
			var sub []byte
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: bucketStatistics has wire type %d", wire)
			}
			sub, err = p.bytes()
			if err == nil {
				out.Bucket, err = parseBucketStatistics(sub)
			}
		case 6:
			var sub []byte
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: decimalStatistics has wire type %d", wire)
			}
			sub, err = p.bytes()
			if err == nil {
				out.Decimal, err = parseDecimalStatistics(sub)
			}
		case 7:
			var sub []byte
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: dateStatistics has wire type %d", wire)
			}
			sub, err = p.bytes()
			if err == nil {
				out.Date, err = parseDateStatistics(sub)
			}
		case 8:
			var sub []byte
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: binaryStatistics has wire type %d", wire)
			}
			sub, err = p.bytes()
			if err == nil {
				out.Binary, err = parseBinaryStatistics(sub)
			}
		case 9:
			var sub []byte
			if wire != wireBytes {
				return nil, fmt.Errorf("dataeng: timestampStatistics has wire type %d", wire)
			}
			sub, err = p.bytes()
			if err == nil {
				out.Timestamp, err = parseTimestampStatistics(sub)
			}
		case 10:
			if wire != wireVarint {
				return nil, fmt.Errorf("dataeng: column hasNull has wire type %d", wire)
			}
			var v uint64
			v, err = p.varint()
			out.HasNull = v != 0
			out.HasNullSet = true
		default:
			err = p.skip(wire)
		}
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

func parseIntStatistics(b []byte) (*IntegerStatistics, error) {
	p := newProtoReader(b)
	out := &IntegerStatistics{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		if wire != wireVarint {
			if err := p.skip(wire); err != nil {
				return nil, err
			}
			continue
		}
		v, err := p.svarint()
		if err != nil {
			return nil, err
		}
		switch field {
		case 1:
			out.Minimum, out.HasMinimum = v, true
		case 2:
			out.Maximum, out.HasMaximum = v, true
		case 3:
			out.Sum, out.HasSum = v, true
		}
	}
	return out, nil
}

func parseDoubleStatistics(b []byte) (*DoubleStatistics, error) {
	p := newProtoReader(b)
	out := &DoubleStatistics{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		if wire != wireFixed64 {
			if err := p.skip(wire); err != nil {
				return nil, err
			}
			continue
		}
		v, err := p.double()
		if err != nil {
			return nil, err
		}
		switch field {
		case 1:
			out.Minimum, out.HasMinimum = v, true
		case 2:
			out.Maximum, out.HasMaximum = v, true
		case 3:
			out.Sum, out.HasSum = v, true
		}
	}
	return out, nil
}

func parseStringStatistics(b []byte) (*StringStatistics, error) {
	p := newProtoReader(b)
	out := &StringStatistics{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		switch field {
		case 1, 2, 4, 5:
			if wire != wireBytes {
				if err := p.skip(wire); err != nil {
					return nil, err
				}
				continue
			}
			s, err := p.string()
			if err != nil {
				return nil, err
			}
			switch field {
			case 1:
				out.Minimum, out.HasMinimum = s, true
			case 2:
				out.Maximum, out.HasMaximum = s, true
			case 4:
				out.LowerBound, out.HasLower = s, true
			case 5:
				out.UpperBound, out.HasUpper = s, true
			}
		case 3:
			if wire != wireVarint {
				if err := p.skip(wire); err != nil {
					return nil, err
				}
				continue
			}
			v, err := p.svarint()
			if err != nil {
				return nil, err
			}
			out.Sum, out.HasSum = v, true
		default:
			if err := p.skip(wire); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

func parseBucketStatistics(b []byte) (*BucketStatistics, error) {
	p := newProtoReader(b)
	out := &BucketStatistics{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		if field != 1 {
			if err := p.skip(wire); err != nil {
				return nil, err
			}
			continue
		}
		switch wire {
		case wireVarint:
			v, err := p.varint()
			if err != nil {
				return nil, err
			}
			out.Count = append(out.Count, v)
		case wireBytes:
			vs, err := p.packedUvarints()
			if err != nil {
				return nil, err
			}
			out.Count = append(out.Count, vs...)
		default:
			return nil, fmt.Errorf("dataeng: bucket count has wire type %d", wire)
		}
	}
	return out, nil
}

func parseDecimalStatistics(b []byte) (*DecimalStatistics, error) {
	p := newProtoReader(b)
	out := &DecimalStatistics{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		if wire != wireBytes {
			if err := p.skip(wire); err != nil {
				return nil, err
			}
			continue
		}
		s, err := p.string()
		if err != nil {
			return nil, err
		}
		switch field {
		case 1:
			out.Minimum, out.HasMinimum = s, true
		case 2:
			out.Maximum, out.HasMaximum = s, true
		case 3:
			out.Sum, out.HasSum = s, true
		}
	}
	return out, nil
}

func parseDateStatistics(b []byte) (*DateStatistics, error) {
	p := newProtoReader(b)
	out := &DateStatistics{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		if wire != wireVarint {
			if err := p.skip(wire); err != nil {
				return nil, err
			}
			continue
		}
		v, err := p.svarint()
		if err != nil {
			return nil, err
		}
		switch field {
		case 1:
			out.Minimum, out.HasMinimum = int32(v), true
		case 2:
			out.Maximum, out.HasMaximum = int32(v), true
		case 3:
			out.LowerBound, out.HasLower = int32(v), true
		case 4:
			out.UpperBound, out.HasUpper = int32(v), true
		}
	}
	return out, nil
}

func parseBinaryStatistics(b []byte) (*BinaryStatistics, error) {
	p := newProtoReader(b)
	out := &BinaryStatistics{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		if field == 1 && wire == wireVarint {
			v, err := p.svarint()
			if err != nil {
				return nil, err
			}
			out.Sum, out.HasSum = v, true
		} else if err := p.skip(wire); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func parseTimestampStatistics(b []byte) (*TimestampStatistics, error) {
	p := newProtoReader(b)
	out := &TimestampStatistics{}
	for !p.eof() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		if wire != wireVarint {
			if err := p.skip(wire); err != nil {
				return nil, err
			}
			continue
		}
		switch field {
		case 1, 2, 3, 4, 7, 8:
			v, err := p.svarint()
			if err != nil {
				return nil, err
			}
			switch field {
			case 1:
				out.Minimum, out.HasMinimum = v, true
			case 2:
				out.Maximum, out.HasMaximum = v, true
			case 3:
				out.MinimumUTC, out.HasMinimumUTC = v, true
			case 4:
				out.MaximumUTC, out.HasMaximumUTC = v, true
			case 7:
				out.LowerBound, out.HasLower = v, true
			case 8:
				out.UpperBound, out.HasUpper = v, true
			}
		case 5:
			v, err := p.varint()
			if err != nil {
				return nil, err
			}
			out.MinimumNanos, out.HasMinimumNanos = uint32(v), true
		case 6:
			v, err := p.varint()
			if err != nil {
				return nil, err
			}
			out.MaximumNanos, out.HasMaximumNanos = uint32(v), true
		}
	}
	return out, nil
}

func validDouble(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func decimalFloat(s string) (float64, bool) {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || !validDouble(v) {
		return 0, false
	}
	return v, true
}
