package sigdb

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
)

// rawFile abstracts the storage device so tests can inject power failures.
type rawFile interface {
	ReadAt(p []byte, off int64) (int, error)
	WriteAt(p []byte, off int64) (int, error)
	Sync() error
	Truncate(size int64) error
	Size() (int64, error)
	Close() error
}

type osFile struct{ f *os.File }

func (o osFile) ReadAt(p []byte, off int64) (int, error)  { return o.f.ReadAt(p, off) }
func (o osFile) WriteAt(p []byte, off int64) (int, error) { return o.f.WriteAt(p, off) }
func (o osFile) Sync() error                              { return o.f.Sync() }
func (o osFile) Truncate(size int64) error                { return o.f.Truncate(size) }
func (o osFile) Size() (int64, error) {
	st, err := o.f.Stat()
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}
func (o osFile) Close() error { return o.f.Close() }

const (
	dataMagic   = "SGDBDAT1"
	commitMagic = "SGDBCOM1"
	fileHeader  = 8
	commitSlots = 2
	commitSlot  = 64
	recLenSize  = 4
)

// commitRec is the single atomic publish unit: one record covers both the
// sample snapshot and the integral index root, so a crash can never expose a
// mix of new samples with old integrals or vice versa.
type commitRec struct {
	gen       uint64
	samplesPg int64
	indexRoot int64
	dataLen   int64
}

func (c commitRec) encode() []byte {
	buf := make([]byte, commitSlot)
	copy(buf, commitMagic)
	binary.LittleEndian.PutUint64(buf[8:16], c.gen)
	binary.LittleEndian.PutUint64(buf[16:24], uint64(c.samplesPg))
	binary.LittleEndian.PutUint64(buf[24:32], uint64(c.indexRoot))
	binary.LittleEndian.PutUint64(buf[32:40], uint64(c.dataLen))
	binary.LittleEndian.PutUint32(buf[40:44], crc32.ChecksumIEEE(buf[:40]))
	return buf
}

func decodeCommit(buf []byte) (commitRec, bool) {
	var c commitRec
	if len(buf) < commitSlot || string(buf[:8]) != commitMagic {
		return c, false
	}
	if crc32.ChecksumIEEE(buf[:40]) != binary.LittleEndian.Uint32(buf[40:44]) {
		return c, false
	}
	c.gen = binary.LittleEndian.Uint64(buf[8:16])
	c.samplesPg = int64(binary.LittleEndian.Uint64(buf[16:24]))
	c.indexRoot = int64(binary.LittleEndian.Uint64(buf[24:32]))
	c.dataLen = int64(binary.LittleEndian.Uint64(buf[32:40]))
	return c, true
}

// pager owns the append-only data file and the commit file. Pages are never
// overwritten; a commit appends new pages, fsyncs, then publishes one commit
// record into slot gen%2 and fsyncs again. Recovery picks the highest valid
// generation and truncates any torn tail.
type pager struct {
	data   rawFile
	commit rawFile
	end    int64 // current append offset in the data file
	rec    commitRec
}

func openPager(data, commit rawFile) (*pager, error) {
	p := &pager{data: data, commit: commit}
	size, err := data.Size()
	if err != nil {
		return nil, err
	}
	if size == 0 {
		if _, err := data.WriteAt([]byte(dataMagic), 0); err != nil {
			return nil, err
		}
		if err := data.Sync(); err != nil {
			return nil, err
		}
		p.end = fileHeader
	} else {
		hdr := make([]byte, fileHeader)
		if _, err := data.ReadAt(hdr, 0); err != nil {
			return nil, err
		}
		if string(hdr) != dataMagic {
			return nil, fmt.Errorf("sigdb: bad data file magic")
		}
		p.end = size
	}
	// Recover the newest valid commit record.
	csize, err := commit.Size()
	if err != nil {
		return nil, err
	}
	var best commitRec
	if csize >= commitSlot*commitSlots {
		buf := make([]byte, commitSlot*commitSlots)
		if _, err := commit.ReadAt(buf, 0); err != nil {
			return nil, err
		}
		for i := 0; i < commitSlots; i++ {
			if c, ok := decodeCommit(buf[i*commitSlot:]); ok && (best.gen == 0 || c.gen > best.gen) {
				best = c
			}
		}
	}
	if best.gen > 0 {
		if best.dataLen > p.end {
			return nil, fmt.Errorf("sigdb: commit points past end of data file")
		}
		// Drop any torn tail left by an interrupted commit.
		if p.end > best.dataLen {
			if err := data.Truncate(best.dataLen); err != nil {
				return nil, err
			}
			p.end = best.dataLen
		}
	}
	p.rec = best
	return p, nil
}

// appendPage writes one length-framed record and returns its page id.
// The write is buffered by the OS/device until syncData is called.
func (p *pager) appendPage(payload []byte) (int64, error) {
	rec := make([]byte, recLenSize+len(payload))
	binary.LittleEndian.PutUint32(rec, uint32(len(payload)))
	copy(rec[recLenSize:], payload)
	off := p.end
	if _, err := p.data.WriteAt(rec, off); err != nil {
		return 0, err
	}
	p.end += int64(len(rec))
	return off, nil
}

func (p *pager) readPage(id int64) ([]byte, error) {
	var lb [recLenSize]byte
	if _, err := p.data.ReadAt(lb[:], id); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(lb[:])
	if n == 0 || n > 1<<30 {
		return nil, fmt.Errorf("sigdb: corrupt page at %d", id)
	}
	buf := make([]byte, n)
	if _, err := p.data.ReadAt(buf, id+recLenSize); err != nil {
		return nil, err
	}
	return buf, nil
}

// publish atomically commits the new state: data pages first, fsync, then
// the commit record, fsync. A crash anywhere before the commit record is
// durable leaves the previous generation fully intact.
func (p *pager) publish(samplesPg, indexRoot int64) error {
	if err := p.data.Sync(); err != nil {
		return err
	}
	rec := commitRec{gen: p.rec.gen + 1, samplesPg: samplesPg, indexRoot: indexRoot, dataLen: p.end}
	slot := int64(rec.gen%commitSlots) * commitSlot
	if _, err := p.commit.WriteAt(rec.encode(), slot); err != nil {
		return err
	}
	if err := p.commit.Sync(); err != nil {
		return err
	}
	p.rec = rec
	return nil
}

func (p *pager) close() {
	p.data.Close()
	p.commit.Close()
}

func openFiles(dir string) (rawFile, rawFile, error) {
	df, err := os.OpenFile(filepath.Join(dir, "data.db"), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, nil, err
	}
	cf, err := os.OpenFile(filepath.Join(dir, "commit.db"), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		df.Close()
		return nil, nil, err
	}
	return osFile{df}, osFile{cf}, nil
}
