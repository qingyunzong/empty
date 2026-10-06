package norm

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

type memberRec struct {
	key    string
	keyOff int
	val    valueRef
}

// objBuilder collects the members of one object, spilling sorted runs to
// segment files when the memory budget is exceeded, and finally emits the
// members sorted by key in UTF-8 byte order with duplicate-key rejection.
type objBuilder struct {
	recs      []memberRec
	recsBytes int64
	segments  []*segMeta
	keepSegs  bool // top-level object with a state dir: segments survive a pause
}

func (ob *objBuilder) add(n *norm, key string, keyOff int, vb *valueBuf) {
	ref := vb.ref()
	ob.recs = append(ob.recs, memberRec{key: key, keyOff: keyOff, val: ref})
	sz := int64(len(key))
	if ref.mem != nil {
		sz += int64(len(ref.mem))
	}
	ob.recsBytes += sz
	n.memUsed += int64(len(key)) // in-memory value bytes were already accounted by valueBuf
}

// flush sorts the buffered records and appends them as a new segment file.
func (ob *objBuilder) flush(n *norm) error {
	if len(ob.recs) == 0 {
		return nil
	}
	sort.Slice(ob.recs, func(i, j int) bool { return ob.recs[i].key < ob.recs[j].key })
	name := fmt.Sprintf("seg-%06d.bin", n.segCounter)
	n.segCounter++
	path := filepath.Join(n.segDir, name)
	sw, err := newSegWriter(path)
	if err != nil {
		return err
	}
	for _, r := range ob.recs {
		var werr error
		if r.val.mem != nil {
			werr = sw.writeRecord(r.key, int64(r.keyOff), int64(len(r.val.mem)), bytes.NewReader(r.val.mem))
		} else {
			var f *os.File
			f, werr = os.Open(r.val.file)
			if werr == nil {
				werr = sw.writeRecord(r.key, int64(r.keyOff), r.val.length, f)
				f.Close()
			}
		}
		r.val.cleanup()
		if werr != nil {
			return werr
		}
	}
	meta, err := sw.close()
	if err != nil {
		return err
	}
	ob.segments = append(ob.segments, meta)
	n.memUsed -= ob.recsBytes
	ob.recs = nil
	ob.recsBytes = 0
	n.segsFlushed++
	return nil
}

// emit writes the sorted object body (including braces) to w. Duplicate
// keys are rejected here: sorting makes equal keys adjacent, whether they
// come from a single in-memory run or from different segment files.
func (ob *objBuilder) emit(n *norm, w io.Writer, src []byte) error {
	if _, err := io.WriteString(w, "{"); err != nil {
		return err
	}
	if len(ob.segments) == 0 {
		sort.Slice(ob.recs, func(i, j int) bool { return ob.recs[i].key < ob.recs[j].key })
		for i, r := range ob.recs {
			if i > 0 {
				if r.key == ob.recs[i-1].key {
					return &Error{Msg: fmt.Sprintf("duplicate key %q", r.key), Start: r.keyOff, src: src}
				}
				if _, err := io.WriteString(w, ","); err != nil {
					return err
				}
			}
			writeJSONString(w, r.key)
			io.WriteString(w, ":")
			if err := r.val.writeTo(w); err != nil {
				return err
			}
			r.val.cleanup()
		}
		n.memUsed -= ob.recsBytes
		ob.recs = nil
		ob.recsBytes = 0
	} else {
		if err := ob.flush(n); err != nil {
			return err
		}
		first := true
		err := n.mergeSegments(ob.segments, func(key string, keyOff, valLen int64, val io.Reader) error {
			if !first {
				if _, err := io.WriteString(w, ","); err != nil {
					return err
				}
			}
			first = false
			writeJSONString(w, key)
			io.WriteString(w, ":")
			_, err := io.CopyN(w, val, valLen)
			return err
		}, src)
		if err != nil {
			return err
		}
		if !ob.keepSegs {
			for _, m := range ob.segments {
				os.Remove(filepath.Join(n.segDir, m.File))
			}
		}
	}
	_, err := io.WriteString(w, "}")
	return err
}
