package locate

import "errors"

// ErrTooManySensors 表示传感器数量超过冲突子集穷举的上限 MaxSensors。
var ErrTooManySensors = errors.New("locate: 传感器数量超过穷举上限 18")
