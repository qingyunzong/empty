# 次日可移峰设备用电计划示例
# 槽长 15 分钟，全天 96 槽；分时电价（元/kWh）与碳排因子（kg/kWh）

template Pump {
  power 40 kW
  duration 60 min
}

template Charger {
  power 7 kW
  energy 14 kWh
  interruptible true
  maxInterrupts 2
}

site Factory {
  slots 96
  slotMinutes 15

  tariff {
    00:00 .. 08:00 -> 0.32 元
    08:00 .. 12:00 -> 0.95 元
    12:00 .. 14:00 -> 0.55 元
    14:00 .. 18:00 -> 0.95 元
    18:00 .. 22:00 -> 1.20 元
    22:00 .. 24:00 -> 0.32 元
  }
  carbon 0.55

  costBudget 200
  carbonBudget 400
  peakLimit 120 kW

  maintenance 10:00 .. 11:00

  task pumpA : Pump {
    window 06:00 .. 12:00
  }

  task pumpB : Pump {
    window 06:00 .. 14:00
    after pumpA
  }

  task charger1 : Charger {
    window 00:00 .. 04:00
  }

  task hvac {
    power 25 kW
    duration 120 min
    window 12:00 .. 20:00
  }

  objective minimize cost
}
