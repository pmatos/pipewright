# Branch-bound: the branch on each element's low bit follows an irregular
# pattern. Try predictor none, not-taken, bimodal and gshare and watch the
# mispredicts and flushes.
# Result: a0 = number of odd elements = 9
    .data
vals: .word 7, 2, 9, 4, 4, 1, 3, 8, 6, 5, 11, 2, 13, 10, 15, 12
    .text
main:
    la   a1, vals
    li   a2, 16
    li   a0, 0
loop:
    lw   t0, 0(a1)
    andi t0, t0, 1
    beqz t0, skip         # data-dependent: hard to predict
    addi a0, a0, 1
skip:
    addi a1, a1, 4
    addi a2, a2, -1
    bnez a2, loop         # loop branch: easy to predict
    ecall
