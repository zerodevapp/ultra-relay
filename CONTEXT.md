# Context — ultra-relay

Glossary of domain terms. Definitions only — no implementation detail.

## Terms

### Graceful termination
A shutdown the process can observe and act on (SIGINT / SIGTERM). The bundler
runs cleanup before exiting.

### Ungraceful termination
A shutdown the process cannot observe: SIGKILL, OOM-kill, force delete, node
crash, hard redeploy. No cleanup runs. Synonym in discussion: **crash**.

### Relay instance
One running ultra-relay process. An instance serves exactly one chain and has
its own wallets and configuration. The chain default is named
`ultra-relay-<chain>`; a dedicated instance for a specific integration adds a
variant suffix, `ultra-relay-<chain>-<variant>`. Not to be confused with a
Kubernetes Service, which is a networking object.

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
one, and recovers any that slip through rather than sending it again unchanged.

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

### User operation lifecycle
The observable journey of a user operation through the bundler: received →
validated → mempool stages (outstanding → processing → submitted) → a terminal
outcome (included, frontran, reverted, or dropped). Each arrow is a lifecycle
transition.

### Rejected
Refused at ingress: the user operation is never accepted into the mempool and
gets no hash.

### Dropped
Removed from the mempool after acceptance without being included. A terminal
outcome. The client-facing status of a dropped user operation reads
`rejected`; that API value predates this term.

### Resubmit
Returning the user operations of a failed bundle attempt from processing or
submitted to outstanding, so that a later bundle can carry them. Avoid:
**requeue**.

### Replacement
Re-sending a stuck bundle transaction with the same nonce and higher fees, so
that it is mined instead of the original. Avoid: **resubmit** for this.

### Infrastructure failure
A failed bundle attempt caused by the relay's own dependencies: fetching the
nonce or fees, acquiring an executor wallet, an executor wallet without funds,
a transport failure while sending the bundle transaction, a mempool store
write, or the internal bundle hand-off. It never counts
against a user operation.

### Counted failure
Any failed bundle attempt that is not an infrastructure failure, such as an
on-chain revert or a send the node refused. It uses up part of the user
operation's submission attempts.

### Submission attempts
How many times the bundler has tried to land one user operation: each send of
a bundle carrying it, each replacement, and each counted failure, kept across
resubmits. A user operation whose submission attempts reach the resubmit limit
is dropped at its next counted failure.

### Nonce slot
One sender together with one nonce key. User operations in the same nonce slot
must land in nonce order.

### Retried user operation
An outstanding user operation with at least one submission attempt.

### Isolation
Carrying a retried user operation in a bundle of its own, so that a bad user
operation cannot keep failing its bundle-mates. Avoid: **solo bundle**.

### Successor hold
Keeping a user operation out of bundles while the previous nonce in its nonce
slot is still processing or submitted. Avoid: **nonce hold**.

### Mempool restoration
Carrying the mempool's contents across a graceful termination so a restarted
instance resumes with the same pending user operations instead of dropping
them.
