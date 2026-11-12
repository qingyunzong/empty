package dataeng

// validate 按契约校验原始记录，所有长度求和均做溢出检查。
func validate(r *Record) error {
	if r == nil {
		return ErrNilRecord
	}
	n := len(r.CIGAR)
	if n == 0 {
		return opErr(-1, ErrEmptyCIGAR)
	}

	// H 仅可出现在前缀 H 段或后缀 H 段。
	prefixH := 0
	for prefixH < n && r.CIGAR[prefixH].Kind == OpHardClip {
		prefixH++
	}
	suffixH := 0
	for suffixH < n && r.CIGAR[n-1-suffixH].Kind == OpHardClip {
		suffixH++
	}

	// 去掉 H 后的序列边界 [nonHLo, nonHHi)；S 只能落在其两端的 S 段。
	nonHLo, nonHHi := prefixH, n-suffixH
	firstNonS, lastNonS := nonHHi, nonHLo
	for i := nonHLo; i < nonHHi; i++ {
		if r.CIGAR[i].Kind != OpSoftClip {
			firstNonS = i
			break
		}
	}
	for i := nonHHi - 1; i >= nonHLo; i-- {
		if r.CIGAR[i].Kind != OpSoftClip {
			lastNonS = i + 1
			break
		}
	}

	var readLen, refLen uint64
	for i, op := range r.CIGAR {
		if !op.Kind.Valid() {
			return opErr(i, ErrUnknownOp)
		}
		if op.Length == 0 {
			return opErr(i, ErrZeroLength)
		}
		if i > 0 && r.CIGAR[i-1].Kind == op.Kind {
			return opErr(i, ErrAdjacentSameOp)
		}
		if op.Kind == OpHardClip && !(i < prefixH || i >= n-suffixH) {
			return opErr(i, ErrHardClipPosition)
		}
		if op.Kind == OpSoftClip && i >= firstNonS && i < lastNonS {
			return opErr(i, ErrSoftClipPosition)
		}
		if op.Kind.ConsumesRead() {
			next, ok := add64(readLen, op.Length)
			if !ok {
				return opErr(i, ErrOverflow)
			}
			readLen = next
		}
		if op.Kind.ConsumesRef() {
			next, ok := add64(refLen, op.Length)
			if !ok {
				return opErr(i, ErrOverflow)
			}
			refLen = next
		}
	}

	// 末端点 s + 参考消费总长必须可表示。
	if _, ok := add64(r.RefStart, refLen); !ok {
		return opErr(-1, ErrOverflow)
	}
	if readLen != uint64(len(r.Bases)) {
		return opErr(-1, ErrReadLengthMismatch)
	}
	if len(r.Qualities) != len(r.Bases) {
		return opErr(-1, ErrQualityLenMismatch)
	}
	return nil
}
