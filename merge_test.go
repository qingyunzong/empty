package dataeng

import (
	"reflect"
	"testing"
)

// pointGeometry 构造多点 MoveTo 的 MVT 几何 command 流。
func pointGeometry(coords ...[2]int32) []uint32 {
	geom := []uint32{CommandInteger(CommandMoveTo, uint32(len(coords)))}
	for _, c := range coords {
		geom = append(geom, EncodeZigzag32(c[0]), EncodeZigzag32(c[1]))
	}
	return geom
}

func lineGeometry() []uint32 {
	return []uint32{
		CommandInteger(CommandMoveTo, 1), EncodeZigzag32(2), EncodeZigzag32(2),
		CommandInteger(CommandLineTo, 2),
		EncodeZigzag32(3), EncodeZigzag32(0),
		EncodeZigzag32(0), EncodeZigzag32(3),
	}
}

func TestMergeRebuildsDictionariesAndTags(t *testing.T) {
	layerA := &Layer{
		Name:   "water",
		Extent: 4096,
		Keys:   []string{"kind", "rank"},
		Values: []Value{NewStringValue("lake"), NewIntValue(2)},
		Features: []*Feature{{
			HasID:    true,
			ID:       10,
			Type:     GeomTypePoint,
			Tags:     []uint32{0, 0, 1, 1},
			Geometry: pointGeometry([2]int32{1, 2}),
		}},
	}
	layerB := &Layer{
		Name:   "water",
		Extent: 4096,
		Keys:   []string{"rank", "name"},
		Values: []Value{NewIntValue(5), NewStringValue("blue")},
		Features: []*Feature{{
			HasID:    true,
			ID:       11,
			Type:     GeomTypePoint,
			Tags:     []uint32{0, 0, 1, 1},
			Geometry: pointGeometry([2]int32{9, 8}),
		}},
	}

	merged, err := Merge(&Tile{Layers: []*Layer{layerA}}, &Tile{Layers: []*Layer{layerB}})
	if err != nil {
		t.Fatalf("Merge returned error: %v", err)
	}
	if len(merged.Layers) != 1 {
		t.Fatalf("expected 1 layer, got %d", len(merged.Layers))
	}
	layer := merged.Layers[0]

	wantKeys := []string{"kind", "name", "rank"}
	if !reflect.DeepEqual(layer.Keys, wantKeys) {
		t.Fatalf("keys not stably sorted: got %v want %v", layer.Keys, wantKeys)
	}
	// 类型秩按 MVT Value 字段号：string(1) 先于 int(4)；同类型按载荷排序。
	wantValues := []Value{NewStringValue("blue"), NewStringValue("lake"), NewIntValue(2), NewIntValue(5)}
	if !reflect.DeepEqual(layer.Values, wantValues) {
		t.Fatalf("values not stably sorted: got %v want %v", layer.Values, wantValues)
	}
	if len(layer.Features) != 2 {
		t.Fatalf("expected 2 features, got %d", len(layer.Features))
	}
	for fi, feature := range layer.Features {
		if len(feature.Tags)%2 != 0 {
			t.Fatalf("feature %d odd tags", fi)
		}
		for ti := 0; ti < len(feature.Tags); ti += 2 {
			if feature.Tags[ti] >= uint32(len(layer.Keys)) {
				t.Fatalf("feature %d key tag out of range", fi)
			}
			if feature.Tags[ti+1] >= uint32(len(layer.Values)) {
				t.Fatalf("feature %d value tag out of range", fi)
			}
		}
	}

	first := layer.Features[0]
	wantFirstTags := []uint32{0, 1, 2, 2} // kind=lake, rank=2
	if !reflect.DeepEqual(first.Tags, wantFirstTags) {
		t.Fatalf("renumbered tags mismatch: got %v want %v", first.Tags, wantFirstTags)
	}
	second := layer.Features[1]
	wantSecondTags := []uint32{2, 3, 1, 0} // rank=5, name=blue
	if !reflect.DeepEqual(second.Tags, wantSecondTags) {
		t.Fatalf("renumbered tags mismatch: got %v want %v", second.Tags, wantSecondTags)
	}
}

func TestValueTypeIsNotMergedByText(t *testing.T) {
	values := []Value{
		NewStringValue("1"),
		NewFloatValue(1),
		NewDoubleValue(1),
		NewIntValue(1),
		NewUintValue(1),
		NewSintValue(1),
		NewBoolValue(true),
		NewStringValue("1"),
		NewIntValue(1),
		NewBoolValue(false),
		NewIntValue(0),
	}
	acc := &layerAcc{
		keyIndex:   map[string]int{},
		valueIndex: map[valueKey]int{},
	}
	for _, value := range values {
		acc.registerValue(value)
	}
	if len(acc.values) != 9 {
		t.Fatalf("typed dedup: got %d distinct values, want 9", len(acc.values))
	}

	// 显式零值必须保留，不能因 proto 默认值语义被吞掉。
	zeroLayer := &Layer{
		Name:   "l",
		Extent: 4096,
		Keys:   []string{"a", "b", "c", "d", "e"},
		Values: []Value{
			NewStringValue(""),
			NewIntValue(0),
			NewUintValue(0),
			NewBoolValue(false),
			NewSintValue(0),
		},
		Features: []*Feature{{
			Type:     GeomTypePoint,
			Tags:     []uint32{0, 0, 1, 1, 2, 2, 3, 3, 4, 4},
			Geometry: pointGeometry([2]int32{0, 0}),
		}},
	}
	merged, err := Merge(&Tile{Layers: []*Layer{zeroLayer}})
	if err != nil {
		t.Fatalf("Merge returned error: %v", err)
	}
	if got := len(merged.Layers[0].Values); got != 5 {
		t.Fatalf("explicit zero values must survive: got %d", got)
	}
}
