package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// Car 是一节车厢，顺序即原序列中的位置。
type Car struct {
	ID     string  `json:"id"`     // 车厢编号
	Length float64 `json:"length"` // 长度（米）
	Weight float64 `json:"weight"` // 重量（吨）
	Hazmat string  `json:"hazmat"` // 危险品类别，空串表示非危险品
}

// TrainType 是一种车型（机车编组方案），给出每列车的限制与费用。
type TrainType struct {
	Name        string  `json:"name"`
	MaxCars     int     `json:"maxCars"`   // 每列最多车厢数，0 表示不限
	MaxLength   float64 `json:"maxLength"` // 每列最大总长度（米），0 表示不限
	MaxWeight   float64 `json:"maxWeight"` // 每列最大总重量（吨），0 表示不限
	Cost        float64 `json:"cost"`      // 每开一列的费用
	AllowHazmat bool    `json:"allowHazmat"`
}

// Problem 是一次编组问题。
type Problem struct {
	Cars []Car `json:"cars"`
	// Incompatible 列出不能在**同一列车内相邻**的危险品类别对（无序）。
	Incompatible [][2]string `json:"incompatible"`
	Types        []TrainType `json:"types"`
}

// MaxCarsAllowed 是题目规定的编组车厢数上限。
const MaxCarsAllowed = 18

// LoadProblem 从 JSON 文件读取并校验问题。
func LoadProblem(path string) (*Problem, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var p Problem
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("解析 %s: %w", path, err)
	}
	if err := p.Validate(); err != nil {
		return nil, fmt.Errorf("校验 %s: %w", path, err)
	}
	return &p, nil
}

// Validate 检查问题是否合法。
func (p *Problem) Validate() error {
	n := len(p.Cars)
	if n == 0 {
		return fmt.Errorf("至少需要 1 节车厢")
	}
	if n > MaxCarsAllowed {
		return fmt.Errorf("车厢数 %d 超过上限 %d", n, MaxCarsAllowed)
	}
	if len(p.Types) == 0 {
		return fmt.Errorf("至少需要 1 种车型")
	}
	seen := map[string]bool{}
	for i, c := range p.Cars {
		if c.ID == "" {
			return fmt.Errorf("第 %d 节车厢缺少 id", i+1)
		}
		if seen[c.ID] {
			return fmt.Errorf("车厢 id %q 重复", c.ID)
		}
		seen[c.ID] = true
		if c.Length < 0 || c.Weight < 0 {
			return fmt.Errorf("车厢 %q 的长度/重量不能为负", c.ID)
		}
	}
	for _, t := range p.Types {
		if t.Name == "" {
			return fmt.Errorf("车型缺少 name")
		}
		if t.Cost < 0 {
			return fmt.Errorf("车型 %q 的费用不能为负", t.Name)
		}
	}
	return nil
}

// incompatible 判断两个危险品类别是否禁止相邻（无序对）。
func (p *Problem) incompatible(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	for _, pair := range p.Incompatible {
		if (pair[0] == a && pair[1] == b) || (pair[0] == b && pair[1] == a) {
			return true
		}
	}
	return false
}
