# Memory through the pipeline: a store is followed by a load of the same
# address. The store only writes memory when it retires, so the load gets
# its value by store-to-load forwarding from the store queue.
# Result: a0 = 5 + 5*2 = 15
    .data
slot: .word 0
    .text
main:
    la   a1, slot
    li   t0, 5
    sw   t0, 0(a1)        # store: memory written at commit
    lw   t1, 0(a1)        # load: forwarded from the store above
    slli t2, t1, 1
    add  a0, t1, t2
    ecall
