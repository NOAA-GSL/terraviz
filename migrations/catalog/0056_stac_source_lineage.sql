-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 The Zyra Project

CREATE TABLE stac_source_lineage (
  publication_id TEXT PRIMARY KEY REFERENCES stac_history_publications(id) ON DELETE CASCADE,
  sources_json TEXT NOT NULL CHECK (json_valid(sources_json) AND json_type(sources_json) = 'array'
    AND json_array_length(sources_json) BETWEEN 1 AND 32),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TRIGGER stac_source_lineage_immutable
BEFORE UPDATE ON stac_source_lineage
BEGIN
  SELECT RAISE(ABORT, 'STAC source lineage is immutable');
END;