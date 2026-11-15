package dataeng

import (
	"errors"
	"fmt"
	"sort"
)

var (
	errEmptyLayerName     = errors.New("dataeng: layer name must not be empty")
	errOddTagCount        = errors.New("dataeng: feature tags must be key/value pairs")
	errTagKeyOutOfRange   = errors.New("dataeng: feature tag key index out of range")
	errTagValueOutOfRange = errors.New("dataeng: feature tag value index out of range")
	errGeometryTruncated  = errors.New("dataeng: geometry command is missing parameters")
	errGeometryCloseCount = errors.New("dataeng: ClosePath command count must be 1")
	errGeometryUnknownCmd = errors.New("dataeng: unknown geometry command id")
	errNilFragment        = errors.New("dataeng: nil tile fragment")
	errNilLayer           = errors.New("dataeng: nil layer")
	errNilFeature         = errors.New("dataeng: nil feature")
)

// Merger 增量合并多个 tile fragment。同名 layer 归并为一个输出 layer，
// keys/values 字典在全局重建，所有 feature 的 tag 引用在 Build 时统一重编号。
// 非并发安全，单 goroutine 使用。
type Merger struct {
	order  []string
	layers map[string]*layerAcc
}

// NewMerger 创建空 Merger。
func NewMerger() *Merger {
	return &Merger{layers: make(map[string]*layerAcc)}
}

// Reset 清空已累积的 fragment。
func (m *Merger) Reset() {
	m.order = m.order[:0]
	for k := range m.layers {
		delete(m.layers, k)
	}
}

type tagPair struct {
	key   string
	value Value
}

type mergedFeature struct {
	id       uint64
	hasID    bool
	geomType GeomType
	extent   uint32
	tags     []tagPair
	geometry []uint32
}

type featureKey struct {
	id       uint64
	geomType GeomType
}

type layerAcc struct {
	name    string
	version uint32
	extent  uint32

	features []*mergedFeature
	// index 只登记 extent 与 layer 一致、带 ID 的 feature，
	// 供后续同 extent fragment 按 ID 归并与几何拼接。
	index map[featureKey]int

	keys       []string
	keyIndex   map[string]int
	values     []Value
	valueIndex map[valueKey]int
}

// AddTile 合并一个已解码 tile 中的全部 layer。
func (m *Merger) AddTile(t *Tile) error {
	if t == nil {
		return errNilFragment
	}
	for _, layer := range t.Layers {
		if err := m.AddLayer(layer); err != nil {
			return err
		}
	}
	return nil
}

// AddLayer 合并单个 layer。同名 layer 的 feature 在 extent 一致时按
// (ID, GeomType) 归并，几何 command 直接拼接；extent 不一致则保留为
// 独立 feature，绝不跨尺度拼接。
func (m *Merger) AddLayer(layer *Layer) error {
	if layer == nil {
		return errNilLayer
	}
	if layer.Name == "" {
		return errEmptyLayerName
	}
	acc := m.layers[layer.Name]
	if acc == nil {
		acc = &layerAcc{
			name:       layer.Name,
			version:    layer.EffectiveVersion(),
			extent:     layer.EffectiveExtent(),
			index:      make(map[featureKey]int),
			keyIndex:   make(map[string]int),
			valueIndex: make(map[valueKey]int),
		}
		m.layers[layer.Name] = acc
		m.order = append(m.order, layer.Name)
	}

	layerExtent := layer.EffectiveExtent()

	for fi, feature := range layer.Features {
		if feature == nil {
			return fmt.Errorf("%w: layer %q feature %d", errNilFeature, layer.Name, fi)
		}
		if len(feature.Tags)%2 != 0 {
			return fmt.Errorf("%w: layer %q feature %d", errOddTagCount, layer.Name, fi)
		}
		if err := validateGeometry(feature.Geometry); err != nil {
			return fmt.Errorf("layer %q feature %d: %w", layer.Name, fi, err)
		}

		pairs, err := resolveTags(layer, feature)
		if err != nil {
			return fmt.Errorf("layer %q feature %d: %w", layer.Name, fi, err)
		}
		for _, pair := range pairs {
			acc.registerKey(pair.key)
			acc.registerValue(pair.value)
		}

		key := featureKey{id: feature.ID, geomType: feature.Type}
		mergeable := feature.HasID && feature.Type != GeomTypeUnknown && layerExtent == acc.extent
		if mergeable {
			if pos, ok := acc.index[key]; ok {
				target := acc.features[pos]
				target.tags = appendUniquePairs(target.tags, pairs)
				target.geometry = ConcatGeometry(target.geometry, feature.Geometry)
				continue
			}
		}

		merged := &mergedFeature{
			id:       feature.ID,
			hasID:    feature.HasID,
			geomType: feature.Type,
			extent:   layerExtent,
			tags:     appendUniquePairs(nil, pairs),
			geometry: cloneU32(feature.Geometry),
		}
		pos := len(acc.features)
		acc.features = append(acc.features, merged)
		if mergeable {
			acc.index[key] = pos
		}
	}
	return nil
}

func resolveTags(layer *Layer, feature *Feature) ([]tagPair, error) {
	pairs := make([]tagPair, 0, len(feature.Tags)/2)
	for i := 0; i < len(feature.Tags); i += 2 {
		keyPos := feature.Tags[i]
		valuePos := feature.Tags[i+1]
		if int(keyPos) >= len(layer.Keys) {
			return nil, fmt.Errorf("%w: %d", errTagKeyOutOfRange, keyPos)
		}
		if int(valuePos) >= len(layer.Values) {
			return nil, fmt.Errorf("%w: %d", errTagValueOutOfRange, valuePos)
		}
		value := layer.Values[valuePos]
		if !value.Valid() {
			return nil, fmt.Errorf("layer %q value %d is invalid", layer.Name, valuePos)
		}
		pairs = append(pairs, tagPair{key: layer.Keys[keyPos], value: value})
	}
	return pairs, nil
}

func (acc *layerAcc) registerKey(key string) int {
	if pos, ok := acc.keyIndex[key]; ok {
		return pos
	}
	pos := len(acc.keys)
	acc.keyIndex[key] = pos
	acc.keys = append(acc.keys, key)
	return pos
}

func (acc *layerAcc) registerValue(value Value) int {
	k := value.key()
	if pos, ok := acc.valueIndex[k]; ok {
		return pos
	}
	pos := len(acc.values)
	acc.valueIndex[k] = pos
	acc.values = append(acc.values, value)
	return pos
}

func appendUniquePairs(dst []tagPair, src []tagPair) []tagPair {
	for _, pair := range src {
		exists := false
		for _, existing := range dst {
			if existing.key == pair.key && existing.value.key() == pair.value.key() {
				exists = true
				break
			}
		}
		if !exists {
			dst = append(dst, pair)
		}
	}
	return dst
}

// Build 输出重建后的 Tile：字典稳定排序并对所有 tag 引用重新编号，
// 保证每个 tag 都落在新字典范围内。
func (m *Merger) Build() *Tile {
	out := &Tile{Layers: make([]*Layer, 0, len(m.order))}
	for _, name := range m.order {
		acc := m.layers[name]

		sortedKeys := append([]string(nil), acc.keys...)
		sort.Strings(sortedKeys)
		keyNumber := make(map[string]uint32, len(sortedKeys))
		for i, key := range sortedKeys {
			keyNumber[key] = uint32(i)
		}

		sortedValues := append([]Value(nil), acc.values...)
		sortValues(sortedValues)
		valueNumber := make(map[valueKey]uint32, len(sortedValues))
		for i, value := range sortedValues {
			valueNumber[value.key()] = uint32(i)
		}

		features := make([]*Feature, 0, len(acc.features))
		for _, mf := range acc.features {
			tags := make([]uint32, 0, len(mf.tags)*2)
			for _, pair := range mf.tags {
				tags = append(tags, keyNumber[pair.key], valueNumber[pair.value.key()])
			}
			features = append(features, &Feature{
				ID:       mf.id,
				HasID:    mf.hasID,
				Tags:     tags,
				Type:     mf.geomType,
				Geometry: cloneU32(mf.geometry),
			})
		}

		out.Layers = append(out.Layers, &Layer{
			Version:  acc.version,
			Name:     acc.name,
			Features: features,
			Keys:     sortedKeys,
			Values:   sortedValues,
			Extent:   acc.extent,
		})
	}
	return out
}

// Merge 一次性合并多个已解码 tile fragment。
func Merge(tiles ...*Tile) (*Tile, error) {
	merger := NewMerger()
	for i, tile := range tiles {
		if tile == nil {
			return nil, fmt.Errorf("%w: index %d", errNilFragment, i)
		}
		if err := merger.AddTile(tile); err != nil {
			return nil, err
		}
	}
	return merger.Build(), nil
}

// MergeBytes 直接对接数据入口：输入多个 MVT 编码的 tile fragment，
// 返回合并并重编码后的 MVT 字节流。
func MergeBytes(fragments ...[]byte) ([]byte, error) {
	merger := NewMerger()
	for i, fragment := range fragments {
		if fragment == nil {
			return nil, fmt.Errorf("%w: index %d", errNilFragment, i)
		}
		tile, err := Unmarshal(fragment)
		if err != nil {
			return nil, fmt.Errorf("fragment %d: %w", i, err)
		}
		if err := merger.AddTile(tile); err != nil {
			return nil, fmt.Errorf("fragment %d: %w", i, err)
		}
	}
	return Marshal(merger.Build())
}
