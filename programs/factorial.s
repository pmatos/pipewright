# Recursive factorial: exercises calls, the stack and MUL.
# Result: a0 = 10! = 3628800
    .text
main:
    li   a0, 10
    call fact
    ecall

# a0 = fact(a0)
fact:
    addi sp, sp, -8
    sw   ra, 4(sp)
    sw   s0, 0(sp)
    mv   s0, a0
    li   t0, 1
    ble  a0, t0, base
    addi a0, a0, -1
    call fact
    mul  a0, a0, s0
    j    out
base:
    li   a0, 1
out:
    lw   s0, 0(sp)
    lw   ra, 4(sp)
    addi sp, sp, 8
    ret
