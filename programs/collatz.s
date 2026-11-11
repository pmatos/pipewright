# Total Collatz stopping steps for n = 1..100: DIV/REM and unpredictable branches.
# Result: a0 = 3142
    .text
main:
    li   a0, 0              # total steps
    li   s0, 1              # n
    li   s1, 100
    li   s2, 2
    li   s3, 3
outer:
    bgt  s0, s1, done
    mv   t0, s0
step:
    li   t1, 1
    beq  t0, t1, nextn
    rem  t2, t0, s2
    beqz t2, even
    mul  t0, t0, s3
    addi t0, t0, 1
    j    count
even:
    div  t0, t0, s2
count:
    addi a0, a0, 1
    j    step
nextn:
    addi s0, s0, 1
    j    outer
done:
    ecall
