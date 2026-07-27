# Context — ultra-relay

Glossary of domain terms. Definitions only — no implementation detail.

## Terms

### Graceful termination
A shutdown the process can observe and act on (SIGINT / SIGTERM). The bundler
runs cleanup before exiting.

### Ungraceful termination
A shutdown the process cannot observe: SIGKILL, OOM-kill, force delete, node
crash, hard redeploy. No cleanup runs. Synonym in discussion: **crash**.

### Dead instance
A bundler instance that has ungracefully terminated. Its in-memory state is
gone and any shared resources it held are stranded until another instance or a
restart reclaims them.

### Bundle caps
The per-transaction limits a single handleOps transaction must respect on a
given chain: a maximum execution gas and a maximum serialized byte size.
Resolved per chain (chainId, then chain family, then a conservative default).

### Oversized bundle
A bundle whose handleOps transaction would exceed a bundle cap (gas or bytes)
and so be rejected by the node before inclusion. The bundler avoids forming
one, and recovers any that slip through rather than resubmitting it unchanged.

### Deployment operation
A user operation that deploys its smart account as part of execution (carries
initCode on v0.6, a factory on v0.7+). At most one deployment operation per
sender may be pending at a time; a newer one displaces the older.

### Mempool stages
The lifecycle stages of an accepted user operation. **Outstanding**: accepted
and waiting to be picked for a bundle. **Processing**: picked for a bundle
that has not yet been submitted on-chain. **Submitted**: included in a
transaction that is awaiting inclusion. Leaving a stage must erase every
record of the operation held for that stage.

### Mempool restoration
Carrying the mempool's contents across a graceful termination so a restarted
instance resumes with the same pending user operations instead of dropping
them.
