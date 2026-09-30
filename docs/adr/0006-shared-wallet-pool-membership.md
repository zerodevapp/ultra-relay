# Shared wallet pool membership

Redis sender managers share an idle-address list and a lowercase in-use set.
Previously, only an empty list was seeded; added keys could remain unused,
and foreign addresses were discarded before requesting a restart (ADR 0004).

## Startup and a 5-minute sync add eligible missing addresses

At startup, before bundle work, and then every 5 minutes, reconcile the
distinct addresses from getAvailableWallets(config), after maxExecutors
slicing. Add only addresses absent from both list and set. All participants
must use the new protocol; concurrent scripts serialize membership changes.
The sync never reclaims in-use entries or hot-reloads keys. Automatic removal
of retired keys is not included.

## Adding requires an armed pool

An operator's stopped-pool rebuild sets an armed marker key; pods never
create it. Reconcile adds nothing without it. A missing marker means Redis
lost its data, and adding then could hand out wallets live pods still hold.
Startup on an unarmed pool fails; the periodic sync logs an error and waits.
This also stops new-protocol pods from starting on a legacy pool.

## Taking and returning preserve reservations

Take scans at most the initial list length. It reserves the first own idle
address atomically, drops encountered copies already in-use, and rotates
other entries unchanged to the left. No eligible address means a 100ms wait;
Redis errors reject through acquisition recovery. Foreign wallets cause no
shutdown. Foreign counts are pod-relative, not proof of global retirement.

Every checkout has a fresh Account object. Only that exact handle may be
returned, once. Return consumes the local handle before its script removes
the in-use member and writes the checksummed address. A missing reservation
is an integrity error. Redis must not replay take/return after a lost reply:
autoResendUnfulfilledCommands=false, maxRetriesPerRequest=0, no offline queue,
and no application retries. NOSCRIPT fallback is allowed because no script
executed. A return rejected before it was written is likewise kept and sent
after reconnect. This combination prevents stale callbacks or replayed
returns from releasing a later checkout; the set alone cannot do so.

## Address format and observability

Address identity is lowercase. New list writes use the configured checksummed
address; skipped legacy entries retain their bytes. Existing duplicates are
not eagerly normalized. The shared available gauge is raw list length,
including foreign and duplicate entries, not local signing capacity.

## Operational limits

In-use includes active, quarantined and stranded reservations. A crash or
uncertain reply can strand one; age or quiet traffic cannot prove it is safe
to clear. Shutdown does not blanket-return unresolved Redis checkouts.
Recovery requires stopping all pool participants and resolving outstanding
transaction/nonces before rebuilding and re-arming the pool from approved keys.

First migration and rollback require that same stopped-pool boundary.
Low traffic and checksummed strings do not make mixed old/new code safe.
Redis state loss requires recovery too; this is not a fencing or lease system.
One address must not be used by independent pools or external signers.
See the wallet-pool membership spec §§7–8 for the operational procedures.
