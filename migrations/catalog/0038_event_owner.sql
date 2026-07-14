-- 0038_event_owner.sql — ownership for current events.
--
-- Publishers get the same "read all, write own" access to events that
-- they have to datasets. Events, unlike datasets, are often machine-
-- created by feed connectors (proposed, unowned), so ownership is
-- assigned by action rather than at insert:
--
--   - A publisher who manually creates an event (the "+ New event"
--     drawer) owns it immediately.
--   - A publisher who approves an as-yet-unclaimed proposed event
--     becomes its owner.
--
-- Once `owner_id` is set, only that owner (or an admin / service
-- caller) may mutate the event; an unclaimed event (owner_id IS NULL)
-- is open for any active publisher to act on, which is what lets the
-- first approver claim it. Read access is unconditional — the whole
-- events queue is visible to every active publisher.
--
-- Distinct from `reviewed_by` (the last curator to act, set on every
-- review including a reject): `owner_id` is the durable owner, set once
-- and not overwritten by a later reviewer.
--
-- Additive only: one nullable column + a lookup index.

ALTER TABLE current_events ADD COLUMN owner_id TEXT REFERENCES publishers(id);

-- "Which events does this publisher own?" — the write-scope lookup.
CREATE INDEX idx_current_events_owner ON current_events(owner_id);
