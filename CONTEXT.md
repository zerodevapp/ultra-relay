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
