package tiff

type rawStrip struct{ data []byte }

func buildStrips(f *fixture, img *fixtureImage) []rawStrip {
	stripsPerPlane := (img.height + img.rowsPerStrip - 1) / img.rowsPerStrip
	planes := 1
	if img.planar == 2 {
		planes = img.bands
	}
	lineBytes := img.width
	if img.planar == 1 {
		lineBytes = img.width * img.bands
	}
	var out []rawStrip
	for plane := 0; plane < planes; plane++ {
		for s := 0; s < stripsPerPlane; s++ {
			rows := img.rowsPerStrip
			if rem := img.height - s*img.rowsPerStrip; rem < rows {
				rows = rem
			}
			raw := make([]byte, 0, rows*lineBytes)
			for r := 0; r < rows; r++ {
				srcY := s*img.rowsPerStrip + r
				if img.planar == 1 {
					start := (srcY * img.width) * img.bands
					raw = append(raw, img.pixels[start:start+lineBytes]...)
				} else {
					planeStart := plane * img.width * img.height
					start := planeStart + srcY*img.width
					raw = append(raw, img.pixels[start:start+lineBytes]...)
				}
			}
			if img.compression == 1 {
				out = append(out, rawStrip{data: raw})
				continue
			}
			if img.crossLine {
				out = append(out, rawStrip{data: packBitsCrossLine(raw, lineBytes)})
			} else {
				out = append(out, rawStrip{data: packBitsLines(raw, lineBytes)})
			}
		}
	}
	return out
}

// packBitsLines encodes each row independently so no literal or run crosses a
// row boundary. A -128 no-op header is inserted at the start of every row.
func packBitsLines(raw []byte, lineBytes int) []byte {
	var out []byte
	for off := 0; off < len(raw); off += lineBytes {
		line := raw[off : off+lineBytes]
		out = append(out, 0x80) // PackBits no-op.
		for pos := 0; pos < len(line); {
			run := 1
			for pos+run < len(line) && run < 128 && line[pos+run] == line[pos] {
				run++
			}
			if run >= 2 {
				out = append(out, byte(int8(1-run)))
				out = append(out, line[pos])
				pos += run
				continue
			}
			end := pos
			for end < len(line) && end-pos < 128 {
				if end+1 < len(line) && line[end] == line[end+1] {
					break
				}
				end++
			}
			if end == pos {
				end = pos + 1
			}
			out = append(out, byte(end-pos-1))
			out = append(out, line[pos:end]...)
			pos = end
		}
	}
	return out
}

// packBitsCrossLine intentionally emits one literal spanning the first row
// boundary, which a strict decoder must reject.
func packBitsCrossLine(raw []byte, lineBytes int) []byte {
	if len(raw) < lineBytes+2 {
		return packBitsLines(raw, lineBytes)
	}
	// One literal covering the last byte of row 0 and the first byte of row 1.
	out := []byte{0x01, raw[lineBytes-1], raw[lineBytes]}
	rest := append([]byte(nil), raw[:lineBytes-1]...)
	rest = append(rest, raw[lineBytes+1:]...)
	// Encode the remainder without row framing; the first header already
	// violated the boundary and the decoder must reject before finishing.
	for len(rest) > 0 {
		n := len(rest)
		if n > 128 {
			n = 128
		}
		out = append(out, byte(n-1))
		out = append(out, rest[:n]...)
		rest = rest[n:]
	}
	return out
}
