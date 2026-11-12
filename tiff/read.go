package tiff

import "fmt"

// ReadRect decodes the requested pixel rectangle and bands from this IFD.
//
// bands are zero-based band indices; indices may repeat and their order is
// preserved in the output. rect must be non-empty and fully inside the image.
// The returned slice is row-major: for every output row, samples are written
// band by band for each pixel in request order.
//
// All touched strips are validated before any output is produced: a bad strip
// fails the whole call without returning a partial rectangle, and strips not
// intersecting the request are never read.
func (im *Image) ReadRect(rect Rect, bands []int) ([]byte, error) {
	if rect.Width <= 0 || rect.Height <= 0 {
		return nil, fmt.Errorf("tiff: rectangle must be non-empty, got %+v", rect)
	}
	if rect.X < 0 || rect.Y < 0 || rect.X+rect.Width > im.Width || rect.Y+rect.Height > im.Height {
		return nil, fmt.Errorf("tiff: rectangle %+v exceeds image %dx%d", rect, im.Width, im.Height)
	}
	if len(bands) == 0 {
		return nil, fmt.Errorf("tiff: band list is empty")
	}
	for _, b := range bands {
		if b < 0 || b >= im.Bands {
			return nil, fmt.Errorf("tiff: band %d out of range (have %d)", b, im.Bands)
		}
	}
	outSamples, err := mulInt(rect.Width*rect.Height, len(bands))
	if err != nil {
		return nil, err
	}
	if outSamples > im.reader.limits.MaxOutputPixels {
		return nil, fmt.Errorf("tiff: output samples %d exceed limit %d", outSamples, im.reader.limits.MaxOutputPixels)
	}

	stripsPerPlane := (im.Height + im.RowsPerStrip - 1) / im.RowsPerStrip
	firstStrip := rect.Y / im.RowsPerStrip
	lastStrip := (rect.Y + rect.Height - 1) / im.RowsPerStrip

	type stripJob struct {
		idx int
		buf []byte
	}
	var jobs []stripJob
	needed := map[int]bool{}

	addStrip := func(idx int) error {
		if needed[idx] {
			return nil
		}
		needed[idx] = true
		buf, err := im.decodeStrip(idx)
		if err != nil {
			return err
		}
		jobs = append(jobs, stripJob{idx: idx, buf: buf})
		return nil
	}

	// Validate (and read) every strip the request can touch before assembling.
	if im.PlanarConfig == 1 {
		for s := firstStrip; s <= lastStrip; s++ {
			if err := addStrip(s); err != nil {
				return nil, err
			}
		}
	} else {
		for _, b := range bands {
			base := b * stripsPerPlane
			for s := firstStrip; s <= lastStrip; s++ {
				if err := addStrip(base + s); err != nil {
					return nil, err
				}
			}
		}
	}

	buffers := make(map[int][]byte, len(jobs))
	for _, j := range jobs {
		buffers[j.idx] = j.buf
	}

	out := make([]byte, outSamples)
	lineBytes := im.rowBytes
	if im.PlanarConfig == 2 {
		lineBytes = im.bandBytes
	}

	for row := 0; row < rect.Height; row++ {
		srcY := rect.Y + row
		stripInPlane := srcY / im.RowsPerStrip
		rowInStrip := srcY - stripInPlane*im.RowsPerStrip
		dstRow := out[row*rect.Width*len(bands):]

		if im.PlanarConfig == 2 {
			for oi, b := range bands {
				idx := b*stripsPerPlane + stripInPlane
				buf := buffers[idx]
				srcOff := rowInStrip*lineBytes + rect.X
				dstOff := oi
				for x := 0; x < rect.Width; x++ {
					dstRow[x*len(bands)+dstOff] = buf[srcOff+x]
				}
			}
			continue
		}

		buf := buffers[stripInPlane]
		if len(bands) == 1 {
			b := bands[0]
			for x := 0; x < rect.Width; x++ {
				dstRow[x] = buf[rowInStrip*lineBytes+(rect.X+x)*im.Bands+b]
			}
			continue
		}
		for x := 0; x < rect.Width; x++ {
			pixel := rowInStrip*lineBytes + (rect.X+x)*im.Bands
			for oi, b := range bands {
				dstRow[x*len(bands)+oi] = buf[pixel+b]
			}
		}
	}
	return out, nil
}

func (im *Image) decodeStrip(idx int) ([]byte, error) {
	off := im.stripOffsets[idx]
	count := int(im.stripByteCount[idx])
	src := make([]byte, count)
	if err := im.reader.readAt(src, int64(off)); err != nil {
		return nil, fmt.Errorf("tiff: strip %d: %w", idx, err)
	}
	if im.Compression == 1 {
		if len(src) != im.stripDecoded[idx] {
			return nil, fmt.Errorf("tiff: strip %d byte count mismatch", idx)
		}
		return src, nil
	}
	lineBytes := im.rowBytes
	if im.PlanarConfig == 2 {
		lineBytes = im.bandBytes
	}
	buf, err := decodePackBits(src, lineBytes, im.stripRows[idx])
	if err != nil {
		return nil, fmt.Errorf("tiff: strip %d: %w", idx, err)
	}
	return buf, nil
}
