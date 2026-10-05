package monitor

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"math/big"
)

const (
	pageSize     = 4096
	pageLeaf     = 1
	pageInternal = 2

	superSlotOff  = 16
	superSlotSize = 32
)

var (
	magic       = [8]byte{'M', 'O', 'N', 'I', 'D', 'X', '0', '1'}
	crcTable    = crc32.MakeTable(crc32.Castagnoli)
	errCorrupt  = errors.New("monitor: corrupt page")
	errPageFull = errors.New("monitor: page overflow")
)

// childEntry describes one subtree inside an internal page. The subtree
// owns every segment whose left endpoint lies in [minT, segEnd], and agg
// is the exact sum of those segment integrals.
type childEntry struct {
	page   uint64
	minT   int64
	segEnd int64
	agg    *big.Rat
}

type leafData struct {
	entries []Sample
	next    *Sample // first sample of the following leaf, if any
	agg     *big.Rat
}

type internalData struct {
	children []childEntry
}

type encoder struct{ buf bytes.Buffer }

func (e *encoder) u8(v byte) { e.buf.WriteByte(v) }
func (e *encoder) u64(v uint64) {
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], v)
	e.buf.Write(b[:])
}
func (e *encoder) i64(v int64) { e.u64(uint64(v)) }
func (e *encoder) uvarint(v uint64) {
	var b [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(b[:], v)
	e.buf.Write(b[:n])
}

func (e *encoder) bigint(x *big.Int) {
	e.u8(byte(x.Sign() + 1))
	abs := x.Bytes()
	e.uvarint(uint64(len(abs)))
	e.buf.Write(abs)
}

func (e *encoder) rat(r *big.Rat) {
	e.bigint(r.Num())
	e.bigint(r.Denom())
}

func (e *encoder) sample(s Sample) {
	e.i64(s.Time)
	e.u64(s.Version)
	var flags byte
	if s.Missing {
		flags = 1
	}
	e.u8(flags)
	v := s.Value
	if v == nil {
		v = new(big.Rat)
	}
	e.rat(v)
}

type decoder struct {
	data []byte
	off  int
	err  error
}

func (d *decoder) take(n int) []byte {
	if d.err != nil {
		return nil
	}
	if n < 0 || d.off+n > len(d.data) {
		d.err = errCorrupt
		return nil
	}
	b := d.data[d.off : d.off+n]
	d.off += n
	return b
}

func (d *decoder) u8() byte {
	b := d.take(1)
	if b == nil {
		return 0
	}
	return b[0]
}

func (d *decoder) u64() uint64 {
	b := d.take(8)
	if b == nil {
		return 0
	}
	return binary.LittleEndian.Uint64(b)
}

func (d *decoder) i64() int64 { return int64(d.u64()) }

func (d *decoder) uvarint() uint64 {
	if d.err != nil {
		return 0
	}
	v, n := binary.Uvarint(d.data[d.off:])
	if n <= 0 {
		d.err = errCorrupt
		return 0
	}
	d.off += n
	return v
}

func (d *decoder) bigint() *big.Int {
	sign := int(d.u8()) - 1
	if d.err != nil {
		return nil
	}
	if sign < -1 || sign > 1 {
		d.err = errCorrupt
		return nil
	}
	n := d.uvarint()
	if d.err != nil {
		return nil
	}
	if n > 1<<20 {
		d.err = errCorrupt
		return nil
	}
	b := d.take(int(n))
	if d.err != nil {
		return nil
	}
	x := new(big.Int).SetBytes(b)
	if sign < 0 {
		x.Neg(x)
	}
	return x
}

func (d *decoder) rat() *big.Rat {
	num := d.bigint()
	den := d.bigint()
	if d.err != nil {
		return nil
	}
	if den.Sign() <= 0 {
		d.err = errCorrupt
		return nil
	}
	return new(big.Rat).SetFrac(num, den)
}

func (d *decoder) sample() Sample {
	t := d.i64()
	ver := d.u64()
	flags := d.u8()
	v := d.rat()
	if d.err != nil {
		return Sample{}
	}
	s := Sample{Time: t, Version: ver, Missing: flags&1 != 0}
	if !s.Missing {
		s.Value = v
	}
	return s
}

func encodeLeaf(l *leafData) ([]byte, error) {
	e := &encoder{}
	e.u8(pageLeaf)
	e.uvarint(uint64(len(l.entries)))
	for _, s := range l.entries {
		e.sample(s)
	}
	if l.next != nil {
		e.u8(1)
		e.sample(*l.next)
	} else {
		e.u8(0)
	}
	e.rat(l.agg)
	if e.buf.Len() > pageSize {
		return nil, errPageFull
	}
	return e.buf.Bytes(), nil
}

func decodeLeaf(d *decoder) (*leafData, error) {
	n := d.uvarint()
	if d.err != nil {
		return nil, d.err
	}
	if n > 1<<16 {
		return nil, errCorrupt
	}
	l := &leafData{entries: make([]Sample, 0, n)}
	for i := uint64(0); i < n; i++ {
		l.entries = append(l.entries, d.sample())
	}
	if d.u8() == 1 {
		s := d.sample()
		l.next = &s
	}
	l.agg = d.rat()
	if d.err != nil {
		return nil, d.err
	}
	return l, nil
}

func encodeInternal(p *internalData) ([]byte, error) {
	e := &encoder{}
	e.u8(pageInternal)
	e.uvarint(uint64(len(p.children)))
	for _, c := range p.children {
		e.u64(c.page)
		e.i64(c.minT)
		e.i64(c.segEnd)
		e.rat(c.agg)
	}
	if e.buf.Len() > pageSize {
		return nil, errPageFull
	}
	return e.buf.Bytes(), nil
}

func decodeInternal(d *decoder) (*internalData, error) {
	n := d.uvarint()
	if d.err != nil {
		return nil, d.err
	}
	if n > 1<<16 {
		return nil, errCorrupt
	}
	p := &internalData{children: make([]childEntry, 0, n)}
	for i := uint64(0); i < n; i++ {
		c := childEntry{page: d.u64(), minT: d.i64(), segEnd: d.i64(), agg: d.rat()}
		if d.err != nil {
			return nil, d.err
		}
		p.children = append(p.children, c)
	}
	return p, nil
}

// superSlot is one commit record in the superblock. Two alternating slots
// plus a CRC make root publication atomic: a torn or partial slot write
// is detected and the previous generation stays in effect.
type superSlot struct {
	gen      uint64
	root     uint64
	numPages uint64
}

func encodeSlot(s superSlot) []byte {
	b := make([]byte, superSlotSize)
	binary.LittleEndian.PutUint64(b[0:], s.gen)
	binary.LittleEndian.PutUint64(b[8:], s.root)
	binary.LittleEndian.PutUint64(b[16:], s.numPages)
	binary.LittleEndian.PutUint32(b[24:], crc32.Checksum(b[:24], crcTable))
	return b
}

func decodeSlot(b []byte) (superSlot, bool) {
	if len(b) < superSlotSize {
		return superSlot{}, false
	}
	if crc32.Checksum(b[:24], crcTable) != binary.LittleEndian.Uint32(b[24:]) {
		return superSlot{}, false
	}
	return superSlot{
		gen:      binary.LittleEndian.Uint64(b[0:]),
		root:     binary.LittleEndian.Uint64(b[8:]),
		numPages: binary.LittleEndian.Uint64(b[16:]),
	}, true
}
