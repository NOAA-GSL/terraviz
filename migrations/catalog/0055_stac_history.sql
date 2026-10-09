-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

CREATE TABLE stac_history_publications (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('frame', 'revision')),
  source_key TEXT NOT NULL,
  model_json TEXT NOT NULL CHECK (json_valid(model_json)),
  captured_at TEXT NOT NULL,
  UNIQUE (dataset_id, kind, source_key)
);

CREATE TABLE stac_history_items (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES stac_history_publications(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  data_ref TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  format TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  UNIQUE (publication_id, ordinal)
);

CREATE INDEX stac_history_publications_dataset ON stac_history_publications(dataset_id, captured_at, id);
CREATE INDEX stac_history_items_publication ON stac_history_items(publication_id, ordinal);

CREATE TRIGGER stac_history_publications_immutable BEFORE UPDATE ON stac_history_publications
BEGIN SELECT RAISE(ABORT, 'STAC publication snapshots are immutable'); END;
CREATE TRIGGER stac_history_items_immutable BEFORE UPDATE ON stac_history_items
BEGIN SELECT RAISE(ABORT, 'STAC Item identities are immutable'); END;