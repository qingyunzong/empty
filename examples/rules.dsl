# Fleet temperature / current alerting rules.
field temp: C;
field current: A;

group sensors = /^sensor-[0-9]+$/;

let temp_limit = 80C;

rule overtemp on sensors {
  alert critical when temp > temp_limit for 5m;
}

rule overcurrent on all {
  alert warning when current > 10A for 1m and not temp > 95C;
}
