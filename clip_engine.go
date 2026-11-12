package dataeng

// seg 是新记录中一段连续操作在本地坐标空间的投影。
type seg struct {
	kind               Op
	refStart, refEnd   uint64 // 半开参考区间；I 的 refStart==refEnd 为锚点
	readStart, readEnd uint64 // 半开本地读段区间；D/N 为空区间
}

// Clipped 是 [L,R) 裁剪后的规范化记录。
//
// 当 Empty 为 true 时，窗口内未保留任何 M/=/X 操作，其余字段为零值，
// 调用方不得以纯 I 或纯 D/N 伪造比对。
type Clipped struct {
	// Empty 表示窗口内没有任何双消费操作保留。
	Empty bool
	// RefStart 是首个保留的消费参考操作坐标（新起点）。
	RefStart uint64
	// CIGAR 是规范化操作串：无 H/S，相邻同类型已合并；Empty 时为 nil。
	CIGAR []Operation
	// ReadRetained 报告是否保留了读段碱基。
	ReadRetained bool
	// ReadStart/ReadEnd 是保留片段在原始读段中的半开下标区间。
	ReadStart uint64
	ReadEnd   uint64
	// Bases/Qualities 是保留的连续片段，方向与原始序列一致。
	Bases     []byte
	Qualities []byte

	segs []seg
}

// ReadLength 返回新记录消费的读段长度（含 I）。
func (c *Clipped) ReadLength() uint64 {
	if c == nil || c.Empty {
		return 0
	}
	return c.segs[len(c.segs)-1].readEnd
}

// RefLength 返回新记录消费的参考长度（不含 I）。
func (c *Clipped) RefLength() uint64 {
	if c == nil || c.Empty {
		return 0
	}
	var n uint64
	for _, op := range c.CIGAR {
		if op.Kind.ConsumesRef() {
			n += op.Length
		}
	}
	return n
}

// CIGARString 返回形如 3M2I4M 的规范化操作串；Empty 时返回空串。
func (c *Clipped) CIGARString() string {
	if c == nil || c.Empty {
		return ""
	}
	total := 0
	for _, op := range c.CIGAR {
		total += len(uitoa(op.Length)) + 1
	}
	buf := make([]byte, 0, total)
	for _, op := range c.CIGAR {
		buf = append(buf, uitoa(op.Length)...)
		buf = append(buf, op.Kind.Byte())
	}
	return string(buf)
}

// Clip 按参考半开区间 [L,R) 裁剪记录。
//
// 双消费操作与 D/N 只保留参考交集；I 锚在其之前已消费的参考位置 p，
// 仅当 L<=p<R 时保留；原始 S/H 全部丢弃。保留的 D/N 即使位于首尾
// 也不删除，相邻同类型操作会被合并。
func Clip(r *Record, L, R uint64) (*Clipped, error) {
	if L > R {
		return nil, opErr(-1, ErrWindowReversed)
	}
	if err := validate(r); err != nil {
		return nil, err
	}

	out := &Clipped{}
	// refPos 是绝对参考坐标，从记录起点 s 开始；readPos 是原始读段下标。
	refPos := r.RefStart
	var readPos uint64
	var newStart uint64
	haveRef := false
	haveMatch := false
	haveRead := false
	var readLo, readHi uint64

	// appendPiece 追加一个保留片段，并合并相邻同类型操作。
	appendPiece := func(i int, kind Op, length, pieceRefLo, pieceReadLo, pieceReadHi uint64, reads bool) error {
		if length == 0 {
			return nil
		}
		if !haveRef {
			newStart = pieceRefLo
			haveRef = true
		}
		if n := len(out.CIGAR); n > 0 && out.CIGAR[n-1].Kind == kind {
			merged, ok := add64(out.CIGAR[n-1].Length, length)
			if !ok {
				return opErr(i, ErrOverflow)
			}
			out.CIGAR[n-1].Length = merged
		} else {
			out.CIGAR = append(out.CIGAR, Operation{Kind: kind, Length: length})
		}
		if reads {
			if haveRead && pieceReadLo != readHi {
				// 保留读段必须是原始序列中的一个连续片段。
				return opErr(i, errNonContiguous)
			}
			if !haveRead {
				readLo = pieceReadLo
				haveRead = true
			}
			readHi = pieceReadHi
		}
		return nil
	}

	for i, op := range r.CIGAR {
		switch {
		case op.Kind == OpHardClip:
			// H 不消费任何长度，直接丢弃。
			continue

		case op.Kind == OpSoftClip:
			// S 全部丢弃，但仍推进读段游标以维持原始下标。
			next, ok := add64(readPos, op.Length)
			if !ok {
				return nil, opErr(i, ErrOverflow)
			}
			readPos = next

		case op.Kind == OpInsertion:
			// 锚点 p 为当前已消费的参考位置。
			if L <= refPos && refPos < R {
				rEnd, ok := add64(readPos, op.Length)
				if !ok {
					return nil, opErr(i, ErrOverflow)
				}
				if err := appendPiece(i, OpInsertion, op.Length, refPos, readPos, rEnd, true); err != nil {
					return nil, err
				}
			}
			next, ok := add64(readPos, op.Length)
			if !ok {
				return nil, opErr(i, ErrOverflow)
			}
			readPos = next

		case op.Kind.ConsumesRef() && op.Kind.ConsumesRead(): // M / = / X
			refEnd, ok := add64(refPos, op.Length)
			if !ok {
				return nil, opErr(i, ErrOverflow)
			}
			if lo, _, kept := intersect(refPos, refEnd, L, R); kept > 0 {
				pieceReadLo, ok := add64(readPos, lo-refPos)
				if !ok {
					return nil, opErr(i, ErrOverflow)
				}
				pieceReadHi, ok := add64(pieceReadLo, kept)
				if !ok {
					return nil, opErr(i, ErrOverflow)
				}
				if err := appendPiece(i, op.Kind, kept, lo, pieceReadLo, pieceReadHi, true); err != nil {
					return nil, err
				}
				haveMatch = true
			}
			refPos = refEnd
			next, ok := add64(readPos, op.Length)
			if !ok {
				return nil, opErr(i, ErrOverflow)
			}
			readPos = next

		default: // D / N：只消费参考，按交集截断，保留后不删除首尾缺口。
			refEnd, ok := add64(refPos, op.Length)
			if !ok {
				return nil, opErr(i, ErrOverflow)
			}
			if lo, _, kept := intersect(refPos, refEnd, L, R); kept > 0 {
				if err := appendPiece(i, op.Kind, kept, lo, 0, 0, false); err != nil {
					return nil, err
				}
			}
			refPos = refEnd
		}
	}

	// 没有任何 M/=/X 保留：明确 empty，不用纯 I 或 D/N 伪造比对。
	if !haveMatch {
		return &Clipped{Empty: true}, nil
	}

	out.Empty = false
	out.RefStart = newStart
	out.ReadRetained = haveRead
	if haveRead {
		out.ReadStart = readLo
		out.ReadEnd = readHi
		out.Bases = r.Bases[readLo:readHi]
		out.Qualities = r.Qualities[readLo:readHi]
	}
	out.segs = buildSegs(out.CIGAR, newStart)
	return out, nil
}
