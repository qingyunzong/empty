# Countdown that wraps below zero: x goes 10, 9, ..., 0, 255 and stops.
x = 10
loop:
x = x - 1
if x != 255 goto loop
halt
