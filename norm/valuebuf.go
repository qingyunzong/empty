package norm

import (
	"io"
	"os"
)

// valueBuf accumulates one normalized member value. It stays in memory
// until the global memory budget is exceeded, then spills to a temporary
// file.
type valueBuf struct {
	n    *norm
	mem  []byte
	file *os.File
	path string
	size int64
	err  error
}

func newValueBuf(n *norm) *valueBuf { return &valueBuf{n: n} }

func (b *valueBuf) Write(p []byte) (int, error) {
	if b.err != nil {
		return 0, b.err
	}
	if b.file != nil {
		m, err := b.file.Write(p)
		b.size += int64(m)
		if err != nil {
			b.err = err
		}
		return m, err
	}
	b.mem = append(b.mem, p...)
	b.n.memUsed += int64(len(p))
	if b.n.memUsed > b.n.budget {
		if err := b.spill(); err != nil {
			b.err = err
			return 0, err
		}
	}
	return len(p), nil
}

func (b *valueBuf) spill() error {
	f, err := os.CreateTemp(b.n.tmpDir, "val-*.tmp")
	if err != nil {
		return err
	}
	if _, err := f.Write(b.mem); err != nil {
		f.Close()
		os.Remove(f.Name())
		return err
	}
	b.n.memUsed -= int64(len(b.mem))
	b.size = int64(len(b.mem))
	b.mem = nil
	b.file = f
	b.path = f.Name()
	return nil
}

// ref detaches the accumulated value from the buffer.
func (b *valueBuf) ref() valueRef {
	if b.file != nil {
		b.file.Close()
		return valueRef{file: b.path, length: b.size}
	}
	return valueRef{mem: b.mem}
}

func (b *valueBuf) discard() {
	if b.file != nil {
		b.file.Close()
		os.Remove(b.path)
	}
}

// valueRef refers to a normalized member value held either in memory or in
// a temporary file.
type valueRef struct {
	mem    []byte
	file   string
	length int64
}

func (r valueRef) writeTo(w io.Writer) error {
	if r.file != "" {
		f, err := os.Open(r.file)
		if err != nil {
			return err
		}
		_, err = io.CopyN(w, f, r.length)
		f.Close()
		return err
	}
	_, err := w.Write(r.mem)
	return err
}

func (r valueRef) cleanup() {
	if r.file != "" {
		os.Remove(r.file)
	}
}
