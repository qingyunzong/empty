package telemcodec

import (
	"math/rand"
	"reflect"
	"testing"
)

type writeOp struct {
	kind  Kind
	width int
	u     uint64
	s     int64
}

// randomFrame builds a random descriptor plus the exact write operations
// that produce its stream, so codec and interpreter decode identical bytes.
func randomFrame(rng *rand.Rand) ([]Field, []writeOp) {
	var fields []Field
	var ops []writeOp
	type cand struct {
		name  string
		value uint64
	}
	var cands []cand
	idx := 0
	next := func() string { n := "f" + itoa(idx); idx++; return n }

	addScalar := func(depth int) {
		choice := rng.Intn(6)
		name := next()
		switch choice {
		case 0, 1: // unsigned fixed width 1..17
			w := 1 + rng.Intn(17)
			v := uint64(rng.Int63()) & mask64(w)
			fields = append(fields, Field{Name: name, Kind: KindUint, Width: w})
			ops = append(ops, writeOp{kind: KindUint, width: w, u: v})
			cands = append(cands, cand{name, v})
		case 2: // signed fixed width 1..17
			w := 1 + rng.Intn(17)
			min := -(int64(1) << uint(w-1))
			max := (int64(1) << uint(w-1)) - 1
			v := min + rng.Int63n(max-min+1)
			fields = append(fields, Field{Name: name, Kind: KindInt, Width: w})
			ops = append(ops, writeOp{kind: KindInt, width: w, s: v})
		case 3: // uvarint
			var v uint64
			switch rng.Intn(3) {
			case 0:
				v = uint64(rng.Intn(300))
			case 1:
				v = uint64(rng.Int63()) & mask64(32)
			default:
				v = uint64(rng.Int63())<<1 | uint64(rng.Intn(2))
			}
			fields = append(fields, Field{Name: name, Kind: KindUvarint})
			ops = append(ops, writeOp{kind: KindUvarint, u: v})
			cands = append(cands, cand{name, v})
		case 4: // zigzag varint
			v := rng.Int63()
			if rng.Intn(2) == 0 {
				v = -v
			}
			fields = append(fields, Field{Name: name, Kind: KindVarint})
			ops = append(ops, writeOp{kind: KindVarint, s: v})
		case 5: // alignment padding
			fields = append(fields, Field{Name: name, Kind: KindAlign})
			ops = append(ops, writeOp{kind: KindAlign})
		}
	}

	n := 1 + rng.Intn(7)
	for i := 0; i < n; i++ {
		// Occasionally insert a length-referenced field.
		if len(cands) > 0 && rng.Intn(4) == 0 {
			c := cands[rng.Intn(len(cands))]
			mul := 1 + rng.Intn(3)
			if c.value*uint64(mul) <= 64 {
				w := int(c.value) * mul
				v := uint64(rng.Int63()) & mask64(w)
				name := next()
				fields = append(fields, Field{Name: name, Kind: KindUint, LenRef: c.name, LenMul: mul})
				ops = append(ops, writeOp{kind: KindUint, width: w, u: v})
				continue
			}
		}
		// Occasionally nest a sub-structure (one level).
		if rng.Intn(5) == 0 {
			subFields := []Field{}
			subOps := []writeOp{}
			savedFields, savedOps := fields, ops
			fields, ops = subFields, subOps
			m := 1 + rng.Intn(3)
			for j := 0; j < m; j++ {
				addScalar(1)
			}
			subFields, subOps = fields, ops
			fields, ops = savedFields, savedOps
			fields = append(fields, Field{Name: next(), Kind: KindStruct, Sub: subFields})
			ops = append(ops, subOps...)
			continue
		}
		addScalar(0)
	}
	return fields, ops
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [8]byte
	p := len(b)
	for i > 0 {
		p--
		b[p] = byte('0' + i%10)
		i /= 10
	}
	return string(b[p:])
}

func encodeOps(t *testing.T, order BitOrder, ops []writeOp) []byte {
	t.Helper()
	wr := NewBitWriter(order)
	for i, op := range ops {
		var err error
		switch op.kind {
		case KindUint:
			err = wr.WriteBits(op.u, op.width)
		case KindInt:
			err = wr.WriteSigned(op.s, op.width)
		case KindUvarint:
			err = wr.WriteUvarint(op.u)
		case KindVarint:
			err = wr.WriteVarint(op.s)
		case KindAlign:
			wr.Align()
		}
		if err != nil {
			t.Fatalf("order=%d op %d %+v: %v", order, i, op, err)
		}
	}
	return wr.Bytes()
}

// The descriptor-driven codec and the independent interpreter must agree on
// every value and every original bit range, for both bit orders.
func TestRandomizedCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for iter := 0; iter < 500; iter++ {
		order := orders[rng.Intn(2)]
		fields, ops := randomFrame(rng)
		data := encodeOps(t, order, ops)

		var sink []Entry
		if err := ReadStruct(NewBitReaderBytes(data, order), fields, &sink); err != nil {
			t.Fatalf("iter=%d order=%d ReadStruct: %v\nfields=%+v", iter, order, err, fields)
		}
		ref, err := Interpret(data, order, fields)
		if err != nil {
			t.Fatalf("iter=%d order=%d Interpret: %v\nfields=%+v", iter, order, err, fields)
		}
		if !reflect.DeepEqual(sink, ref) {
			t.Fatalf("iter=%d order=%d mismatch\nfields=%+v\n codec: %+v\ninterp: %+v",
				iter, order, fields, sink, ref)
		}
		// Ranges must be contiguous and cover the stream exactly.
		var pos int64
		for _, e := range sink {
			if e.Start != pos {
				t.Fatalf("iter=%d order=%d gap before %+v (pos=%d)", iter, order, e, pos)
			}
			pos = e.End
		}
	}
}
