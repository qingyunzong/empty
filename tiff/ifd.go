package tiff

import (
	"encoding/binary"
	"errors"
	"fmt"
)

func (r *Reader) parseHeader() error {
	var hdr [8]byte
	if err := r.readAt(hdr[:], 0); err != nil {
		return err
	}
	switch string(hdr[0:2]) {
	case "II":
		r.order = binary.LittleEndian
	case "MM":
		r.order = binary.BigEndian
	default:
		return fmt.Errorf("tiff: invalid byte order mark %q", hdr[0:2])
	}
	if magic := r.order.Uint16(hdr[2:4]); magic != 42 {
		return fmt.Errorf("tiff: invalid TIFF magic %d", magic)
	}
	first := int64(r.order.Uint32(hdr[4:8]))
	if first == 0 {
		return errors.New("tiff: first IFD offset is zero")
	}
	if first >= r.size {
		return fmt.Errorf("tiff: first IFD offset %d beyond file size %d", first, r.size)
	}
	r.firstIFD = uint32(first)
	return nil
}

func (r *Reader) parseIFDs() error {
	seen := map[uint32]bool{}
	off := r.firstIFD
	totalEntries := 0
	metadataBytes := 0
	for off != 0 {
		if seen[off] {
			return fmt.Errorf("tiff: IFD chain contains a cycle at offset %d", off)
		}
		seen[off] = true
		if int64(off)+2 > r.size {
			return fmt.Errorf("tiff: IFD at offset %d is truncated", off)
		}
		var countBuf [2]byte
		if err := r.readAt(countBuf[:], int64(off)); err != nil {
			return err
		}
		n := int(r.order.Uint16(countBuf[:]))
		totalEntries += n
		if totalEntries > r.limits.MaxIFDEntries {
			return fmt.Errorf("tiff: IFD entry total %d exceeds limit %d", totalEntries, r.limits.MaxIFDEntries)
		}
		entriesBytes, err := mul32(uint32(n), 12)
		if err != nil {
			return err
		}
		entriesEnd, err := add32(off, 2, entriesBytes+4)
		if err != nil {
			return err
		}
		if int64(entriesEnd) > r.size {
			return fmt.Errorf("tiff: IFD at offset %d is truncated", off)
		}
		raw := make([]byte, n*12)
		if err := r.readAt(raw, int64(off)+2); err != nil {
			return err
		}
		img := &Image{reader: r, entries: map[uint16]*entry{}}
		for i := 0; i < n; i++ {
			e := raw[i*12:]
			en := &entry{
				tag:        r.order.Uint16(e[0:2]),
				typ:        r.order.Uint16(e[2:4]),
				count:      r.order.Uint32(e[4:8]),
				valueOrOff: r.order.Uint32(e[8:12]),
			}
			size, ok := typeSize[en.typ]
			if !ok {
				return fmt.Errorf("tiff: tag %d has unknown type %d", en.tag, en.typ)
			}
			total, err := mul32(uint32(size), en.count)
			if err != nil {
				return fmt.Errorf("tiff: tag %d value size overflows uint32", en.tag)
			}
			en.bytes = int(total)
			copy(en.inline[:], e[8:12])
			if total > 4 {
				en.isExternal = true
				en.externalOff = en.valueOrOff
				end, err := add32(en.externalOff, 0, total)
				if err != nil {
					return fmt.Errorf("tiff: tag %d value offset overflows", en.tag)
				}
				if int64(end) > r.size {
					return fmt.Errorf("tiff: tag %d value at offset %d exceeds file size", en.tag, en.externalOff)
				}
			}
			metadataBytes += en.bytes
			if metadataBytes > r.limits.MaxMetadataBytes {
				return fmt.Errorf("tiff: metadata array bytes %d exceed limit %d", metadataBytes, r.limits.MaxMetadataBytes)
			}
			if _, dup := img.entries[en.tag]; dup {
				return fmt.Errorf("tiff: duplicate tag %d in IFD %d", en.tag, len(r.images))
			}
			img.entries[en.tag] = en
		}
		var nextBuf [4]byte
		if err := r.readAt(nextBuf[:], int64(off)+2+int64(n)*12); err != nil {
			return err
		}
		if err := img.validate(); err != nil {
			return err
		}
		r.images = append(r.images, img)
		off = r.order.Uint32(nextBuf[:])
		if off != 0 && int64(off) >= r.size {
			return fmt.Errorf("tiff: next IFD offset %d beyond file size %d", off, r.size)
		}
	}
	if len(r.images) == 0 {
		return errors.New("tiff: IFD chain contains no directories")
	}
	return nil
}

// mul32 returns a*b, rejecting uint32 overflow.
func mul32(a, b uint32) (uint32, error) {
	if a != 0 && b > (1<<32-1)/a {
		return 0, fmt.Errorf("tiff: multiplication %d*%d overflows uint32", a, b)
	}
	return a * b, nil
}

// add32 returns a+b+c, rejecting uint32 overflow.
func add32(a, b, c uint32) (uint32, error) {
	max := uint32(1<<32 - 1)
	if a > max-b {
		return 0, fmt.Errorf("tiff: offset addition overflows uint32")
	}
	s := a + b
	if s > max-c {
		return 0, fmt.Errorf("tiff: offset addition overflows uint32")
	}
	return s + c, nil
}
