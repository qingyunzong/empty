package dataeng

import (
	"errors"
	"math"
)

// Unmarshal 解码 MVT protobuf 字节流；未知字段被跳过，packed 与非 packed
// 的 tags/geometry 重复字段编码均可读取。
func Unmarshal(data []byte) (*Tile, error) {
	tile := &Tile{}
	r := &protoReader{buf: data}
	for !r.eof() {
		field, wireType, err := r.readTag()
		if err != nil {
			return nil, err
		}
		if field == fieldTileLayers && wireType == wireBytes {
			payload, err := r.readBytes()
			if err != nil {
				return nil, err
			}
			layer, err := decodeLayer(payload)
			if err != nil {
				return nil, err
			}
			tile.Layers = append(tile.Layers, layer)
			continue
		}
		if err := r.skipField(wireType); err != nil {
			return nil, err
		}
	}
	return tile, nil
}

func decodeLayer(data []byte) (*Layer, error) {
	layer := &Layer{}
	r := &protoReader{buf: data}
	for !r.eof() {
		field, wireType, err := r.readTag()
		if err != nil {
			return nil, err
		}
		switch {
		case field == fieldLayerName && wireType == wireBytes:
			payload, err := r.readBytes()
			if err != nil {
				return nil, err
			}
			layer.Name = string(payload)
		case field == fieldLayerFeatures && wireType == wireBytes:
			payload, err := r.readBytes()
			if err != nil {
				return nil, err
			}
			feature, err := decodeFeature(payload)
			if err != nil {
				return nil, err
			}
			layer.Features = append(layer.Features, feature)
		case field == fieldLayerKeys && wireType == wireBytes:
			payload, err := r.readBytes()
			if err != nil {
				return nil, err
			}
			layer.Keys = append(layer.Keys, string(payload))
		case field == fieldLayerValues && wireType == wireBytes:
			payload, err := r.readBytes()
			if err != nil {
				return nil, err
			}
			value, err := decodeValue(payload)
			if err != nil {
				return nil, err
			}
			layer.Values = append(layer.Values, value)
		case field == fieldLayerExtent && wireType == wireVarint:
			v, err := r.readVarint()
			if err != nil {
				return nil, err
			}
			layer.Extent = uint32(v)
		case field == fieldLayerVersion && wireType == wireVarint:
			v, err := r.readVarint()
			if err != nil {
				return nil, err
			}
			layer.Version = uint32(v)
		default:
			if err := r.skipField(wireType); err != nil {
				return nil, err
			}
		}
	}
	// 规范化默认值，便于后续归并判定统一处理。
	if layer.Extent == 0 {
		layer.Extent = defaultExtent
	}
	if layer.Version == 0 {
		layer.Version = defaultVersion
	}
	return layer, nil
}

func decodeFeature(data []byte) (*Feature, error) {
	feature := &Feature{}
	r := &protoReader{buf: data}
	for !r.eof() {
		field, wireType, err := r.readTag()
		if err != nil {
			return nil, err
		}
		switch {
		case field == fieldFeatureID && wireType == wireVarint:
			v, err := r.readVarint()
			if err != nil {
				return nil, err
			}
			feature.ID = v
			feature.HasID = true
		case field == fieldFeatureTags:
			values, err := readPackedOrScalar(r, wireType)
			if err != nil {
				return nil, err
			}
			feature.Tags = append(feature.Tags, values...)
		case field == fieldFeatureGeometry:
			values, err := readPackedOrScalar(r, wireType)
			if err != nil {
				return nil, err
			}
			feature.Geometry = append(feature.Geometry, values...)
		case field == fieldFeatureType && wireType == wireVarint:
			v, err := r.readVarint()
			if err != nil {
				return nil, err
			}
			feature.Type = GeomType(v)
		default:
			if err := r.skipField(wireType); err != nil {
				return nil, err
			}
		}
	}
	return feature, nil
}

// readPackedOrScalar 同时兼容 packed（length-delimited）与非 packed
// （逐元素 varint）两种 proto3 重复字段编码。
func readPackedOrScalar(r *protoReader, wireType int) ([]uint32, error) {
	if wireType == wireBytes {
		payload, err := r.readBytes()
		if err != nil {
			return nil, err
		}
		pr := &protoReader{buf: payload}
		var out []uint32
		for !pr.eof() {
			v, err := pr.readVarint()
			if err != nil {
				return nil, err
			}
			out = append(out, uint32(v))
		}
		return out, nil
	}
	if wireType != wireVarint {
		return nil, errors.New("dataeng: unexpected wire type for packed field")
	}
	v, err := r.readVarint()
	if err != nil {
		return nil, err
	}
	return []uint32{uint32(v)}, nil
}

func decodeValue(data []byte) (Value, error) {
	r := &protoReader{buf: data}
	value := Value{}
	for !r.eof() {
		field, wireType, err := r.readTag()
		if err != nil {
			return Value{}, err
		}
		switch field {
		case fieldValueString:
			payload, err := r.readBytes()
			if err != nil {
				return Value{}, err
			}
			s := string(payload)
			value.StringValue = &s
		case fieldValueFloat:
			bits, err := r.readFixed32()
			if err != nil {
				return Value{}, err
			}
			f := math.Float32frombits(bits)
			value.FloatValue = &f
		case fieldValueDouble:
			bits, err := r.readFixed64()
			if err != nil {
				return Value{}, err
			}
			f := math.Float64frombits(bits)
			value.DoubleValue = &f
		case fieldValueInt:
			v, err := r.readVarint()
			if err != nil {
				return Value{}, err
			}
			n := int64(v)
			value.IntValue = &n
		case fieldValueUint:
			v, err := r.readVarint()
			if err != nil {
				return Value{}, err
			}
			value.UintValue = &v
		case fieldValueSint:
			v, err := r.readVarint()
			if err != nil {
				return Value{}, err
			}
			// zigzag 解码。
			n := int64(v>>1) ^ -int64(v&1)
			value.SintValue = &n
		case fieldValueBool:
			v, err := r.readVarint()
			if err != nil {
				return Value{}, err
			}
			b := v != 0
			value.BoolValue = &b
		default:
			if err := r.skipField(wireType); err != nil {
				return Value{}, err
			}
		}
	}
	if !value.Valid() {
		return Value{}, errors.New("dataeng: decoded value has no or multiple fields set")
	}
	return value, nil
}
