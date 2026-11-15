package dataeng

import (
	"math"
	"testing"
)

// TestUnpackedWireCompatibility 手工构造非 packed（逐元素 varint）的
// tags/geometry 编码，验证解码器兼容旧/非规范编码。
func TestUnpackedWireCompatibility(t *testing.T) {
	w := &protoWriter{}
	// Feature: id=5, 非 packed tags [0,0]，type=POINT，
	// 非 packed geometry [9,50,60]（MoveTo 1 点 + 两个 zigzag 参数）。
	fw := &protoWriter{}
	fw.uint64Varint(fieldFeatureID, 5)
	fw.uint32Varint(fieldFeatureTags, 0)
	fw.uint32Varint(fieldFeatureTags, 0)
	fw.uint32Varint(fieldFeatureType, uint32(GeomTypePoint))
	for _, g := range []uint32{9, 50, 60} {
		fw.uint32Varint(fieldFeatureGeometry, g)
	}

	lw := &protoWriter{}
	lw.string_(fieldLayerName, "legacy")
	lw.bytes(fieldLayerFeatures, fw.buf)
	lw.string_(fieldLayerKeys, "k")
	vw := &protoWriter{}
	vw.string_(fieldValueString, "v")
	lw.bytes(fieldLayerValues, vw.buf)

	w.bytes(fieldTileLayers, lw.buf)

	tile, err := Unmarshal(w.buf)
	if err != nil {
		t.Fatalf("unpacked decode failed: %v", err)
	}
	feature := tile.Layers[0].Features[0]
	if feature.ID != 5 || !feature.HasID || feature.Type != GeomTypePoint {
		t.Fatalf("feature header mismatch: %+v", feature)
	}
	if len(feature.Tags) != 2 || feature.Tags[0] != 0 || feature.Tags[1] != 0 {
		t.Fatalf("unpacked tags mismatch: %v", feature.Tags)
	}
	if len(feature.Geometry) != 3 || feature.Geometry[0] != 9 ||
		feature.Geometry[1] != 50 || feature.Geometry[2] != 60 {
		t.Fatalf("unpacked geometry mismatch: %v", feature.Geometry)
	}

	// 合并路径同样接受该瓦片，且输出 tag 仍有效。
	merged, err := Merge(tile)
	if err != nil {
		t.Fatalf("merge legacy tile failed: %v", err)
	}
	if _, err := Marshal(merged); err != nil {
		t.Fatalf("re-marshal legacy tile failed: %v", err)
	}
}

func TestValueOrderingIsTotalAndStable(t *testing.T) {
	nan32 := float32(math.NaN())
	nan64 := math.NaN()
	values := []Value{
		NewBoolValue(true),
		NewSintValue(-2),
		NewUintValue(9),
		NewIntValue(-7),
		NewDoubleValue(nan64),
		NewFloatValue(nan32),
		NewStringValue("z"),
		NewStringValue("a"),
		NewBoolValue(false),
		NewSintValue(2),
		NewUintValue(1),
		NewIntValue(7),
		NewDoubleValue(-1.5),
		NewFloatValue(1.5),
	}
	sortValues(values)

	// 类型块必须按字段号秩分组。
	ranks := make([]uint8, len(values))
	for i, v := range values {
		ranks[i] = v.valueRank()
	}
	for i := 1; i < len(ranks); i++ {
		if ranks[i] < ranks[i-1] {
			t.Fatalf("type blocks out of order: %v", ranks)
		}
	}

	// NaN 参与排序但确定可重现。
	sortValues(values)
	ranks2 := make([]uint8, len(values))
	for i, v := range values {
		ranks2[i] = v.valueRank()
	}
	for i := range ranks {
		if ranks[i] != ranks2[i] {
			t.Fatal("value ordering not stable across repeated sorts")
		}
	}

	// 同类型内载荷有序：字符串 a < z。
	if *values[0].StringValue != "a" || *values[1].StringValue != "z" {
		t.Fatalf("string payload order wrong: %q %q", *values[0].StringValue, *values[1].StringValue)
	}
}

func TestDefaultExtentAndVersion(t *testing.T) {
	data, err := Marshal(&Tile{Layers: []*Layer{{
		Name:   "d",
		Keys:   []string{"k"},
		Values: []Value{NewStringValue("v")},
		Features: []*Feature{{
			HasID:    true,
			ID:       1,
			Type:     GeomTypePoint,
			Tags:     []uint32{0, 0},
			Geometry: pointGeometry([2]int32{1, 1}),
		}},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	tile, err := Unmarshal(data)
	if err != nil {
		t.Fatal(err)
	}
	layer := tile.Layers[0]
	if layer.Extent != defaultExtent || layer.Version != defaultVersion {
		t.Fatalf("defaults not applied: extent=%d version=%d", layer.Extent, layer.Version)
	}

	// 省略 extent 的 fragment 与显式 4096 的 fragment 视为同网格，应按 ID 合并。
	other, err := Unmarshal(data)
	if err != nil {
		t.Fatal(err)
	}
	merged, err := Merge(tile, other)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(merged.Layers[0].Features); got != 1 {
		t.Fatalf("default extent fragments should merge by ID, got %d features", got)
	}
}

func TestDuplicateTagPairsDeduplicate(t *testing.T) {
	layer := &Layer{
		Name:   "dup",
		Extent: 4096,
		Keys:   []string{"k"},
		Values: []Value{NewStringValue("v")},
		Features: []*Feature{{
			HasID:    true,
			ID:       1,
			Type:     GeomTypePoint,
			Tags:     []uint32{0, 0, 0, 0},
			Geometry: pointGeometry([2]int32{1, 1}),
		}},
	}
	merged, err := Merge(&Tile{Layers: []*Layer{layer}})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(merged.Layers[0].Features[0].Tags); got != 2 {
		t.Fatalf("duplicate tag pairs must collapse to one, got %d tags", got)
	}
}
