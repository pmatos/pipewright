# Width-bound: four independent accumulators, so a wide core can run
# several adds every cycle. Compare the narrow and big presets.
# Result: a0 = 40 * (1 + 2 + 3 + 4) = 400
    .text
main:
    li   t0, 40           # iterations
    li   a0, 0
    li   a1, 0
    li   a2, 0
    li   a3, 0
loop:
    addi a0, a0, 1
    addi a1, a1, 2
    addi a2, a2, 3
    addi a3, a3, 4
    addi t0, t0, -1
    bnez t0, loop
    add  a0, a0, a1
    add  a0, a0, a2
    add  a0, a0, a3
    ecall
