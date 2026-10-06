# Step by 7 modulo 256; gcd(7,256)=1 so every value is reached.
# The abstract domain must capture the wrap-around precisely.
x = 0
loop:
x = x + 7
if x < 250 goto loop
halt
