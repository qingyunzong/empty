package dataeng

// Ingest 校验并原子提交一段。任一项校验失败时整段不生效：缓存、活动顺序、
// 样本计数与已提交段号都保持上一段状态，调用方可修正后用原段号重试。
func (e *Engine) Ingest(seg Segment) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if err := validateSegmentHeader(seg); err != nil {
		return err
	}
	if seg.SegmentNumber <= e.lastSegment {
		return wrapf(ErrDuplicateSegment, "segment %d is not greater than last committed %d", seg.SegmentNumber, e.lastSegment)
	}

	// 第一遍：拒绝同段重复路径。路径是不透明非空 UTF-8 身份。
	seen := make(map[string]struct{}, len(seg.Updates))
	for _, u := range seg.Updates {
		if u.Path == "" {
			return wrapf(ErrInvalidArgument, "segment %d contains empty channel path", seg.SegmentNumber)
		}
		if _, dup := seen[u.Path]; dup {
			return wrapf(ErrDuplicatePath, "segment %d repeats path %q", seg.SegmentNumber, u.Path)
		}
		seen[u.Path] = struct{}{}
	}

	// 暂存本次 new 出来的索引与活动顺序，全部成功后才并入引擎状态。
	stagedIndexes := make(map[string]indexEntry)
	var activeOrder []string

	resolve := func(path string) (indexEntry, bool) {
		if idx, ok := stagedIndexes[path]; ok {
			return idx, true
		}
		idx, ok := e.indexes[path]
		return idx, ok
	}

	if seg.NewList {
		// newList=true：活动顺序恰为更新列表中非 none 的路径顺序，省略路径不参与本段。
		for _, u := range seg.Updates {
			switch u.Kind {
			case IndexNew:
				idx, err := buildNewIndex(seg, u)
				if err != nil {
					return err
				}
				if err := checkTypeAndEndian(seg, u.Path, idx, resolve); err != nil {
					return err
				}
				stagedIndexes[u.Path] = idx
				activeOrder = append(activeOrder, u.Path)
			case IndexReuse:
				idx, ok := resolve(u.Path)
				if !ok {
					return wrapf(ErrReuseWithoutIndex, "segment %d reuse of %q has no prior new", seg.SegmentNumber, u.Path)
				}
				if idx.endian != seg.Endian {
					return wrapf(ErrTypeConflict, "segment %d reuses %q endian %v, segment requires %v", seg.SegmentNumber, u.Path, idx.endian, seg.Endian)
				}
				activeOrder = append(activeOrder, u.Path)
			case IndexNone:
				// newList 下 none 路径不进入活动顺序，也不改动缓存。
			default:
				return wrapf(ErrInvalidArgument, "segment %d update %q has unknown index kind %d", seg.SegmentNumber, u.Path, u.Kind)
			}
		}
	} else {
		// newList=false：先继承上一段活动顺序，已有路径保持原位置。
		activeOrder = append(activeOrder, e.activeOrder...)
		position := make(map[string]int, len(activeOrder))
		for i, p := range activeOrder {
			position[p] = i
		}

		for _, u := range seg.Updates {
			switch u.Kind {
			case IndexNew:
				idx, err := buildNewIndex(seg, u)
				if err != nil {
					return err
				}
				if err := checkTypeAndEndian(seg, u.Path, idx, resolve); err != nil {
					return err
				}
				stagedIndexes[u.Path] = idx
				if _, present := position[u.Path]; !present {
					position[u.Path] = len(activeOrder)
					activeOrder = append(activeOrder, u.Path)
				}
			case IndexReuse:
				idx, ok := resolve(u.Path)
				if !ok {
					return wrapf(ErrReuseWithoutIndex, "segment %d reuse of %q has no prior new", seg.SegmentNumber, u.Path)
				}
				if idx.endian != seg.Endian {
					return wrapf(ErrTypeConflict, "segment %d reuses %q endian %v, segment requires %v", seg.SegmentNumber, u.Path, idx.endian, seg.Endian)
				}
				if _, present := position[u.Path]; !present {
					position[u.Path] = len(activeOrder)
					activeOrder = append(activeOrder, u.Path)
				}
			case IndexNone:
				// none 把路径从本段活动顺序移除，但保留最近 new 缓存。
				if idx, present := position[u.Path]; present {
					activeOrder = append(activeOrder[:idx], activeOrder[idx+1:]...)
					delete(position, u.Path)
					for p, i := range position {
						if i > idx {
							position[p] = i - 1
						}
					}
				}
			default:
				return wrapf(ErrInvalidArgument, "segment %d update %q has unknown index kind %d", seg.SegmentNumber, u.Path, u.Kind)
			}
		}
	}

	if len(activeOrder) > e.budget.MaxChannelsPerSegment {
		return wrapf(ErrBudgetExceeded, "segment %d has %d active channels, budget %d", seg.SegmentNumber, len(activeOrder), e.budget.MaxChannelsPerSegment)
	}

	// 组装活动通道解析结果；交错布局要求所有活动通道 n 相同。
	active := make([]*channelInSegment, 0, len(activeOrder))
	byPath := make(map[string]*channelInSegment, len(activeOrder))
	var commonN int64
	for i, path := range activeOrder {
		idx, ok := resolve(path)
		if !ok {
			return wrapf(ErrReuseWithoutIndex, "segment %d active path %q has no resolved index", seg.SegmentNumber, path)
		}
		ch := &channelInSegment{
			path:            path,
			typeName:        idx.typeName,
			endian:          idx.endian,
			samplesPerChunk: idx.samplesPerChunk,
			width:           idx.typeName.Width(),
		}
		active = append(active, ch)
		byPath[path] = ch
		if seg.Layout == LayoutInterleaved {
			if i == 0 {
				commonN = idx.samplesPerChunk
			} else if idx.samplesPerChunk != commonN {
				return wrapf(ErrRawLayout, "segment %d interleaved channels require equal n, %q has %d want %d", seg.SegmentNumber, path, idx.samplesPerChunk, commonN)
			}
		}
	}

	chunkBytes, interleaveStride, err := computeChunkBytes(seg.Layout, active)
	if err != nil {
		return err
	}

	// 原始区必须是完整 chunk 的整数倍，不允许短尾；活动为空只允许空原始区。
	if len(active) == 0 {
		if seg.RawLength != 0 {
			return wrapf(ErrRawLayout, "segment %d has no active channels but raw length %d", seg.SegmentNumber, seg.RawLength)
		}
	} else if seg.RawLength > 0 {
		if seg.RawLength%chunkBytes != 0 {
			return wrapf(ErrRawLayout, "segment %d raw length %d is not a multiple of chunk bytes %d", seg.SegmentNumber, seg.RawLength, chunkBytes)
		}
	}

	var chunks int64
	if chunkBytes > 0 && seg.RawLength > 0 {
		chunks = seg.RawLength / chunkBytes
	}
	if chunks > e.budget.MaxChunksPerSegment {
		return wrapf(ErrBudgetExceeded, "segment %d has %d chunks, budget %d", seg.SegmentNumber, chunks, e.budget.MaxChunksPerSegment)
	}

	// 物理窗口与寻址乘法在读取前统一做溢出检查。
	if _, err := add64(seg.RawOffset, seg.RawLength); err != nil {
		return wrapf(err, "segment %d raw window exceeds address space", seg.SegmentNumber)
	}

	// 填充块内偏移与样本步长。
	switch seg.Layout {
	case LayoutContiguous:
		var off int64
		for _, ch := range active {
			ch.offsetInChunk = off
			ch.sampleStride = int64(ch.width)
			channelBytes, mErr := mul64(ch.samplesPerChunk, int64(ch.width))
			if mErr != nil {
				return wrapf(mErr, "segment %d channel %q addressing", seg.SegmentNumber, ch.path)
			}
			off, mErr = add64(off, channelBytes)
			if mErr != nil {
				return wrapf(mErr, "segment %d channel %q offset", seg.SegmentNumber, ch.path)
			}
		}
	case LayoutInterleaved:
		var off int64
		for _, ch := range active {
			ch.offsetInChunk = off
			ch.sampleStride = interleaveStride
			off += int64(ch.width)
		}
	}

	// 计算每路径本段样本数与起始逻辑样本号；暂停不补零、新 n 不重分块。
	count := make(map[string]int64, len(active))
	firstLogical := make(map[string]int64, len(active))
	for _, ch := range active {
		added, mErr := mul64(chunks, ch.samplesPerChunk)
		if mErr != nil {
			return wrapf(mErr, "segment %d channel %q sample count", seg.SegmentNumber, ch.path)
		}
		count[ch.path] = added
		firstLogical[ch.path] = e.totalSamples[ch.path]
		if _, aErr := add64(firstLogical[ch.path], added); aErr != nil {
			return wrapf(ErrAddressOverflow, "segment %d channel %q logical counter overflow", seg.SegmentNumber, ch.path)
		}
	}

	// 缓存预算按最终 distinct new 路径数检查，失败段不占用预算。
	newEntries := 0
	for path := range stagedIndexes {
		if _, existed := e.indexes[path]; !existed {
			newEntries++
		}
	}
	if len(e.indexes)+newEntries > e.budget.MaxCachedIndexes {
		return wrapf(ErrBudgetExceeded, "segment %d would cache %d indexes, budget %d", seg.SegmentNumber, len(e.indexes)+newEntries, e.budget.MaxCachedIndexes)
	}

	// 全部校验通过，原子提交：先落不可变段记录，再更新缓存、顺序与计数。
	record := &segmentRecord{
		segmentNumber: seg.SegmentNumber,
		endian:        seg.Endian,
		layout:        seg.Layout,
		reader:        seg.Reader,
		rawOffset:     seg.RawOffset,
		rawLength:     seg.RawLength,
		chunkBytes:    chunkBytes,
		chunks:        chunks,
		active:        active,
		channelByPath: byPath,
		firstLogical:  firstLogical,
		count:         count,
	}

	segIdx := len(e.segments)
	e.segments = append(e.segments, record)
	for path, idx := range stagedIndexes {
		e.indexes[path] = idx
	}
	for _, ch := range active {
		e.totalSamples[ch.path] += count[ch.path]
		e.pathSegments[ch.path] = append(e.pathSegments[ch.path], segIdx)
	}
	e.activeOrder = activeOrder
	e.lastSegment = seg.SegmentNumber
	return nil
}
