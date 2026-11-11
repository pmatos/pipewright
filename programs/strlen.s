# Byte loads and a pointer walk. Result: a0 = 26
    .data
msg: .asciz "abcdefghijklmnopqrstuvwxyz"

    .text
main:
    la   a1, msg
    mv   a0, a1
loop:
    lbu  t0, 0(a0)
    beqz t0, end
    addi a0, a0, 1
    j    loop
end:
    sub  a0, a0, a1
    ecall
