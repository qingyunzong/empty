package mat5enc

import "fmt"

func (b *Builder) matrixBytes(m *Matrix) ([]byte, error) {
	if len(m.Dims) < 2 {
		return nil, fmt.Errorf("mat5enc: matrix needs at least two dimensions")
	}
	var count uint64 = 1
	for _, d := range m.Dims {
		if d < 0 {
			return nil, fmt.Errorf("mat5enc: negative dimension")
		}
		if d == 0 {
			count = 0
			break
		}
		count *= uint64(d)
	}
	switch m.Class {
	case 1:
		if uint64(len(m.Children)) != count {
			return nil, fmt.Errorf("mat5enc: cell has %d children, dims require %d",
				len(m.Children), count)
		}
		if m.Complex {
			return nil, fmt.Errorf("mat5enc: cell cannot be complex")
		}
	case 6:
		if uint64(len(m.Real)) != count {
			return nil, fmt.Errorf("mat5enc: double real length %d != element count %d",
				len(m.Real), count)
		}
		if m.Complex && uint64(len(m.Imag)) != count {
			return nil, fmt.Errorf("mat5enc: double imag length %d != element count %d",
				len(m.Imag), count)
		}
	case 12:
		if m.Complex {
			return nil, fmt.Errorf("mat5enc: int32 cannot be complex")
		}
		if uint64(len(m.Int32)) != count {
			return nil, fmt.Errorf("mat5enc: int32 length %d != element count %d",
				len(m.Int32), count)
		}
	default:
		return nil, fmt.Errorf("mat5enc: unsupported class %d", m.Class)
	}

	w := &Builder{order: b.order, bo: b.bo}

	// Flags must be a normal 8-byte type-6 element.
	flags := make([]byte, 8)
	b.order.PutUint32(flags[0:4], m.Class|complexBit(m.Complex))
	w.writeNormal(TypeUInt32, flags)

	// Dimensions: normal type-5 element.
	dimPayload := make([]byte, 4*len(m.Dims))
	for i, d := range m.Dims {
		b.order.PutUint32(dimPayload[i*4:], uint32(d))
	}
	w.writeNormal(TypeInt32, dimPayload)

	// Name: compact small element for 1..4 bytes, normal otherwise. Cell
	// children (any matrix nested one level below a cell) use an empty normal
	// element; a top-level cell may still carry a name.
	if err := w.writeName(m.Name, m.isCellChild); err != nil {
		return nil, err
	}

	switch m.Class {
	case 6:
		realPayload := make([]byte, 8*count)
		for i, bits := range m.Real {
			b.order.PutUint64(realPayload[i*8:], bits)
		}
		w.writeNormal(TypeFloat64, realPayload)
		if m.Complex {
			imagPayload := make([]byte, 8*count)
			for i, bits := range m.Imag {
				b.order.PutUint64(imagPayload[i*8:], bits)
			}
			w.writeNormal(TypeFloat64, imagPayload)
		}
	case 12:
		payload := make([]byte, 4*count)
		for i, v := range m.Int32 {
			b.order.PutUint32(payload[i*4:], uint32(v))
		}
		w.writeNormal(TypeInt32, payload)
	case 1:
		for _, child := range m.Children {
			child.isCellChild = true
			childBytes, err := w.matrixBytes(child)
			if err != nil {
				return nil, err
			}
			w.writeNormal(TypeMatrix, childBytes)
		}
	}
	return w.buf.Bytes(), nil
}

// writeName encodes names. Cell children always use an empty normal element;
// short non-empty names use the compact eight-byte small element.
func (b *Builder) writeName(name string, isCell bool) error {
	if isCell {
		if name != "" {
			return fmt.Errorf("mat5enc: cell child name must be empty")
		}
		b.writeNormal(TypeInt8, nil)
		return nil
	}
	if len(name) >= 1 && len(name) <= 4 {
		b.writeSmall(TypeInt8, []byte(name))
		return nil
	}
	b.writeNormal(TypeInt8, []byte(name))
	return nil
}
