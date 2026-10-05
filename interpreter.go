package telemcodec

import "fmt"

// Interpret is an independent descriptor interpreter used to cross-check
// ReadStruct. It deliberately shares no code with BitReader: it walks a raw
// byte slice bit by bit and resolves field widths, sign extension, varints
// and alignment on its own, returning entries with original bit ranges.
func Interpret(data []byte, order BitOrder, fields []Field) ([]Entry, error) {
	ip := &interp{data: data, order: order}
	out := []Entry{}
	if err := ip.run(fields, map[string]uint64{}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

type interp struct {
	data  []byte
	order BitOrder
	pos   int64
}

func (ip *interp) bit(p int64) (uint64, error) {
	if p < 0 || p >= int64(len(ip.data))*8 {
		return 0, ErrTruncated
	}
	b := ip.data[p>>3]
	if ip.order == MSBFirst {
		return uint64(b>>(7-uint(p&7))) & 1, nil
	}
	return uint64(b>>uint(p&7)) & 1, nil
}

func (ip *interp) take(n int) (uint64, error) {
	if n < 0 || n > 64 {
		return 0, ErrInvalid
	}
	if ip.pos+int64(n) > int64(len(ip.data))*8 {
		return 0, ErrTruncated
	}
	var v uint64
	for k := 0; k < n; k++ {
		bit, err := ip.bit(ip.pos + int64(k))
		if err != nil {
			return 0, err
		}
		if ip.order == MSBFirst {
			v = v<<1 | bit
		} else {
			v |= bit << uint(k)
		}
	}
	ip.pos += int64(n)
	return v, nil
}

func (ip *interp) uvarint() (uint64, error) {
	start := ip.pos
	var v uint64
	for i := 0; i < 10; i++ {
		b, err := ip.take(8)
		if err != nil {
			ip.pos = start
			return 0, err
		}
		if i == 9 && b > 1 {
			ip.pos = start
			return 0, ErrOverflow
		}
		v |= (b & 0x7f) << uint(7*i)
		if b&0x80 == 0 {
			if i > 0 && b == 0 {
				ip.pos = start
				return 0, ErrOverlong
			}
			return v, nil
		}
	}
	ip.pos = start
	return 0, ErrOverflow
}

func (ip *interp) run(fields []Field, vals map[string]uint64, out *[]Entry) error {
	for _, f := range fields {
		start := ip.pos
		switch f.Kind {
		case KindUint, KindInt:
			w, err := fieldWidth(f, vals)
			if err != nil {
				return err
			}
			u, err := ip.take(w)
			if err != nil {
				return err
			}
			e := Entry{Name: f.Name, U: u, Start: start, End: ip.pos}
			if f.Kind == KindInt {
				s := int64(u)
				if w < 64 && u&(uint64(1)<<uint(w-1)) != 0 {
					s = int64(u) - (int64(1) << uint(w))
				}
				e.S = s
				e.U = uint64(s)
			} else {
				e.S = int64(u)
			}
			*out = append(*out, e)
			vals[f.Name] = e.U
		case KindUvarint, KindVarint:
			u, err := ip.uvarint()
			if err != nil {
				return err
			}
			e := Entry{Name: f.Name, Start: start, End: ip.pos}
			if f.Kind == KindVarint {
				e.S = int64(u>>1) ^ -int64(u&1)
				e.U = uint64(e.S)
			} else {
				e.U = u
				e.S = int64(u)
			}
			*out = append(*out, e)
			vals[f.Name] = e.U
		case KindAlign:
			pad := int((8 - ip.pos&7) & 7)
			if _, err := ip.take(pad); err != nil {
				return err
			}
			*out = append(*out, Entry{Name: f.Name, Start: start, End: ip.pos})
		case KindStruct:
			subStart := ip.pos
			subLen := len(*out)
			subVals := make(map[string]uint64, len(vals))
			for k, v := range vals {
				subVals[k] = v
			}
			if err := ip.run(f.Sub, subVals, out); err != nil {
				ip.pos = subStart
				*out = (*out)[:subLen]
				return err
			}
			for k, v := range subVals {
				vals[k] = v
			}
		default:
			return fmt.Errorf("telemcodec: unknown field kind: %w", ErrInvalid)
		}
	}
	return nil
}
