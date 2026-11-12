package tiff

import "fmt"

var scalarTags = map[uint16]bool{
	tagImageWidth:      true,
	tagImageLength:     true,
	tagCompression:     true,
	tagSamplesPerPixel: true,
	tagRowsPerStrip:    true,
	tagPlanarConfig:    true,
}

var arrayTags = map[uint16]bool{
	tagBitsPerSample:   true,
	tagStripOffsets:    true,
	tagStripByteCounts: true,
}

var shortOnlyTags = map[uint16]bool{
	tagBitsPerSample:   true,
	tagCompression:     true,
	tagSamplesPerPixel: true,
	tagPlanarConfig:    true,
}

func (im *Image) validate() error {
	for tag, en := range im.entries {
		if scalarTags[tag] && en.count != 1 {
			return fmt.Errorf("tiff: scalar tag %d has count %d", tag, en.count)
		}
		if arrayTags[tag] {
			if en.typ != typeShort && en.typ != typeLong {
				return fmt.Errorf("tiff: array tag %d has invalid type %d", tag, en.typ)
			}
			if en.count == 0 {
				return fmt.Errorf("tiff: array tag %d has zero count", tag)
			}
		}
		if shortOnlyTags[tag] && en.typ != typeShort {
			return fmt.Errorf("tiff: tag %d must be SHORT, got type %d", tag, en.typ)
		}
	}

	for _, tag := range []uint16{tagImageWidth, tagImageLength, tagBitsPerSample, tagStripOffsets, tagStripByteCounts} {
		if _, ok := im.entries[tag]; !ok {
			return fmt.Errorf("tiff: required tag %d is missing", tag)
		}
	}

	im.Width = int(im.scalar(tagImageWidth))
	im.Height = int(im.scalar(tagImageLength))
	if im.Width <= 0 || im.Height <= 0 {
		return fmt.Errorf("tiff: image dimensions must be positive, got %dx%d", im.Width, im.Height)
	}

	bits, err := im.uint32Array(tagBitsPerSample)
	if err != nil {
		return err
	}
	for _, b := range bits {
		if b != 8 {
			return fmt.Errorf("tiff: only 8-bit unsigned samples are supported, got bit depth %d", b)
		}
	}

	im.Bands = 1
	if en, ok := im.entries[tagSamplesPerPixel]; ok {
		im.Bands = int(im.scalarValue(en))
	}
	if im.Bands <= 0 {
		return fmt.Errorf("tiff: SamplesPerPixel must be positive, got %d", im.Bands)
	}
	if len(bits) != 1 && len(bits) != im.Bands {
		return fmt.Errorf("tiff: BitsPerSample count %d is neither 1 nor band count %d", len(bits), im.Bands)
	}

	im.PlanarConfig = 1
	if en, ok := im.entries[tagPlanarConfig]; ok {
		im.PlanarConfig = int(im.scalarValue(en))
	}
	if im.PlanarConfig != 1 && im.PlanarConfig != 2 {
		return fmt.Errorf("tiff: unsupported PlanarConfiguration %d", im.PlanarConfig)
	}

	im.Compression = 1
	if en, ok := im.entries[tagCompression]; ok {
		im.Compression = int(im.scalarValue(en))
	}
	if im.Compression != 1 && im.Compression != 32773 {
		return fmt.Errorf("tiff: unsupported compression %d", im.Compression)
	}

	im.RowsPerStrip = im.Height
	if en, ok := im.entries[tagRowsPerStrip]; ok {
		im.RowsPerStrip = int(im.scalarValue(en))
	}
	if im.RowsPerStrip <= 0 {
		return fmt.Errorf("tiff: RowsPerStrip must be positive, got %d", im.RowsPerStrip)
	}

	im.stripOffsets, err = im.uint32Array(tagStripOffsets)
	if err != nil {
		return err
	}
	im.stripByteCount, err = im.uint32Array(tagStripByteCounts)
	if err != nil {
		return err
	}
	if len(im.stripOffsets) != len(im.stripByteCount) {
		return fmt.Errorf("tiff: StripOffsets count %d != StripByteCounts count %d", len(im.stripOffsets), len(im.stripByteCount))
	}

	im.rowBytes, err = mulInt(im.Width, im.Bands)
	if err != nil {
		return err
	}
	im.bandBytes = im.Width

	stripsPerPlane := (im.Height + im.RowsPerStrip - 1) / im.RowsPerStrip
	planes := 1
	if im.PlanarConfig == 2 {
		planes = im.Bands
	}
	wantStrips, err := mulInt(stripsPerPlane, planes)
	if err != nil {
		return err
	}
	if len(im.stripOffsets) != wantStrips {
		return fmt.Errorf("tiff: strip array length %d != expected strips %d", len(im.stripOffsets), wantStrips)
	}

	im.Strips = wantStrips
	im.stripRows = make([]int, wantStrips)
	im.stripDecoded = make([]int, wantStrips)
	for i := 0; i < wantStrips; i++ {
		stripInPlane := i % stripsPerPlane
		rows := im.RowsPerStrip
		if remaining := im.Height - stripInPlane*im.RowsPerStrip; remaining < rows {
			rows = remaining
		}
		im.stripRows[i] = rows
		var lineBytes int
		if im.PlanarConfig == 1 {
			lineBytes = im.rowBytes
		} else {
			lineBytes = im.bandBytes
		}
		decoded, err := mulInt(rows, lineBytes)
		if err != nil {
			return err
		}
		if decoded > im.reader.limits.MaxStripDecodedBytes {
			return fmt.Errorf("tiff: strip %d decoded size %d exceeds limit %d", i, decoded, im.reader.limits.MaxStripDecodedBytes)
		}
		im.stripDecoded[i] = decoded

		off := im.stripOffsets[i]
		count := im.stripByteCount[i]
		if count == 0 {
			return fmt.Errorf("tiff: strip %d has zero byte count", i)
		}
		if im.Compression == 1 && int(count) != decoded {
			return fmt.Errorf("tiff: raw strip %d byte count %d != decoded size %d", i, count, decoded)
		}
		end, err := add32(off, 0, count)
		if err != nil {
			return fmt.Errorf("tiff: strip %d offset/count overflows", i)
		}
		if int64(end) > im.reader.size {
			return fmt.Errorf("tiff: strip %d bytes at offset %d exceed file size", i, off)
		}
	}
	return nil
}

func mulInt(a, b int) (int, error) {
	if a <= 0 || b <= 0 {
		return 0, fmt.Errorf("tiff: non-positive factor in multiplication")
	}
	if a > (int(^uint(0)>>1))/b {
		return 0, fmt.Errorf("tiff: integer multiplication %d*%d overflows", a, b)
	}
	return a * b, nil
}

func (im *Image) scalar(tag uint16) uint32 {
	return im.scalarValue(im.entries[tag])
}

func (im *Image) scalarValue(en *entry) uint32 {
	r := im.reader
	switch en.typ {
	case typeShort:
		return uint32(r.order.Uint16(en.inline[:2]))
	case typeLong:
		return r.order.Uint32(en.inline[:4])
	default:
		return uint32(en.inline[0])
	}
}

func (im *Image) uint32Array(tag uint16) ([]uint32, error) {
	en, ok := im.entries[tag]
	if !ok {
		return nil, fmt.Errorf("tiff: tag %d is missing", tag)
	}
	raw := make([]byte, en.bytes)
	if en.isExternal {
		if err := im.reader.readAt(raw, int64(en.externalOff)); err != nil {
			return nil, err
		}
	} else {
		copy(raw, en.inline[:en.bytes])
	}
	out := make([]uint32, en.count)
	switch en.typ {
	case typeShort:
		for i := range out {
			out[i] = uint32(im.reader.order.Uint16(raw[2*i:]))
		}
	case typeLong:
		for i := range out {
			out[i] = im.reader.order.Uint32(raw[4*i:])
		}
	case typeByte:
		for i := range out {
			out[i] = uint32(raw[i])
		}
	default:
		return nil, fmt.Errorf("tiff: tag %d has unreadable type %d", tag, en.typ)
	}
	return out, nil
}
