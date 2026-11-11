# Bubble sort of a word array in place: data-dependent branches, loads, stores.
    .data
    .equ N, 10
arr: .word 9, -3, 7, 0, 12, 5, -8, 1, 4, 2

    .text
main:
    li   s1, N - 1          # outer bound
outer:
    beqz s1, done
    la   t0, arr
    li   t1, 0              # j
inner:
    bge  t1, s1, next
    lw   t2, 0(t0)
    lw   t3, 4(t0)
    ble  t2, t3, noswap
    sw   t3, 0(t0)
    sw   t2, 4(t0)
noswap:
    addi t0, t0, 4
    addi t1, t1, 1
    j    inner
next:
    addi s1, s1, -1
    j    outer
done:
    ecall
