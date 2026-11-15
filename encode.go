package dataeng

import (
	"errors"
	"fmt"
	"math"
)

// Marshal 把 Tile 编码为 MVT protobuf 字节流，并校验字典与 tag 引用，
// 保证输出中所有 tag 都指向有效 key/value。
func Marshal(t *Tile) ([]byte, error) {
	if t == nil {
		return nil, errors.New("dataeng: nil tile")
	}
	if err := validateTile(t); err != nil {
		return nil, err
	}
	outer := &protoWriter{}
	for _, layer := range t.Layers {
		outer.bytes(fieldTileLayers, encodeLayer(layer))
	}
	return outer.buf, nil
}

func validateTile(t *Tile) error {
	for li, layer := range t.Layers {
		if layer == nil {
			return fmt.Errorf("dataeng: layer %d is nil", li)
		}
		if layer.Name == "" {
			return fmt.Errorf("dataeng: layer %d has empty name", li)
		}
		keyCount, valueCount := uint32(len(layer.Keys)), uint32(len(layer.Values))
		for vi, value := range layer.Values {
			if !value.Valid() {
				return fmt.Errorf("dataeng: layer %q value %d is invalid", layer.Name, vi)
			}
		}
		for fi, feature := range layer.Features {
			if feature == nil {
				return fmt.Errorf("dataeng: layer %q feature %d is nil", layer.Name, fi)
			}
			if len(feature.Tags)%2 != 0 {
				return fmt.Errorf("dataeng: layer %q feature %d has odd tag count", layer.Name, fi)
			}
			for ti := 0; ti < len(feature.Tags); ti += 2 {
				if feature.Tags[ti] >= keyCount {
					return fmt.Errorf("dataeng: layer %q feature %d tag references missing key index %d",
						layer.Name, fi, feature.Tags[ti])
				}
				if feature.Tags[ti+1] >= valueCount {
					return fmt.Errorf("dataeng: layer %q feature %d tag references missing value index %d",
						layer.Name, fi, feature.Tags[ti+1])
				}
			}
		}
	}
	return nil
}

func encodeLayer(layer *Layer) []byte {
	w := &protoWriter{}
	// 按字段号顺序输出，保证字节流确定。
	w.string_(fieldLayerName, layer.Name)
	for _, feature := range layer.Features {
		w.bytes(fieldLayerFeatures, encodeFeature(feature))
	}
	for _, key := range layer.Keys {
		w.string_(fieldLayerKeys, key)
	}
	for _, value := range layer.Values {
		w.bytes(fieldLayerValues, encodeValue(value))
	}
	if extent := layer.EffectiveExtent(); extent != 0 {
		w.uint32Varint(fieldLayerExtent, extent)
	}
	if version := layer.EffectiveVersion(); version != 0 {
		w.uint32Varint(fieldLayerVersion, version)
	}
	return w.buf
}

func encodeFeature(feature *Feature) []byte {
	w := &protoWriter{}
	if feature.HasID {
		w.uint64Varint(fieldFeatureID, feature.ID)
	}
	w.packedUint32(fieldFeatureTags, feature.Tags)
	if feature.Type != GeomTypeUnknown {
		w.uint32Varint(fieldFeatureType, uint32(feature.Type))
	}
	w.packedUint32(fieldFeatureGeometry, feature.Geometry)
	return w.buf
}

func encodeValue(value Value) []byte {
	w := &protoWriter{}
	switch r := value.valueRank(); r {
	case valueRankString:
		w.string_(fieldValueString, *value.StringValue)
	case valueRankFloat:
		w.fixed32(fieldValueFloat, math.Float32bits(*value.FloatValue))
	case valueRankDouble:
		w.fixed64(fieldValueDouble, math.Float64bits(*value.DoubleValue))
	case valueRankInt:
		w.int64Varint(fieldValueInt, *value.IntValue)
	case valueRankUint:
		w.uint64Varint(fieldValueUint, *value.UintValue)
	case valueRankSint:
		// sint64 使用 zigzag 编码。
		v := *value.SintValue
		w.uint64Varint(fieldValueSint, uint64(v<<1)^uint64(v>>63))
	case valueRankBool:
		w.boolVarint(fieldValueBool, *value.BoolValue)
	}
	return w.buf
}
