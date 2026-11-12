package dataeng

import "encoding/binary"

// Handle 是按路径与逻辑半开样本号区间打开的读取句柄。
//
// 句柄不预读全部样本：每次 Next 只通过宿主的不可变 ReaderAt 读取当前
// 一个值所需的字节，因此随机读取单个样本不会把整个文件读入内存。
// 段索引按 chunk 保存，不为全部样本各建一项。
type Handle struct {
	engine *Engine

	path string
	typ  ValueType
	bo   binary.ByteOrder

	cursor int64
	end    int64

	// segCursor 是当前段在 engine.pathSegments[path] 中的下标。
	segCursor int
	segRefs   []int
	// segLogicalEnd 是当前段对该路径的逻辑样本上界（exclusive）。
	segLogicalEnd int64
	record        *segmentRecord
	channel       *channelInSegment

	readBuf []byte
}

// Open 返回 path 上逻辑区间 [start, end) 的读取句柄。区间在打开时一次性
// 校验，越界、反向或未知路径都在任何字节读取前拒绝。
func (e *Engine) Open(path string, start, end int64) (*Handle, error) {
	if path == "" {
		return nil, wrapf(ErrInvalidArgument, "open requires non-empty path")
	}
	if start < 0 || end < start {
		return nil, wrapf(ErrRange, "path %q invalid half-open range [%d,%d)", path, start, end)
	}

	e.mu.RLock()
	defer e.mu.RUnlock()

	total, known := e.totalSamples[path]
	if !known {
		return nil, wrapf(ErrUnknownPath, "path %q was never indexed", path)
	}
	if end > total {
		return nil, wrapf(ErrRange, "path %q range [%d,%d) exceeds %d committed samples", path, start, end, total)
	}

	refs := e.pathSegments[path]
	h := &Handle{
		engine:    e,
		path:      path,
		cursor:    start,
		end:       end,
		segCursor: 0,
		segRefs:   refs,
	}
	if len(refs) > 0 {
		h.advanceToSegment(start)
	}
	return h, nil
}

// TotalSamples 返回某路径已提交的稳定逻辑样本总数；未知路径返回 0 与 false。
func (e *Engine) TotalSamples(path string) (int64, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	n, ok := e.totalSamples[path]
	return n, ok
}

// ActiveOrder 返回最近一个已提交段的活动路径顺序的拷贝。
func (e *Engine) ActiveOrder() []string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]string, len(e.activeOrder))
	copy(out, e.activeOrder)
	return out
}

// advanceToSegment 移动句柄到包含逻辑样本 logical 的段，调用方持读锁或
// 在句柄独占使用期间调用（段记录一旦提交不可变）。
func (h *Handle) advanceToSegment(logical int64) {
	for h.segCursor < len(h.segRefs) {
		rec := h.engine.segments[h.segRefs[h.segCursor]]
		first := rec.firstLogical[h.path]
		count := rec.count[h.path]
		if logical < first+count {
			h.record = rec
			h.channel = rec.channelByPath[h.path]
			h.segLogicalEnd = first + count
			h.typ = h.channel.typeName
			h.bo = byteOrder(h.channel.endian)
			if cap(h.readBuf) < h.channel.width {
				h.readBuf = make([]byte, h.channel.width)
			} else {
				h.readBuf = h.readBuf[:h.channel.width]
			}
			return
		}
		h.segCursor++
	}
	h.record = nil
	h.channel = nil
}

// physicalAddress 把当前段内的逻辑样本换算成绝对物理字节偏移与 chunk 号。
// 所有乘法与加法均为溢出检查后的 int64 运算。
func (h *Handle) physicalAddress(logical int64) (absOffset int64, chunk int64, err error) {
	rec := h.record
	ch := h.channel
	within := logical - rec.firstLogical[h.path]
	if within < 0 {
		return 0, 0, wrapf(ErrRange, "path %q logical %d precedes segment %d", h.path, logical, rec.segmentNumber)
	}

	chunk = within / ch.samplesPerChunk
	indexInChunk := within % ch.samplesPerChunk

	chunkStart, err := mul64(chunk, rec.chunkBytes)
	if err != nil {
		return 0, 0, wrapf(err, "path %q chunk start", h.path)
	}
	sampleStep, err := mul64(indexInChunk, ch.sampleStride)
	if err != nil {
		return 0, 0, wrapf(err, "path %q sample stride", h.path)
	}
	relative, err := add64(chunkStart, ch.offsetInChunk)
	if err != nil {
		return 0, 0, wrapf(err, "path %q chunk offset", h.path)
	}
	relative, err = add64(relative, sampleStep)
	if err != nil {
		return 0, 0, wrapf(err, "path %q sample offset", h.path)
	}
	absOffset, err = add64(rec.rawOffset, relative)
	if err != nil {
		return 0, 0, wrapf(err, "path %q physical offset", h.path)
	}
	if relative < 0 || relative >= rec.rawLength {
		return 0, 0, wrapf(ErrAddressOverflow, "path %q logical %d maps outside raw area", h.path, logical)
	}
	return absOffset, chunk, nil
}

// Next 推进并返回下一个样本。区间耗尽时返回 ok=false，且不产生读取。
func (h *Handle) Next() (Result, bool, error) {
	if h.cursor >= h.end {
		return Result{}, false, nil
	}

	// 句柄跨段移动；已提交段记录不可变，无需再次加锁。
	if h.record == nil || h.cursor >= h.segLogicalEnd {
		h.segCursor++
		h.advanceToSegment(h.cursor)
		if h.record == nil {
			return Result{}, false, wrapf(ErrRange, "path %q missing committed segment for logical sample %d", h.path, h.cursor)
		}
	}

	absOffset, chunk, err := h.physicalAddress(h.cursor)
	if err != nil {
		return Result{}, false, err
	}

	buf := h.readBuf
	if err := readFullAt(h.record.reader, buf, absOffset); err != nil {
		return Result{}, false, wrapf(ErrReadFailed, "path %q at segment %d logical %d: %v", h.path, h.record.segmentNumber, h.cursor, err)
	}

	res := decodeValue(h.typ, h.bo, buf)
	res.Type = h.typ
	res.Source = Source{
		SegmentNumber:  h.record.segmentNumber,
		Chunk:          chunk,
		LogicalIndex:   h.cursor,
		PhysicalOffset: absOffset,
		Width:          h.channel.width,
	}
	h.cursor++
	return res, true, nil
}

// ReadAll 耗尽句柄并返回区间内全部结果，适合宿主明确需要批量结果的场景。
// 底层仍逐值按需读取，不会一次性映射整个原始区。
func (h *Handle) ReadAll() ([]Result, error) {
	var out []Result
	for {
		res, ok, err := h.Next()
		if err != nil {
			return nil, err
		}
		if !ok {
			return out, nil
		}
		out = append(out, res)
	}
}

func byteOrder(e Endian) binary.ByteOrder {
	if e == BigEndian {
		return binary.BigEndian
	}
	return binary.LittleEndian
}

func decodeValue(typ ValueType, bo binary.ByteOrder, b []byte) Result {
	switch typ {
	case TypeI16:
		return Result{I16: int16(bo.Uint16(b))}
	case TypeI32:
		return Result{I32: int32(bo.Uint32(b))}
	case TypeF64Bits:
		// 仅回传 IEEE 位型，绝不做十进制/浮点数值转换。
		return Result{F64: bo.Uint64(b)}
	case TypeTimestamp:
		// 布局固定为先 uint64 亚秒、再 int64 秒，两分量同端序。
		return Result{Time: Timestamp{
			Fraction: bo.Uint64(b[:8]),
			Seconds:  int64(bo.Uint64(b[8:16])),
		}}
	default:
		return Result{}
	}
}
