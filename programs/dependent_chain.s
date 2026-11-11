# Latency-bound: every MUL needs the previous result, so the core cannot
# overlap them however wide it is. Compare the narrow and big presets.
# Result: a0 = 3^32 mod 2^32 = -501334399 (the multiplies wrap)
    .text
main:
    li   a0, 1
    li   t0, 3
    li   t1, 8            # eight passes of the unrolled body
loop:
    mul  a0, a0, t0
    mul  a0, a0, t0
    mul  a0, a0, t0
    mul  a0, a0, t0
    addi t1, t1, -1
    bnez t1, loop
    ecall
