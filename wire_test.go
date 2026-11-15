package dataeng

import (
	"math"
	"reflect"
	"testing"
)

func TestWireRoundTrip(t *testing.T) {
	original := &Tile{Layers: []*Layer{{
		Version: 2,
		Name:    "places",
		Extent:  2048,
		Keys:    []string{"name", "capital", "neg", "big", "signed", "ratio", "pi", "empty"},
		Values: []Value{
			NewStringValue("Tokyo"),
			NewBoolValue(true),
			NewIntValue(-9),
			NewUintValue(14000000),
			NewSintValue(-3),
			NewFloatValue(1.5),
			NewDoubleValue(math.Pi),
			NewStringValue(""),
		},
		Features: []*Feature{
			{
				HasID: true,
				ID:    42,
				Type:  GeomTypePoint,
				Tags:  []uint32{0, 0, 1, 1, 2, 2, 3, 3},
				Geometry: []uint32{
					CommandInteger(CommandMoveTo, 1),
					EncodeZigzag32(7), EncodeZigzag32(-3),
				},
			},
			{
				Type:     GeomTypeLine,
				Tags:     []uint32{0, 7},
				Geometry: lineGeometry(),
			},
		},
	}}}

	data, err := Marshal(original)
	if err != nil {
		t.Fatalf("Marshal error: %v", err)
	}
	decoded, err := Unmarshal(data)
	if err != nil {
		t.Fatalf("Unmarshal error: %v", err)
	}
	if len(decoded.Layers) != 1 {
		t.Fatalf("layer count mismatch: %d", len(decoded.Layers))
	}
	got := decoded.Layers[0]
	if got.Name != "places" || got.Version != 2 || got.Extent != 2048 {
		t.Fatalf("layer header mismatch: %+v", got)
	}
	if !reflect.DeepEqual(got.Keys, original.Layers[0].Keys) {
		t.Fatalf("keys mismatch: %v", got.Keys)
	}
	if !reflect.DeepEqual(got.Values, original.Layers[0].Values) {
		t.Fatalf("typed values mismatch:\n got %v\nwant %v", got.Values, original.Layers[0].Values)
	}
	if !reflect.DeepEqual(got.Features, original.Layers[0].Features) {
		t.Fatalf("features mismatch:\n got %+v\nwant %+v", got.Features, original.Layers[0].Features)
	}

	// 再编码应当字节确定。
	data2, err := Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(data, data2) {
		t.Fatal("re-marshal is not deterministic")
	}
}

func TestMergeBytesEndToEnd(t *testing.T) {
	buildFragment := func(name string, key string, value Value) []byte {
		tile := &Tile{Layers: []*Layer{{
			Name:   name,
			Extent: 4096,
			Keys:   []string{key, "shared"},
			Values: []Value{value, NewIntValue(1)},
			Features: []*Feature{{
				HasID:    true,
				ID:       3,
				Type:     GeomTypePoint,
				Tags:     []uint32{0, 0, 1, 1},
				Geometry: pointGeometry([2]int32{5, 5}),
			}},
		}}}
		data, err := Marshal(tile)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}

	fragments := [][]byte{
		buildFragment("a", "k1", NewStringValue("1")),
		buildFragment("a", "k2", NewIntValue(1)),
		buildFragment("b", "x", NewBoolValue(true)),
	}
	mergedBytes, err := MergeBytes(fragments...)
	if err != nil {
		t.Fatalf("MergeBytes error: %v", err)
	}
	merged, err := Unmarshal(mergedBytes)
	if err != nil {
		t.Fatalf("merged output is not decodable: %v", err)
	}
	if len(merged.Layers) != 2 ||
		merged.Layers[0].Name != "a" || merged.Layers[1].Name != "b" {
		t.Fatalf("layer ordering/name mismatch: %+v", merged.Layers)
	}
	layerA := merged.Layers[0]
	// 文本 "1" 与 int 1 必须同时存在。
	var sawString, sawInt bool
	for _, value := range layerA.Values {
		if value.StringValue != nil && *value.StringValue == "1" {
			sawString = true
		}
		if value.IntValue != nil && *value.IntValue == 1 {
			sawInt = true
		}
	}
	if !sawString || !sawInt {
		t.Fatalf("typed values collapsed by text: string=%v int=%v", sawString, sawInt)
	}
	// 同 extent 同 ID 两个 fragment 归并为一个 feature，tag 全部有效。
	if len(layerA.Features) != 1 {
		t.Fatalf("expected merged single feature, got %d", len(layerA.Features))
	}
	if len(layerA.Features[0].Tags) != 6 {
		t.Fatalf("expected 3 tag pairs after union, got tags %v", layerA.Features[0].Tags)
	}
	for i := 0; i < len(layerA.Features[0].Tags); i += 2 {
		if layerA.Features[0].Tags[i] >= uint32(len(layerA.Keys)) ||
			layerA.Features[0].Tags[i+1] >= uint32(len(layerA.Values)) {
			t.Fatal("merged feature contains dangling tag reference")
		}
	}
}

func TestRejectsInvalidInputs(t *testing.T) {
	if _, err := Merge(nil); err == nil {
		t.Fatal("nil fragment must error")
	}
	badTag := &Tile{Layers: []*Layer{{
		Name:   "bad",
		Extent: 4096,
		Keys:   []string{"k"},
		Values: []Value{NewStringValue("v")},
		Features: []*Feature{{
			Type: GeomTypePoint,
			Tags: []uint32{0, 9},
		}},
	}}}
	merger := NewMerger()
	if err := merger.AddTile(badTag); err == nil {
		t.Fatal("dangling value tag must error")
	}
	if _, err := Marshal(&Tile{Layers: []*Layer{{Name: ""}}}); err == nil {
		t.Fatal("empty layer name must error")
	}
	if _, err := Unmarshal([]byte{0x08}); err == nil {
		t.Fatal("truncated varint must error")
	}
}
