-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

-- 0057_node_embed_policy.sql — which sites may frame the public app.
--
-- An admin-set embedding policy on the `node_settings` singleton (0037):
-- JSON `{"mode": "any" | "list" | "self", "origins": [...]}`, shape and
-- validation in `src/types/node-embedding.ts`. The root middleware
-- (`functions/_middleware.ts`) turns it into a `frame-ancestors`
-- header on the public app's HTML.
--
-- NULL means "never set", which reads as `any`: no header, so any site
-- may embed. That is the behaviour every node had before this column
-- existed, so adding it changes nothing until an admin saves a policy.
--
-- A column on `node_settings` rather than inside `features_json`: the
-- feature map is a flat {key: boolean} that normalizes unknown keys
-- away, and the two are saved by separate cards. The singleton's
-- `updated_by` / `updated_at` record whichever was saved last; the
-- full history is in `audit_events` (`node_settings.update`).
--
-- Additive only. No backfill: existing rows read NULL, i.e. `any`.

ALTER TABLE node_settings ADD COLUMN embed_policy_json TEXT;
