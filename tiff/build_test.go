package tiff

import "bytes"

func (f *fixture) build() []byte {
	plans := make([]ifdPlan, len(f.images))
	for i, img := range f.images {
		if img.cycleBack == 0 && !img.cycleSet {
			img.cycleBack = -1
		}
		entries := f.entriesFor(img)
		if img.dupTag {
			entries = append(entries, tagValue{tag: tagImageWidth, typ: typeShort, count: 1, values: []uint32{uint32(img.width)}})
		}
		sortEntries(entries)
		plans[i] = ifdPlan{
			entries: entries,
			strips:  buildStrips(f, img),
			img:     img,
		}
	}

	f.layoutOffsets(plans)
	f.appendStripArrays(plans)
	offsets := f.layoutOffsets(plans)

	var b bytes.Buffer
	if f.little {
		b.WriteString("II")
	} else {
		b.WriteString("MM")
	}
	f.put16(&b, 42)
	f.put32(&b, 8)

	for i, p := range plans {
		var next uint32
		switch {
		case p.img.cycleBack >= 0:
			next = uint32(offsets[p.img.cycleBack])
		case p.img.badNextOff != 0:
			next = p.img.badNextOff
		case i+1 < len(plans):
			next = uint32(offsets[i+1])
		default:
			next = 0
		}
		f.put16(&b, uint16(len(p.entries)))
		extCursor := offsets[i] + 2 + len(p.entries)*12 + 4
		for _, e := range p.entries {
			f.put16(&b, e.tag)
			f.put16(&b, e.typ)
			f.put32(&b, e.count)
			size := valueByteSize(e)
			if size <= 4 {
				var field [4]byte
				buf := bytes.NewBuffer(field[:0])
				f.encodeValues(buf, e)
				copy(field[:], buf.Bytes())
				b.Write(field[:])
			} else {
				f.put32(&b, uint32(extCursor))
				extCursor += size
			}
		}
		f.put32(&b, next)
		b.Write(p.external)
	}
	for _, p := range plans {
		for _, s := range p.strips {
			b.Write(s.data)
		}
	}

	out := b.Bytes()
	for _, img := range f.images {
		if img.truncateAt > 0 && img.truncateAt < len(out) {
			out = out[:img.truncateAt]
		}
	}
	return out
}
