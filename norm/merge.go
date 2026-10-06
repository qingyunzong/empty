package norm

import (
	"container/heap"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// maxMergeWay bounds how many segment files are merged in a single pass,
// limiting concurrently open file descriptors.
const maxMergeWay = 32

// emitFunc receives one sorted record during a merge. val reads exactly
// valLen bytes of normalized JSON.
type emitFunc func(key string, keyOff, valLen int64, val io.Reader) error

// mergeSegments merges sorted segment files into a single sorted stream
// delivered to emit. If there are more than maxMergeWay segments,
// intermediate merge passes consolidate them first. Duplicate keys are
// detected across segment boundaries: the merge produces a globally sorted
// order, so equal keys always become adjacent.
func (n *norm) mergeSegments(segs []*segMeta, emit emitFunc, src []byte) error {
	queue := append([]*segMeta(nil), segs...)
	var intermediates []string
	defer func() {
		for _, f := range intermediates {
			os.Remove(f)
		}
	}()
	for len(queue) > maxMergeWay {
		group := queue[:maxMergeWay]
		queue = queue[maxMergeWay:]
		name := fmt.Sprintf("seg-%06d.bin", n.segCounter)
		n.segCounter++
		path := filepath.Join(n.segDir, name)
		sw, err := newSegWriter(path)
		if err != nil {
			return err
		}
		merr := n.mergeOnce(group, func(key string, keyOff, valLen int64, val io.Reader) error {
			return sw.writeRecord(key, keyOff, valLen, val)
		}, src)
		if merr != nil {
			sw.close()
			os.Remove(path)
			return merr
		}
		meta, err := sw.close()
		if err != nil {
			os.Remove(path)
			return err
		}
		intermediates = append(intermediates, path)
		queue = append(queue, meta)
	}
	return n.mergeOnce(queue, emit, src)
}

type mergeItem struct {
	key    string
	keyOff int64
	valLen int64
	r      *segReader
	idx    int
}

type mergeHeap []mergeItem

func (h mergeHeap) Len() int { return len(h) }

func (h mergeHeap) Less(i, j int) bool {
	if h[i].key != h[j].key {
		return h[i].key < h[j].key
	}
	return h[i].idx < h[j].idx
}

func (h mergeHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }

func (h *mergeHeap) Push(x any) { *h = append(*h, x.(mergeItem)) }

func (h *mergeHeap) Pop() any {
	old := *h
	it := old[len(old)-1]
	*h = old[:len(old)-1]
	return it
}

func (n *norm) mergeOnce(segs []*segMeta, emit emitFunc, src []byte) error {
	readers := make([]*segReader, 0, len(segs))
	defer func() {
		for _, r := range readers {
			r.close()
		}
	}()
	h := &mergeHeap{}
	for i, m := range segs {
		r, err := openSegReader(filepath.Join(n.segDir, m.File))
		if err != nil {
			return err
		}
		readers = append(readers, r)
		if r.next() {
			heap.Push(h, mergeItem{key: r.key, keyOff: r.keyOff, valLen: r.valLen, r: r, idx: i})
		} else if r.err != nil {
			return r.err
		}
	}
	var prev string
	hasPrev := false
	for h.Len() > 0 {
		it := heap.Pop(h).(mergeItem)
		if hasPrev && it.key == prev {
			return &Error{Msg: fmt.Sprintf("duplicate key %q", it.key), Start: int(it.keyOff), src: src}
		}
		if err := emit(it.key, it.keyOff, it.valLen, it.r.br); err != nil {
			return err
		}
		prev, hasPrev = it.key, true
		if it.r.next() {
			it.key, it.keyOff, it.valLen = it.r.key, it.r.keyOff, it.r.valLen
			heap.Push(h, it)
		} else if it.r.err != nil {
			return it.r.err
		}
	}
	return nil
}
