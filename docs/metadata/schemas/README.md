# Local STAC Schema Bundle

These are internal Phase 1 contracts, not public endpoints. The Terraviz schema
declares its intended immutable URI, but that URI **must be published before
Phase 2 exposes any document that declares it**. No files here are copied into
the application's public directory.

## Mappings

| Source | Output | Scope |
|---|---|---|
| Persisted origin and schema version | `terraviz:origin_node`, `terraviz:schema_version` | Collection / Item properties |
| Legacy ID, cadence | `terraviz:legacy_id`, `terraviz:cadence` | Collection / Item properties; never identity or represented time |
| Longitude origin, Y flip, playback rate | `terraviz:longitude_origin`, `terraviz:flipped_y`, `terraviz:playback_fps` | Collection / Item properties; rendering hints, not a CRS |
| Rights holder and attribution | `terraviz:rights_holder`, `terraviz:attribution` | Collection / Item properties; not a substitute for license |
| Canonical data-luma parser output | Paired `terraviz:render_encoding`, `terraviz:color_scale` | Collection / Item properties; invalid pairs become pictures |
| Local category decorations | `terraviz:categories` | Origin-qualified values, explicitly unaligned |
| Reviewed vocabulary references | `terraviz:vocabularies` and related descriptor links | Collection / Item properties; owner/revision/facet/term IDs retained |
| Delivered media dimensions/encoding | `terraviz:media` | Data Asset only; does not claim scientific raster bands |
| Delivered SHA-256 and byte size | File extension `file:checksum`, `file:size` | Exact resolved Asset bytes only; no upload or HLS bundle checksum |
| DOI and citation | Scientific extension `sci:doi`, `sci:citation` | Collection / Item properties |

The extension schema rejects unknown `terraviz:*` keys and misplaced Asset
fields. Core schemas validate every generated resource in tests. Semantic
constraints that JSON Schema cannot express, such as interval ordering,
palette range validity and vocabulary ownership, remain in canonical parsers
and policy gates. `stac_extensions` contains only extensions used by output.
Arbitrary approved node schemas cannot redefine these reserved namespaces.

Built-in extension declarations are assembled once, before policy/schema
validation, for Catalogs, Collections and Items. Policy adds/removes custom
schema URIs itself and cannot add reserved built-in fields, so a second
built-in declaration pass is unnecessary. Resolver MIME types are normalized
to lowercase once; rendition comparisons use the same case-insensitive rule.

Catalog description precedence is nonempty node identity description, current
approved mission, current approved about-summary, then deterministic generic
text. About summaries are parsed as Markdown and projected to bounded plain
text, never rendered as executable HTML. Identity descriptions are used directly
as required by the plan. Review evidence, private drafts and tone never emit.
Public vocabulary descriptors omit approval evidence; identical labels never
establish equivalence. Public hosting and descriptor route schemas remain a
Phase 2 gate.

## Offline Validation

`stac-schema.ts` accepts supplied draft-07 bytes, verifies their SHA-256 digest
and identity, and resolves references only within that bundle. Bounds are 1 MiB,
33 documents, 32 references across the entire bundle, reference depth 8, and
32768 visited nodes across the entire bundle. These are independent ceilings,
not an allowance of 32 references per document. The conservative Phase 0
budget is retained: a multi-schema test accepts 16+16 references but rejects
20+20 even though either schema works alone. Revisit the budget with measured
extension requirements and a policy review, not by silently resetting counters.
Missing,
cyclic, nested-identity, unsupported-keyword and unknown-format schemas fail
closed. It does not install a network loader, mutate inputs, add defaults, or
coerce values. Registration and current review evidence remain separate gates.
Only already reviewed schema bundles are accepted; this is not an arbitrary
remote-schema execution sandbox (regular expressions must also be reviewed).

`official/manifest.json` records source URLs and SHA-256 hashes for unchanged
official STAC 1.1.0, File 2.1.0, Scientific Citation 1.0.0 and GeoJSON schemas.
Tests verify every hash and use Ajv's bundled draft-07 metaschema. Official core
schemas are trusted test fixtures, not node-owned schemas subject to the custom
bundle's reference restrictions. Their original IDs and content are preserved,
including the upstream `commonjson` ID spelling; registration also uses the
retrieval URI. STAC and extension sources are available from their corresponding
STAC specification / stac-extensions repositories; GeoJSON schemas come from
geojson.org. Upstream license terms continue to apply.

Official fixture tests and local validators share `addStacFormats`, including
whitespace rejection for both `iri` and `iri-reference`. Only their schema trust
and bundle-limit policies differ.

To deliberately refresh fixtures, run `node --import tsx
scripts/vendor-stac-schemas.ts` from the repository root and review the manifest
and schema diffs. This maintenance command performs downloads; normal tests and
the serializer do not. Never refresh fixtures implicitly in CI.
Filenames identify the schema host/path and a stable URI hash, not traversal
indices; the manifest is sorted by source URI. Explicit seed URLs have their
own allowlist, independent of the growing discovery queue. Refreshing removes
obsolete generated names from the prior manifest but preserves other files.