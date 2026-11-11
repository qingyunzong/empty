package q259

import (
	"fmt"
	"image"
	"sort"
	"sync"
)

const headerSize = 4 // uint16 width + uint16 height

type objectKey struct {
	id      uint16
	version uint32
}

// fragment 保存一个已校验的分片。
type fragment struct {
	offset uint32
	data   []byte
	seq    uint64 // 到达序号，用于 LRU
}

// objectState 是某一 (对象ID, 版本) 的重组状态。
type objectState struct {
	id          uint16
	version     uint32
	totalLength uint32
	frags       []fragment
	lastSeq     uint64
}

type paletteEntry struct {
	palette *Palette
	lastSeq uint64
}

// Decoder 是字幕位图流解码器。零值不可用，请使用 NewDecoder 创建。
// 所有方法均可安全并发调用。
type Decoder struct {
	mu sync.Mutex

	objects  map[objectKey]*objectState
	palettes map[uint32]*paletteEntry

	displayList *DisplayList

	// objectLimit <= 0 表示不限制对象缓存条数。
	objectLimit int
	seq         uint64
}

// NewDecoder 创建一个空解码器。
func NewDecoder() *Decoder {
	return &Decoder{
		objects:  make(map[objectKey]*objectState),
		palettes: make(map[uint32]*paletteEntry),
	}
}

// SetCacheLimit 设置对象缓存的最大条目数。超出时按最久未使用回收未被
// 待显示列表钉住的条目；limit <= 0 表示不限制。
func (d *Decoder) SetCacheLimit(limit int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.objectLimit = limit
	d.enforceObjectLimitLocked()
}

// AddObject 接收一个对象定义分片。相同 (ID, Version) 的分片按 Offset
// 重组；同 ID 不同版本彼此独立，可交错到达。
func (d *Decoder) AddObject(f ObjectFragment) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if f.TotalLength < headerSize {
		return fmt.Errorf("%w: total length %d too small", ErrInvalidObject, f.TotalLength)
	}
	dataLen := uint64(len(f.Data))
	if dataLen > uint64(f.TotalLength) ||
		uint64(f.Offset)+dataLen > uint64(f.TotalLength) {
		return fmt.Errorf("%w: fragment offset=%d len=%d exceeds total=%d",
			ErrInvalidFragment, f.Offset, len(f.Data), f.TotalLength)
	}

	key := objectKey{f.ID, f.Version}
	state := d.objects[key]
	if state == nil {
		state = &objectState{
			id:          f.ID,
			version:     f.Version,
			totalLength: f.TotalLength,
		}
		d.objects[key] = state
	} else if state.totalLength != f.TotalLength {
		// 同一对象版本的总长是定义的一部分，不允许中途变化。
		return fmt.Errorf("%w: total length changed from %d to %d",
			ErrInvalidFragment, state.totalLength, f.TotalLength)
	}

	// 与既有分片做重叠校验：重叠字节必须逐字节一致。
	for _, old := range state.frags {
		overlapStart := maxU32(f.Offset, old.offset)
		overlapEnd := minU32(f.Offset+uint32(dataLen), old.offset+uint32(len(old.data)))
		if overlapStart >= overlapEnd {
			continue
		}
		newAt := overlapStart - f.Offset
		oldAt := overlapStart - old.offset
		span := overlapEnd - overlapStart
		for i := uint32(0); i < span; i++ {
			if f.Data[newAt+i] != old.data[oldAt+i] {
				return fmt.Errorf("%w: object %d version %d at offset %d",
					ErrInconsistentFragment, f.ID, f.Version, overlapStart+i)
			}
		}
	}

	// 完全重复（同偏移、同长度）的分片视为重传，不再存储。
	duplicate := false
	for _, old := range state.frags {
		if old.offset == f.Offset && len(old.data) == len(f.Data) {
			duplicate = true
			break
		}
	}
	if !duplicate {
		d.seq++
		state.frags = append(state.frags, fragment{
			offset: f.Offset,
			data:   append([]byte(nil), f.Data...),
			seq:    d.seq,
		})
	}

	d.seq++
	state.lastSeq = d.seq
	d.enforceObjectLimitLocked()
	return nil
}

// AddPalette 接收一个调色板版本，替换同版本的旧内容。
func (d *Decoder) AddPalette(p *Palette) error {
	if p == nil {
		return fmt.Errorf("%w: nil palette", ErrInvalidPalette)
	}
	if p.TransparentIndex < -1 || p.TransparentIndex > 255 {
		return fmt.Errorf("%w: transparent index %d out of range",
			ErrInvalidPalette, p.TransparentIndex)
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	d.seq++
	d.palettes[p.Version] = &paletteEntry{palette: clonePalette(p), lastSeq: d.seq}
	return nil
}

// SetDisplayList 登记待合成的显示列表。它只固定引用关系，不立即合成；
// 引用的对象与调色板会被钉住，直到合成成功或列表被替换。
func (d *Decoder) SetDisplayList(list *DisplayList) error {
	if list == nil {
		return fmt.Errorf("%w: nil display list", ErrInvalidDisplayList)
	}
	if list.Width <= 0 || list.Height <= 0 {
		return fmt.Errorf("%w: canvas %dx%d must be positive",
			ErrInvalidDisplayList, list.Width, list.Height)
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	cp := *list
	cp.Objects = append([]DisplayObject(nil), list.Objects...)
	d.displayList = &cp
	return nil
}

// EvictObject 回收指定对象版本。被待显示列表引用时返回 ErrPinned。
func (d *Decoder) EvictObject(id uint16, version uint32) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	key := objectKey{id, version}
	if _, ok := d.objects[key]; !ok {
		return nil
	}
	if d.isObjectPinnedLocked(key) {
		return fmt.Errorf("%w: object %d version %d", ErrPinned, id, version)
	}
	delete(d.objects, key)
	return nil
}

// EvictPalette 回收指定调色板版本。被待显示列表引用时返回 ErrPinned。
func (d *Decoder) EvictPalette(version uint32) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if _, ok := d.palettes[version]; !ok {
		return nil
	}
	if d.isPalettePinnedLocked(version) {
		return fmt.Errorf("%w: palette version %d", ErrPinned, version)
	}
	delete(d.palettes, version)
	return nil
}

// End 处理结束标记：仅当显示列表引用的全部对象与调色板齐备时，合成并
// 返回预乘 RGBA 画布。任何对象越界都会整次拒绝、不产生部分画面；合成
// 成功后待显示列表被清除，缓存对象与调色板保留。
func (d *Decoder) End() (*image.RGBA, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.displayList == nil {
		return nil, fmt.Errorf("%w: no display list", ErrNotReady)
	}
	list := d.displayList

	type placed struct {
		pixels []uint8 // 行优先索引，长度 width*height
		width  int
		height int
		item   DisplayObject
	}
	placedList := make([]placed, 0, len(list.Objects))

	// 先解析全部对象并做边界检查，任一越界则整次拒绝、不产生部分画面。
	for _, item := range list.Objects {
		key := objectKey{item.ObjectID, item.ObjectVersion}
		state := d.objects[key]
		if state == nil || !state.complete() {
			return nil, fmt.Errorf("%w: object %d version %d",
				ErrNotReady, item.ObjectID, item.ObjectVersion)
		}
		if _, ok := d.palettes[item.PaletteVersion]; !ok {
			return nil, fmt.Errorf("%w: palette version %d",
				ErrNotReady, item.PaletteVersion)
		}

		def := state.assemble()
		width := int(uint16(def[0])<<8 | uint16(def[1]))
		height := int(uint16(def[2])<<8 | uint16(def[3]))
		if width == 0 || height == 0 {
			return nil, fmt.Errorf("%w: object %d has zero dimension",
				ErrInvalidObject, item.ObjectID)
		}
		if item.X < 0 || item.Y < 0 ||
			item.X+width > list.Width || item.Y+height > list.Height {
			return nil, fmt.Errorf("%w: object %d at (%d,%d) size %dx%d on %dx%d",
				ErrOutOfBounds, item.ObjectID, item.X, item.Y,
				width, height, list.Width, list.Height)
		}

		pixels, err := decodeRLE(def[headerSize:], width, height)
		if err != nil {
			return nil, fmt.Errorf("%w: object %d: %v",
				ErrInvalidObject, item.ObjectID, err)
		}
		placedList = append(placedList, placed{
			pixels: pixels,
			width:  width,
			height: height,
			item:   item,
		})
	}

	canvas := image.NewRGBA(image.Rect(0, 0, list.Width, list.Height))
	for _, p := range placedList {
		pal := d.palettes[p.item.PaletteVersion].palette
		drawObject(canvas, p.pixels, p.width, p.height, p.item.X, p.item.Y, pal)
	}

	// 成功后解除钉住：清除待显示列表。
	d.displayList = nil
	return canvas, nil
}

// complete 报告对象定义的全部分片是否已无缝到齐。
func (s *objectState) complete() bool {
	return len(s.frags) > 0 && s.coverage() == s.totalLength
}

// coverage 返回已覆盖的字节数；存在空洞或未覆盖尾部时小于总长。
func (s *objectState) coverage() uint32 {
	if len(s.frags) == 0 {
		return 0
	}
	type span struct{ start, end uint32 }
	spans := make([]span, 0, len(s.frags))
	for _, f := range s.frags {
		spans = append(spans, span{f.offset, f.offset + uint32(len(f.data))})
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })

	covered := uint32(0)
	curStart, curEnd := spans[0].start, spans[0].end
	for _, sp := range spans[1:] {
		if sp.start <= curEnd {
			if sp.end > curEnd {
				curEnd = sp.end
			}
		} else {
			covered += curEnd - curStart
			curStart, curEnd = sp.start, sp.end
		}
	}
	covered += curEnd - curStart
	return covered
}

// assemble 拼接全部分片。调用前必须保证 complete。
func (s *objectState) assemble() []byte {
	buf := make([]byte, s.totalLength)
	for _, f := range s.frags {
		copy(buf[f.offset:], f.data)
	}
	return buf
}

func (d *Decoder) isObjectPinnedLocked(key objectKey) bool {
	if d.displayList == nil {
		return false
	}
	for _, item := range d.displayList.Objects {
		if item.ObjectID == key.id && item.ObjectVersion == key.version {
			return true
		}
	}
	return false
}

func (d *Decoder) isPalettePinnedLocked(version uint32) bool {
	if d.displayList == nil {
		return false
	}
	for _, item := range d.displayList.Objects {
		if item.PaletteVersion == version {
			return true
		}
	}
	return false
}

// enforceObjectLimitLocked 按 LRU 回收未被钉住的对象直到满足上限。
func (d *Decoder) enforceObjectLimitLocked() {
	if d.objectLimit <= 0 || len(d.objects) <= d.objectLimit {
		return
	}
	type cand struct {
		key objectKey
		seq uint64
	}
	candidates := make([]cand, 0, len(d.objects))
	for key, state := range d.objects {
		if d.isObjectPinnedLocked(key) {
			continue
		}
		candidates = append(candidates, cand{key, state.lastSeq})
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].seq < candidates[j].seq
	})
	for _, c := range candidates {
		if len(d.objects) <= d.objectLimit {
			break
		}
		delete(d.objects, c.key)
	}
}

func clonePalette(p *Palette) *Palette {
	cp := *p
	return &cp
}

func minU32(a, b uint32) uint32 {
	if a < b {
		return a
	}
	return b
}

func maxU32(a, b uint32) uint32 {
	if a > b {
		return a
	}
	return b
}
