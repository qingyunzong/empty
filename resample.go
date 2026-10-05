// Package resample 提供固定间隔的分段线性重采样。
//
// 输入为有理数时间与数值的采样点，输出为锚定原点（t = 0）的等间隔
// 网格点，网格上的值由分段线性插值得到，全程使用 math/big.Rat 精确运算。
//
// 语义要点：
//   - 原点显式：网格锚定 t = 0，输出时间恒为 step 的非负整数倍。
//   - 缺失段不插值：由 Break 分隔的间隙内的网格点不产生输出。
//   - 尾部不外推：最后一个采样点之后（没有右端点）的网格点不产生输出，
//     即使收到 End 结束信号也不外推。
package resample

import (
	"errors"
	"fmt"
	"math/big"
)

// Sample 是一个输入采样点。时间必须非负，且在所有 Write 调用之间全局严格递增。
type Sample struct {
	T *big.Rat // 时间
	V *big.Rat // 数值
}

// Point 是一个输出网格点。T 恒为 step 的非负整数倍。
type Point struct {
	T *big.Rat // 网格时间
	V *big.Rat // 插值结果
}

var (
	ErrBadStep      = errors.New("resample: step must be a positive rational")
	ErrEnded        = errors.New("resample: sampler has ended")
	ErrNilRat       = errors.New("resample: nil rational")
	ErrNegativeTime = errors.New("resample: sample time must be non-negative")
	ErrNonMonotonic = errors.New("resample: sample times must be strictly increasing")
)

var bigOne = big.NewInt(1)

// Sampler 是流式重采样器，以 O(1) 状态增量处理采样点。不是并发安全的。
type Sampler struct {
	step    *big.Rat
	nextK   *big.Int // 下一个待输出网格点的下标，网格时间为 nextK*step
	inRun   bool
	prevT   *big.Rat
	prevV   *big.Rat
	lastT   *big.Rat
	hasLast bool
	ended   bool
}

// New 创建以 step 为固定间隔的重采样器。step 必须为正有理数。
func New(step *big.Rat) (*Sampler, error) {
	if step == nil || step.Sign() <= 0 {
		return nil, ErrBadStep
	}
	return &Sampler{step: new(big.Rat).Set(step), nextK: new(big.Int)}, nil
}

// Write 写入一批采样点，返回本次调用新确定的输出网格点。
// 采样点时间必须非负且全局严格递增（包括跨 Break 的新段）。
// 出错时返回出错前已确定的点，出错样本及其后样本不会被消费。
func (s *Sampler) Write(batch []Sample) ([]Point, error) {
	if s.ended {
		return nil, ErrEnded
	}
	var out []Point
	for i, sm := range batch {
		pts, err := s.add(sm)
		if err != nil {
			return out, fmt.Errorf("resample: sample %d: %w", i, err)
		}
		out = append(out, pts...)
	}
	return out, nil
}

// Break 结束当前连续段，直到下一个采样点之前的网格点视为缺失段，不插值。
// 未在段中调用 Break 是空操作。
func (s *Sampler) Break() error {
	if s.ended {
		return ErrEnded
	}
	s.inRun = false
	return nil
}

// End 发送结束信号并关闭重采样器。尾部没有右端点的网格点不外推，
// 因此 End 本身不产生任何输出；之后所有调用都返回 ErrEnded。
func (s *Sampler) End() error {
	if s.ended {
		return ErrEnded
	}
	s.ended = true
	return nil
}

// Resample 一次性对整序列做重采样：runs 为按缺失段分隔的连续采样段，
// 段间等价于调用 Break。返回全部输出网格点。
func Resample(step *big.Rat, runs [][]Sample) ([]Point, error) {
	s, err := New(step)
	if err != nil {
		return nil, err
	}
	var out []Point
	for i, run := range runs {
		pts, err := s.Write(run)
		if err != nil {
			return out, fmt.Errorf("resample: run %d: %w", i, err)
		}
		out = append(out, pts...)
		if err := s.Break(); err != nil {
			return out, err
		}
	}
	if err := s.End(); err != nil {
		return out, err
	}
	return out, nil
}

func (s *Sampler) add(sm Sample) ([]Point, error) {
	if sm.T == nil || sm.V == nil {
		return nil, ErrNilRat
	}
	if sm.T.Sign() < 0 {
		return nil, ErrNegativeTime
	}
	if s.hasLast && sm.T.Cmp(s.lastT) <= 0 {
		return nil, ErrNonMonotonic
	}
	t := new(big.Rat).Set(sm.T)
	v := new(big.Rat).Set(sm.V)

	var out []Point
	if !s.inRun {
		// 段首：跳过段起点之前（缺失段或序列头部）的网格点。
		s.inRun = true
		s.nextK = ceilRat(new(big.Rat).Quo(t, s.step))
		if gt := s.gridTime(s.nextK); gt.Cmp(t) == 0 {
			out = append(out, Point{T: gt, V: new(big.Rat).Set(v)})
			s.nextK.Add(s.nextK, bigOne)
		}
	} else {
		// 段内：输出落在 (prevT, t] 内的所有网格点。
		for {
			gt := s.gridTime(s.nextK)
			if gt.Cmp(t) > 0 {
				break
			}
			out = append(out, Point{T: gt, V: interp(s.prevT, s.prevV, t, v, gt)})
			s.nextK.Add(s.nextK, bigOne)
		}
	}
	s.prevT, s.prevV = t, v
	s.lastT = t
	s.hasLast = true
	return out, nil
}

func (s *Sampler) gridTime(k *big.Int) *big.Rat {
	return new(big.Rat).Mul(s.step, new(big.Rat).SetInt(k))
}

// interp 计算 (t0,v0)-(t1,v1) 之间在 T 处的线性插值，要求 t0 < t1 且 t0 <= T <= t1。
func interp(t0, v0, t1, v1, T *big.Rat) *big.Rat {
	frac := new(big.Rat).Quo(new(big.Rat).Sub(T, t0), new(big.Rat).Sub(t1, t0))
	dv := new(big.Rat).Sub(v1, v0)
	return new(big.Rat).Add(v0, dv.Mul(dv, frac))
}

// ceilRat 返回不小于 q 的最小整数，q 必须非负。
func ceilRat(q *big.Rat) *big.Int {
	quo, rem := new(big.Int).QuoRem(q.Num(), q.Denom(), new(big.Int))
	if rem.Sign() != 0 {
		quo.Add(quo, bigOne)
	}
	return quo
}
