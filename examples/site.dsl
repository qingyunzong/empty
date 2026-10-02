# 次日可移峰设备用电计划示例
site "DemoFactory" {
  capacity 40 kW

  tariff {
    price 00:00-06:00 0.30   # 谷段
    price 06:00-22:00 0.80   # 峰段
    price 22:00-24:00 0.30
  }

  carbon {
    intensity 00:00-24:00 0.50
  }

  budget {
    cost 60
    carbon 25
  }

  template Pump {
    power 10 kW
    duration 60 min
    window 08:00-20:00
    interruptible false
  }

  template Line : Pump {     # 词法作用域：遮蔽父模板字段
    power 20 kW
    duration 30 min
  }

  task p1 : Pump
  task p2 : Pump { window 10:00-14:00 }
  task l1 : Line

  order p1 before p2

  maintenance 12:00-12:45

  minimize cost
}
