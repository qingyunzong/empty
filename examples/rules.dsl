# Sustained over-temperature on any dev-* sensor
let limit = 80C

alert overheat level critical on devices(/^dev-/) when temp > limit for 5m
alert high_current level warning on devices(dev-1, dev-2) when current > 10A for 1m
alert combined level warning on devices(/^dev-/) when temp > 90C and not current < 2A
