package formal

import (
	"net/netip"
	"sort"
)

const (
	defaultVNodesPerWeight = 4096
	maxRingPoints          = 1 << 19
)

type ringPoint struct {
	hash uint64
	id   string
	seq  uint64
}

type hashRing struct {
	points []ringPoint
}

// buildRing constructs a weighted consistent-hash ring. Virtual-node hashes
// depend only on backend ID and sequence number, never on the rest of the
// backend set, so adding or removing a backend leaves every other point in
// place.
func buildRing(backends []Backend, vnodesPerWeight int) *hashRing {
	if vnodesPerWeight <= 0 {
		vnodesPerWeight = defaultVNodesPerWeight
	}

	bs := append([]Backend(nil), backends...)
	sort.Slice(bs, func(i, j int) bool { return bs[i].ID < bs[j].ID })
	if len(bs) == 0 {
		return &hashRing{}
	}

	var totalWeight float64
	for _, b := range bs {
		totalWeight += float64(b.Weight)
	}
	totalPoints := float64(vnodesPerWeight) * totalWeight
	if totalPoints > maxRingPoints {
		totalPoints = maxRingPoints
	}
	if totalPoints < float64(len(bs)) {
		totalPoints = float64(len(bs))
	}

	counts := make([]int, len(bs))
	total := 0
	for i, b := range bs {
		count := int(totalPoints * float64(b.Weight) / totalWeight)
		if count < 1 {
			count = 1
		}
		counts[i] = count
		total += count
	}

	r := &hashRing{points: make([]ringPoint, 0, total)}
	for i, b := range bs {
		for seq := 0; seq < counts[i]; seq++ {
			r.points = append(r.points, ringPoint{
				hash: hashVNode(b.ID, uint64(seq)),
				id:   b.ID,
				seq:  uint64(seq),
			})
		}
	}
	sort.Slice(r.points, func(i, j int) bool {
		if r.points[i].hash != r.points[j].hash {
			return r.points[i].hash < r.points[j].hash
		}
		if r.points[i].id != r.points[j].id {
			return r.points[i].id < r.points[j].id
		}
		return r.points[i].seq < r.points[j].seq
	})
	return r
}

// pick returns the backend owning the first virtual node at or after h,
// wrapping around the ring.
func (r *hashRing) pick(h uint64) (string, bool) {
	if r == nil || len(r.points) == 0 {
		return "", false
	}
	i := sort.Search(len(r.points), func(i int) bool {
		return r.points[i].hash >= h
	})
	if i == len(r.points) {
		i = 0
	}
	return r.points[i].id, true
}

// vnodeCounts counts virtual nodes per backend for status reporting.
func (r *hashRing) vnodeCounts() map[string]int {
	out := make(map[string]int)
	if r == nil {
		return out
	}
	for _, p := range r.points {
		out[p.id]++
	}
	return out
}

const (
	fnvOffset64 = 14695981039346656037
	fnvPrime64  = 1099511628211
)

func hashByte(h uint64, b byte) uint64 {
	return (h ^ uint64(b)) * fnvPrime64
}

func hashUint16(h uint64, v uint16) uint64 {
	h = hashByte(h, byte(v>>8))
	return hashByte(h, byte(v))
}

func hashUint64(h uint64, v uint64) uint64 {
	for shift := 56; shift >= 0; shift -= 8 {
		h = hashByte(h, byte(v>>uint(shift)))
	}
	return h
}

func hashString(h uint64, s string) uint64 {
	h = hashUint64(h, uint64(len(s)))
	for i := 0; i < len(s); i++ {
		h = hashByte(h, s[i])
	}
	return h
}

func hashAddr(h uint64, addr netip.Addr) uint64 {
	addr = addr.Unmap()
	if addr.Is4() {
		h = hashByte(h, 4)
		a := addr.As4()
		for _, b := range a {
			h = hashByte(h, b)
		}
		return h
	}
	h = hashByte(h, 6)
	a := addr.As16()
	for _, b := range a {
		h = hashByte(h, b)
	}
	if addr.Zone() != "" {
		h = hashByte(h, 1)
		h = hashString(h, addr.Zone())
	} else {
		h = hashByte(h, 0)
	}
	return h
}

// hashTuple hashes every field of the five-tuple. Field widths and address
// family tags make the encoding unambiguous.
func hashTuple(k FiveTuple) uint64 {
	h := uint64(fnvOffset64)
	h = hashAddr(h, k.SrcAddr)
	h = hashUint16(h, k.SrcPort)
	h = hashAddr(h, k.DstAddr)
	h = hashUint16(h, k.DstPort)
	h = hashByte(h, k.Protocol)
	return mix64(h)
}

func hashVNode(id string, seq uint64) uint64 {
	h := uint64(fnvOffset64)
	h = hashString(h, "formal-vnode")
	h = hashString(h, id)
	h = hashUint64(h, seq)
	return mix64(h)
}

// mix64 applies the SplitMix64 finalizer so structured five-tuples and
// sequential virtual-node IDs are spread evenly over the ring.
func mix64(x uint64) uint64 {
	x ^= x >> 30
	x *= 0xbf58476d1ce4e5b9
	x ^= x >> 27
	x *= 0x94d049bb133111eb
	x ^= x >> 31
	return x
}
