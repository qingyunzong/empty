package main

import (
	"encoding/binary"
	"math/bits"
)

// bitset 是定长位集，用于表示需求覆盖状态。
type bitset []uint64

func newBitset(n int) bitset { return make(bitset, (n+63)/64) }

func (b bitset) Set(i int) { b[i/64] |= 1 << (uint(i) % 64) }

func (b bitset) Test(i int) bool { return b[i/64]>>(uint(i)%64)&1 == 1 }

func (b bitset) Or(o bitset) {
	for i := range b {
		b[i] |= o[i]
	}
}

func (b bitset) Count() int {
	c := 0
	for _, w := range b {
		c += bits.OnesCount64(w)
	}
	return c
}

// AndNotCount 返回在 b 中但不在 o 中的位数（新增覆盖数）。
func (b bitset) AndNotCount(o bitset) int {
	c := 0
	for i := range b {
		c += bits.OnesCount64(b[i] &^ o[i])
	}
	return c
}

func (b bitset) Clone() bitset {
	c := make(bitset, len(b))
	copy(c, b)
	return c
}

// FirstZero 返回 [0,n) 内第一个未置位的下标，没有则返回 -1。
func (b bitset) FirstZero(n int) int {
	for i := 0; i < n; i++ {
		if !b.Test(i) {
			return i
		}
	}
	return -1
}

func (b bitset) key() string {
	buf := make([]byte, 8*len(b))
	for i, w := range b {
		binary.LittleEndian.PutUint64(buf[i*8:], w)
	}
	return string(buf)
}
