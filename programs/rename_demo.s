# Register renaming in action. The slow MUL writes t0, then t0 is reused for
# an unrelated value. Without renaming, `li t0, 7` would have to wait for the
# MUL (a write-after-write hazard) and `add t3` would wait behind it too.
# With renaming each write of t0 gets its own physical register, so the
# independent work overtakes the multiply.
# Result: a0 = 42*3 + 1 + 7 + 7 = 141
    .text
main:
    li   a1, 42
    li   a2, 3
    mul  t0, a1, a2       # slow: 3 cycles on the teaching core
    addi t1, t0, 1        # true dependence: must wait for the MUL
    li   t0, 7            # reuses t0: renamed, no need to wait
    add  t3, t0, t0       # reads the new t0, runs right away
    add  a0, t1, t3
    ecall
