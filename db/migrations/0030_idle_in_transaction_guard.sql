-- Session guard for leaked transactions.
--
-- Observed three sessions sitting "idle in transaction" for ~51 seconds with this
-- set to 0. An open transaction pins a snapshot, which prevents vacuum from
-- reclaiming anything newer in any table, so a single leaked session degrades
-- every autovacuum on the instance.
--
-- This only ends a session that is holding a transaction open while doing
-- nothing; it never interrupts a statement that is actively running. It is set
-- at database level because the leak is not specific to one role.
--
-- Revert with:
--   ALTER DATABASE postgres RESET idle_in_transaction_session_timeout;

ALTER DATABASE postgres SET idle_in_transaction_session_timeout = '60s';
