package dataeng

import (
	"reflect"
	"testing"
)

const math32min = -2147483648

func TestGeometryConcatOnlyWhenExtentMatches(t *testing.T) {
	makeLayer := func(extent uint32) *Layer {
		return &Layer{
			Name:   "road",
			Extent: extent,
			Keys:   []string{"seg"},
			Values: []Value{NewStringValue("a")},
			Features: []*Feature{{
				HasID:    true,
				ID:       7,
				Type:     GeomTypeLine,
				Tags:     []uint32{0, 0},
				Geometry: lineGeometry(),
			}},
		}
	}

	merged, err := Merge(
		&Tile{Layers: []*Layer{makeLayer(4096)}},
		&Tile{Layers: []*Layer{makeLayer(4096)}},
	)
	if err != nil {
		t.Fatalf("Merge returned error: %v", err)
	}
	features := merged.Layers[0].Features
	if len(features) != 1 {
		t.Fatalf("same-extent same-ID features must merge: got %d features", len(features))
	}
	wantGeom := ConcatGeometry(lineGeometry(), lineGeometry())
	if !reflect.DeepEqual(features[0].Geometry, wantGeom) {
		t.Fatalf("geometry command streams not concatenated: got %v want %v",
			features[0].Geometry, wantGeom)
	}

	merger := NewMerger()
	if err := merger.AddLayer(makeLayer(4096)); err != nil {
		t.Fatal(err)
	}
	if err := merger.AddLayer(makeLayer(8192)); err != nil {
		t.Fatal(err)
	}
	mismatched := merger.Build()
	features = mismatched.Layers[0].Features
	if len(features) != 2 {
		t.Fatalf("different-extent features must stay separate: got %d", len(features))
	}
	if !reflect.DeepEqual(features[0].Geometry, lineGeometry()) ||
		!reflect.DeepEqual(features[1].Geometry, lineGeometry()) {
		t.Fatal("extent mismatch must never concatenate geometry")
	}
}

func TestDifferentGeomTypeWithSameIDStaysSeparate(t *testing.T) {
	base := func(geomType GeomType) *Layer {
		return &Layer{
			Name:   "mix",
			Extent: 4096,
			Keys:   []string{"k"},
			Values: []Value{NewStringValue("v")},
			Features: []*Feature{{
				HasID:    true,
				ID:       1,
				Type:     geomType,
				Tags:     []uint32{0, 0},
				Geometry: pointGeometry([2]int32{1, 1}),
			}},
		}
	}
	merged, err := Merge(
		&Tile{Layers: []*Layer{base(GeomTypePoint)}},
		&Tile{Layers: []*Layer{base(GeomTypeLine)}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(merged.Layers[0].Features); got != 2 {
		t.Fatalf("same ID different geom type must stay separate: got %d", got)
	}
}

func TestZigzagAndCommandRoundTrip(t *testing.T) {
	cases := []int32{0, 1, -1, 2, -2, 2047, -2048, math32min}
	for _, v := range cases {
		if DecodeZigzag32(EncodeZigzag32(v)) != v {
			t.Fatalf("zigzag round trip failed for %d", v)
		}
	}
	ci := CommandInteger(CommandLineTo, 4)
	if CommandID(ci) != CommandLineTo || CommandCount(ci) != 4 {
		t.Fatalf("command integer packing failed: %d", ci)
	}
	if err := validateGeometry(lineGeometry()); err != nil {
		t.Fatalf("valid geometry rejected: %v", err)
	}
	if err := validateGeometry([]uint32{CommandInteger(CommandMoveTo, 2), 1}); err == nil {
		t.Fatal("truncated geometry must be rejected")
	}
	if err := validateGeometry([]uint32{CommandInteger(CommandClosePath, 2)}); err == nil {
		t.Fatal("ClosePath count != 1 must be rejected")
	}
}
