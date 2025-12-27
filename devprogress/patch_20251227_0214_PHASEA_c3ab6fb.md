# patch_20251227_0214_PHASEA_c3ab6fb

Phase:

- PHASEA (Foundations)

Scope summary (what changed):

- Aligned locked JSON Schemas (majors/save/action log) to the v1.1 spec.
- Updated majors content + strings to validate against the locked schema.
- Implemented locked deterministic RNG (xorshift32) in game-core with unit tests.
- Added Vitest config to avoid running compiled `dist/**` test artifacts.

Files changed:

- .gitignore
- docs/fools_gambit_studio_spec_v1_1.md
- eslint.config.cjs
- packages/game-data/schemas/majors.schema.json
- packages/game-data/schemas/save_blob.schema.json
- packages/game-data/schemas/action_log.schema.json
- packages/game-data/schemas/run_state.schema.json
- packages/game-data/content/majors.json
- packages/game-data/content/strings.en.json
- packages/game-data/scripts/validate-content.mjs
- packages/game-core/src/index.ts
- packages/game-core/src/rng/xorshift32.ts
- packages/game-core/src/rng/xorshift32.test.ts
- vitest.config.ts

Behavior changes (must map to spec sections):

- Content validation now enforces the locked v1.1 schema shapes for majors/save/action logs (spec §16.1–§16.3).
- Ajv validator runs with `strictRequired: false` to allow conditional required checks in the locked schema while keeping `strict: true`.
- Engine RNG implementation is locked to xorshift32 behavior and tested (spec §10).

New/updated tests:

- packages/game-core/src/rng/xorshift32.test.ts (unit)

Replays added/updated:

- None (Phase B+).

Content/schema changes:

- majors.json updated to match locked effect primitive schema (spec §14.2 + §16.1).
- strings.en.json updated to include all string keys referenced by majors.json (spec §14.1 + §15).

Migration notes:

- saveVersion bump? no
- migration implemented? no

Known issues / follow-ups:

- Devil shadow bargain is represented with two identical bargain options to satisfy schema minItems while preserving behavior (spec §16.1 bargainOptions minItems=2).
- Next: implement the Phase B engine core loop (RunState/reducer + room/minor resolution pipeline) while keeping UI-agnostic boundaries (spec §0.1, §2.1, §9).

Next phase entry criteria checklist:

- [x] `npm run validate:content` passes
- [x] CI stays green (validate + typecheck + lint + test)
