package main

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Op 为一条读/写操作。Version 为版本号，等于写入该版本的事务 ID。
type Op struct {
	Kind    byte // 'R' 或 'W'
	Txn     int
	Item    string
	Version int
	Pos     int // 在历史中的位置
}

// History 为一条完整的多版本历史。
type History struct {
	Ops  []Op
	Txns []int // 升序去重的事务 ID
}

var opRe = regexp.MustCompile(`^([RW])([0-9]+)\(([A-Za-z][A-Za-z0-9]*?)([0-9]*)\)$`)

// ParseHistory 解析形如 "W1(x) R2(x1) W2(y)" 的历史串。
// 写操作不带版本号（版本即写者事务 ID）；读操作必须带版本号。
func ParseHistory(input string) (*History, error) {
	fields := strings.FieldsFunc(input, func(r rune) bool {
		switch r {
		case ' ', ',', ';', '\t', '\n', '\r':
			return true
		}
		return false
	})
	if len(fields) == 0 {
		return nil, fmt.Errorf("历史为空")
	}
	h := &History{}
	seen := map[int]bool{}
	for i, tok := range fields {
		m := opRe.FindStringSubmatch(tok)
		if m == nil {
			return nil, fmt.Errorf("无法解析操作 %q（应为 W1(x) 或 R2(x1) 形式）", tok)
		}
		txn, _ := strconv.Atoi(m[2])
		op := Op{Kind: m[1][0], Txn: txn, Item: m[3], Pos: i}
		if op.Kind == 'W' {
			if m[4] != "" {
				return nil, fmt.Errorf("写操作 %q 不应带版本号", tok)
			}
			op.Version = txn
		} else {
			if m[4] == "" {
				return nil, fmt.Errorf("读操作 %q 必须指明版本，例如 R%d(%s1)", tok, txn, op.Item)
			}
			op.Version, _ = strconv.Atoi(m[4])
		}
		h.Ops = append(h.Ops, op)
		seen[txn] = true
	}
	for t := range seen {
		h.Txns = append(h.Txns, t)
	}
	sort.Ints(h.Txns)
	if len(h.Txns) > 12 {
		return nil, fmt.Errorf("事务数 %d 超过上限 12", len(h.Txns))
	}
	if err := h.validate(); err != nil {
		return nil, err
	}
	return h, nil
}

func (h *History) validate() error {
	written := map[string]map[int]bool{}
	for _, op := range h.Ops {
		switch op.Kind {
		case 'W':
			if written[op.Item][op.Txn] {
				return fmt.Errorf("T%d 重复写数据项 %s", op.Txn, op.Item)
			}
			if written[op.Item] == nil {
				written[op.Item] = map[int]bool{}
			}
			written[op.Item][op.Txn] = true
		case 'R':
			if !written[op.Item][op.Version] {
				return fmt.Errorf("T%d 读取 %s%d，但该版本此前未被写入", op.Txn, op.Item, op.Version)
			}
			if written[op.Item][op.Txn] && op.Version != op.Txn {
				return fmt.Errorf("T%d 已写过 %s，此后只能读到自己的版本 %s%d，不能读 %s%d",
					op.Txn, op.Item, op.Item, op.Txn, op.Item, op.Version)
			}
		}
	}
	return nil
}

// TxnNames 返回 ["T1","T2",...] 形式的事务名列表。
func (h *History) TxnNames() []string {
	names := make([]string, len(h.Txns))
	for i, t := range h.Txns {
		names[i] = fmt.Sprintf("T%d", t)
	}
	return names
}
