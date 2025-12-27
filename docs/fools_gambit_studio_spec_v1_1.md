# Fool’s Gambit Studio Spec v1.1 (Web prototype + Unity parity port)

Source of truth for this project. Rules are locked. Any change to game behavior requires:

- a spec version bump
- test updates (unit and replay)
- content/save versioning updates (as applicable)
- migration notes (if save schema/state changes)

This spec is written to eliminate interpretation. The rules engine is authoritative. UI never re-implements rules.

## 0. Non-negotiables

### 0.1 Engine separation

- game-core is a pure, deterministic rules engine.
- UI layers (web-client, later Unity client) are thin clients: render state, query legal actions, dispatch actions.
- UI is not allowed to implement rules, resolve effects, or choose random targets.

### 0.2 Determinism

- Every run has a seed.
- Every random operation uses the engine RNG only.
- Every player decision is logged as an action.
- Replays must reproduce the same results exactly.

### 0.3 Content is data-driven + validated

- Major Arcana shadows and gifts must be defined in majors.json using a constrained primitive system.
- Content must validate in CI (Ajv) before merging.

### 0.4 “patch\_[uniqueID]” per development phase (required)

For every development phase in the plan (Phase A, B, C, …), the dev must add exactly one summary patch file to:

devprogress/patch\_[uniqueID].md

Where:

- uniqueID format (locked): YYYYMMDD*HHMM*<phaseCode>\_<shortGitSha>
  - example: patch_20251226_2145_PHASEB_a1b2c3d.md

- this patch file is required even if the phase is split across PRs; update the same patch file until the phase is complete.

Patch file template (locked)

```md
# patch\_[uniqueID]

Phase:

- PHASEB (Engine core loop)

Scope summary (what changed):

- ...

Files changed:

- ...

Behavior changes (must map to spec sections):

- ...

New/updated tests:

- ...

Replays added/updated:

- ...

Content/schema changes:

- ...

Migration notes:

- saveVersion bump? yes/no
- migration implemented? yes/no

Known issues / follow-ups:

- ...

Next phase entry criteria checklist:

- ...
```

If the dev completes a phase without a patch file, the phase is considered incomplete.

---

## 1. Project goals

1. Build a playable web prototype (Vite + PixiJS) that implements Fool’s Gambit v1.0 rules with locked digital clarifications below.

2. Ensure studio-grade correctness via:

- deterministic RNG
- action logs + replay runner
- unit tests, replay tests, and invariants

3. Port to Unity by:

- building a parity harness first (seed + action log replay)
- matching state hashes at checkpoints
- implementing Unity UI only after parity passes

---

## 2. Digital clarifications that do not change rules (locked)

Digital needs explicit timing windows and deterministic visibility. These are rule-preserving clarifications.

### 2.1 Timing windows (locked)

Per engaged room, the engine follows a strict loop:

1. RoomReveal

- room is filled to 4 face-up (carried card persists in its slot)
- “after revealing 4” shadows resolve immediately (some require a prompt/choice)

2. RoomChoice

- player chooses Flee or Engage (Flee disabled if last room was a flee)

3. EngageSetup

- if an Order shadow requires “choose carried first”, player must choose which card is carried first
- then proceed

4. PreResolveWindow (the only window for optional actions)
   Before committing to resolve the next card, the player may:

- spend Fate (if allowed)
- use prepared spell (if present)
- use attuned Major gift (if available)
- use Leap of Faith (if unused this room)
  Then player commits to resolving a specific card (or engine auto-selects if only one legal card exists).

5. ResolveExecute

- the committed card resolves (including all context effects)
- engine emits events
- post-resolution triggers fire (example: Sun shadow after first resolution)

Repeat PreResolveWindow → ResolveExecute until exactly 3 cards are resolved.

6. RoomEnd

- the 4th card remains face-up and becomes the carried card into the next room

### 2.2 Forced-order shadows must auto-guide (locked)

When an Order shadow applies (Emperor / Hierophant / Chariot / Justice):

- the engine must restrict legal next resolutions to only the allowed card(s)
- UI must highlight only legal targets
- if exactly one legal next card exists, UI may offer “Resolve next” as a single button (still logs COMMIT_RESOLVE internally)

### 2.3 Peek/reorder needs dedicated UI + logged confirmation (locked)

For top-3 reorder and room reorder:

- show cards clearly
- allow reorder interaction (drag/drop or click-to-swap)
- require an explicit confirm action
- log the chosen order as a player action

### 2.4 Random targets must be deterministic and visible (locked)

Random shadow operations (Wheel, Death, etc.):

- must use engine RNG
- must animate/select visibly in UI
- must log the result (“Death exiled: Knight of Cups (reversed)”)

---

## 3. Locked rule clarifications for implementation correctness

These remove ambiguity without adding new mechanics.

### 3.1 Physical vs effective orientation (locked)

Each Minor has a physical orientation stored on the card instance.
Some rules modify how it is treated at resolution time without flipping the card.

Effective orientation at the moment of resolving a card:

1. start with physical orientation
2. if boss fight and the card is a numbered Minor (2–10), force effective orientation to reversed (boss corruption)
3. if the card is cleansed for this resolution, force effective orientation to upright
4. final result is effective orientation used for effects and Fate gain

### 3.2 Fate gain rule (locked)

Gain +1 Fate after resolving any Minor whose effective orientation is reversed.

- includes physically reversed cards
- includes numbered cards treated as reversed during boss
- includes Aces if effective orientation is reversed
- does not apply if cleansed to upright for this resolution
  Fate is capped at 10 (cap is enabled).

### 3.3 Cleanse targeting rule (locked)

Cleanse may target any revealed room card that would resolve with effective orientation reversed right now (including boss-corrupted numbered cards).
Cleanse does not flip the card. It applies only to that next resolution.

### 3.4 Boss deck composition (locked)

Boss deck is built only from the floor discard pile (cards discarded/exiled/resolved and sent to discard this floor).
Equipped weapon/armor/spell are not included unless discarded by an effect.

### 3.5 Bottoming order (locked)

- Reroll bottoms the chosen card and draws a replacement into the same room slot.
- Flee bottoms the four room cards left-to-right as displayed.

### 3.6 Weapon restriction tracking (locked)

Weapon restriction compares against the effective value of the last enemy the weapon helped defeat (including elite +2).
Cheat-weapon ignores restriction for the next enemy fight only.

### 3.7 Healing limiter (locked)

Per room, only the first healing event that would increase HP actually heals; any additional healing attempts in the same room heal 0.
This applies to all healing sources (Cups heals, market heal, sanctuary heal-to-full, Major healing gifts if any exist later).

If tabletop rules need a different limiter, that becomes a separate mode and is out of scope for v1.1.

### 3.8 OrderingValue (locked)

Any “order by value” effect uses:

- Ace: 1
- numbered minor: 2–10
- court: base (11–14) +2 if effective orientation is reversed (elite)

Ordering is evaluated using effective orientation as it would resolve now.

---

## 4. Repo layout (locked)

Monorepo using npm workspaces:

- packages/game-core
  - pure engine (TS)
  - deterministic RNG
  - reducer/state machine
  - legality computation
  - content interpreter
  - serialization + migrations
  - tests: unit + replay + invariants/fuzz

- packages/game-data
  - content: majors.json, strings.en.json
  - schemas: JSON Schema files
  - scripts: validate-content.mjs

- packages/game-tools
  - replay runner / corpus tools

- apps/web-client
  - Vite + PixiJS client
  - optional React overlay (allowed, not required)

- docs
  - this spec
  - player-facing rules reference (must reflect locked clarifications)

- devprogress
  - patch\_[uniqueID].md per phase (required)

---

## 5. Web prototype stack (locked)

- TypeScript (strict)
- Vite
- PixiJS (WebGL 2D)
- Vitest
- Ajv content validation
- GitHub Actions CI

React overlay is optional.

---

## 6. Setup on Mac (VS Code + repo)

Prereqs:

- Node.js LTS
- Git
- VS Code

Recommended VS Code extensions:

- ESLint
- Prettier

Root scripts required (package.json):

- validate:content
- typecheck
- lint
- test
- dev:web
- build:web

Run locally:

- npm install
- npm run validate:content
- npm run dev:web

---

## 7. CI is required (GitHub Actions)

File: .github/workflows/ci.yml

```yaml
name: CI

on:
  pull_request:
  push:
    branches: ["main"]

jobs:
  build-test:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Use Node.js LTS
        uses: actions/setup-node@v4
        with:
          node-version: "lts/*"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Validate content
        run: npm run validate:content

      - name: Typecheck
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm test
```

CI must block merges if any step fails.

---

## 8. Web client (Vite + PixiJS) minimal scaffold (reference)

apps/web-client/package.json scripts must include dev/build/preview.

apps/web-client/vite.config.ts:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
```

apps/web-client/src/index.html (reference):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Fool’s Gambit (Web Prototype)</title>
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
        height: 100%;
        background: #0f1117;
      }
      #app {
        height: 100%;
        display: grid;
        grid-template-rows: auto 1fr;
      }
      header {
        padding: 12px 16px;
        color: #e6e6e6;
        font-family:
          system-ui,
          -apple-system,
          Segoe UI,
          Roboto,
          sans-serif;
      }
      canvas {
        display: block;
      }
    </style>
  </head>
  <body>
    <div id="app">
      <header>Fool’s Gambit — Web Prototype</header>
      <div id="stage"></div>
    </div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

apps/web-client/src/main.ts (reference):

```ts
import { Application, Graphics } from "pixi.js";

const host = document.getElementById("stage");
if (!host) throw new Error("Missing #stage element");

const app = new Application();
await app.init({ resizeTo: host, antialias: true, backgroundAlpha: 0 });
host.appendChild(app.canvas);

const g = new Graphics();
g.rect(40, 40, 300, 180).stroke({ width: 2, color: 0xffffff });
g.moveTo(40, 40).lineTo(340, 220);
app.stage.addChild(g);
```

The real web-client must:

- render state from engine
- only allow actions from getLegalActions(state)
- dispatch actions into applyAction
- display event log entries from returned events

---

## 9. Engine API contract (locked)

packages/game-core must export:

- createRun(config) -> RunState
- getLegalActions(state) -> LegalAction[]
- applyAction(state, action) -> { nextState, events }
- serialize(saveBlob) / deserialize(saveBlob) with migrations
- loadContent(bundle) -> validated content (majors + strings)
- validateState(state) -> dev-only validation

UI must never mutate state directly.

---

## 10. Deterministic RNG (locked)

Pick one algorithm and do not change it without a spec bump and parity replays update.

Locked choice: xorshift32.

Engine RNG must be the only source of randomness for:

- shuffles
- random target selection
- initial reversal assignment

Reference xorshift32 behavior (definition):

- state is uint32
- next:
  - x ^= x << 13
  - x ^= x >>> 17
  - x ^= x << 5
  - output = x (uint32)

Shuffles must be Fisher–Yates using rng.nextUint32.

---

## 11. Action log and event log (locked)

### 11.1 Action log

Input decisions. Minimal sufficient to replay exactly.
Action log must be append-only, and every state change is triggered by an action.

### 11.2 Event log

Output events emitted by engine. Drives:

- UI animations
- UI log panel
- optional telemetry

UI must render what engine reports.

---

## 12. Save/versioning (locked)

Every save blob and action log must include:

- engineVersion (semver string)
- contentVersion (hash or semver)
- specVersion (string, here “v1.1”)
- saveVersion (integer, for saves only)
- createdAtUTC (ISO string)

If save schema changes, increment saveVersion and implement migrations.
If content changes, update contentVersion.

---

## 13. State hashing (deterministic parity)

### 13.1 Purpose

State hashes are used for:

- replay regression tests
- Unity parity checkpoints
- divergence diagnosis

### 13.2 Include fields (hash inputs)

Include only fields that affect gameplay outcomes:

- run config (target majors count)
- seed and current RNG internal state
- decks: minorDeck order, majorDeck order
- all card registry entries (id, suit, rank, physical orientation)
- floor state (active major, counters, discard, bossDeck)
- room state (slots, resolvedMask, carriedIndex, leapUsed, healingUsedThisRoom, pendingCleanses, disabled fate actions)
- player state (hp, maxHp, gold, fate, equipment + restriction tracking)
- claimed/attuned/spent majors
- lastRoomWasFlee
- rules constraint state (order constraint, restriction mode, any floor params)

### 13.3 Exclude fields (do not hash)

Exclude non-deterministic / UI-only noise:

- timestamps
- animations or tween progress
- UI selection highlights
- window sizes, camera settings
- debug flags, dev-only tooling state
- rendering-specific caches

### 13.4 Hashing method (locked)

- canonical JSON serialization with stable key ordering
- arrays remain in order
- hash algorithm: SHA-256
- hash string output: hex

---

## 14. Content system (majors.json + strings.en.json)

All Major definitions must live in packages/game-data/content/majors.json and be validated.

### 14.1 strings.en.json stub (reference)

This file must contain every stringKey referenced by majors.json.
(Use the stub you already generated; keep it in sync with majors.json.)

### 14.2 Effect primitives (locked set)

Majors may only use these primitives (plus SEQUENCE/CHOICE/CONDITIONAL composition):

- REROLL_REVEALED
- EXILE_REPLACE_REVEALED
- CLEANSE_REVEALED
- PEEK_TOP_N
- REORDER_TOP_N
- REORDER_ROOM_BY_VALUE
- REORDER_ROOM_ARBITRARY
- BARGAIN
- DISABLE_FATE_ACTION
- SET_WEAPON_RESTRICTION_MODE
- SET_ORDER_CONSTRAINT
- SET_FLOOR_PARAM (for Chariot direction)
- FORCED_EXILE_FIRST_RESOLVE_ATTEMPT (Hanged Man)
- NOOP

Selectors (for targeting):

- PLAYER_CHOICE
- RANDOM
- LEFTMOST
- HIGHEST_VALUE (with tieBreak = PLAYER_CHOICE)
- IF_ENEMY_PRESENT_PLAYER_CHOICE (Judgement)
- IF_ANY_REVERSED_PLAYER_CHOICE (Star forced cleanse)

Random selectors must use engine RNG.

---

## 15. Content validation (Ajv) is required

packages/game-data/scripts/validate-content.mjs must:

- validate majors.json against majors.schema.json
- validate strings.en.json is a string->string object
- verify every referenced string key exists

Run:

- npm run validate:content

CI must run this.

---

## 16. Exact JSON Schema files (locked)

Place these in:
packages/game-data/schemas/

### 16.1 majors.schema.json (exact)

File: majors.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://foolsgambit.dev/schemas/majors.schema.json",
  "title": "Fool's Gambit - Majors Content",
  "type": "object",
  "additionalProperties": false,
  "required": ["contentVersion", "majors"],
  "properties": {
    "contentVersion": {
      "type": "string",
      "minLength": 1,
      "description": "Bump/change whenever majors or referenced strings change."
    },
    "majors": {
      "type": "array",
      "minItems": 21,
      "maxItems": 21,
      "items": { "$ref": "#/$defs/MajorDefinition" }
    }
  },
  "$defs": {
    "MajorId": {
      "type": "string",
      "enum": [
        "magician",
        "high_priestess",
        "empress",
        "emperor",
        "hierophant",
        "lovers",
        "chariot",
        "strength",
        "hermit",
        "wheel",
        "justice",
        "hanged_man",
        "death",
        "temperance",
        "devil",
        "tower",
        "star",
        "moon",
        "sun",
        "judgement",
        "world"
      ]
    },
    "HookId": {
      "type": "string",
      "enum": [
        "FLOOR_START",
        "ROOM_REVEALED",
        "ORDER_CONSTRAINT",
        "BEFORE_FIRST_RESOLVE_ATTEMPT",
        "AFTER_FIRST_RESOLUTION"
      ]
    },
    "StringKey": { "type": "string", "minLength": 1 },

    "MajorUi": {
      "type": "object",
      "additionalProperties": false,
      "required": ["nameKey", "shadowSummaryKey", "giftSummaryKey"],
      "properties": {
        "nameKey": { "$ref": "#/$defs/StringKey" },
        "shadowSummaryKey": { "$ref": "#/$defs/StringKey" },
        "giftSummaryKey": { "$ref": "#/$defs/StringKey" }
      }
    },

    "MajorShadow": {
      "type": "object",
      "additionalProperties": false,
      "required": ["trigger", "effect"],
      "properties": {
        "trigger": { "$ref": "#/$defs/HookId" },
        "effect": { "$ref": "#/$defs/EffectNode" }
      }
    },

    "MajorGift": {
      "type": "object",
      "additionalProperties": false,
      "required": ["effect"],
      "properties": {
        "effect": { "$ref": "#/$defs/EffectNode" }
      }
    },

    "MajorDefinition": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "ui", "shadow", "gift"],
      "properties": {
        "id": { "$ref": "#/$defs/MajorId" },
        "ui": { "$ref": "#/$defs/MajorUi" },
        "shadow": { "$ref": "#/$defs/MajorShadow" },
        "gift": { "$ref": "#/$defs/MajorGift" }
      }
    },

    "SelectorKind": {
      "type": "string",
      "enum": [
        "PLAYER_CHOICE",
        "RANDOM",
        "LEFTMOST",
        "HIGHEST_VALUE",
        "IF_ENEMY_PRESENT_PLAYER_CHOICE",
        "IF_ANY_REVERSED_PLAYER_CHOICE"
      ]
    },

    "Selector": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind"],
      "properties": {
        "kind": { "$ref": "#/$defs/SelectorKind" },
        "tieBreak": { "type": "string", "enum": ["PLAYER_CHOICE"] }
      }
    },

    "EffectType": {
      "type": "string",
      "enum": [
        "NOOP",
        "SEQUENCE",
        "CHOICE",
        "CONDITIONAL",

        "REROLL_REVEALED",
        "EXILE_REPLACE_REVEALED",
        "CLEANSE_REVEALED",

        "PEEK_TOP_N",
        "REORDER_TOP_N",
        "REORDER_ROOM_BY_VALUE",
        "REORDER_ROOM_ARBITRARY",

        "BARGAIN",

        "DISABLE_FATE_ACTION",
        "SET_WEAPON_RESTRICTION_MODE",
        "SET_ORDER_CONSTRAINT",
        "SET_FLOOR_PARAM",
        "FORCED_EXILE_FIRST_RESOLVE_ATTEMPT"
      ]
    },

    "EffectNode": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type"],
      "properties": {
        "type": { "$ref": "#/$defs/EffectType" },

        "effects": {
          "type": "array",
          "items": { "$ref": "#/$defs/EffectNode" }
        },

        "promptKey": { "$ref": "#/$defs/StringKey" },
        "options": {
          "type": "array",
          "items": { "$ref": "#/$defs/ChoiceOption" }
        },

        "if": { "$ref": "#/$defs/Predicate" },
        "then": { "$ref": "#/$defs/EffectNode" },
        "else": { "$ref": "#/$defs/EffectNode" },

        "selector": { "$ref": "#/$defs/Selector" },

        "n": { "type": "integer", "enum": [3] },
        "canReorder": { "type": "boolean" },

        "fateAction": { "type": "string", "enum": ["CLEANSE", "REROLL"] },
        "scope": { "type": "string", "enum": ["THIS_ROOM", "THIS_FLOOR"] },

        "weaponRestrictionMode": { "type": "string", "enum": ["DEFAULT", "STRICT"] },

        "orderConstraint": {
          "type": "string",
          "enum": ["NONE", "LEFT_TO_RIGHT", "RIGHT_TO_LEFT", "SUIT_ORDER", "ASC_VALUE"]
        },
        "requiresChooseCarriedFirst": { "type": "boolean" },

        "paramKey": { "type": "string", "minLength": 1 },
        "paramValue": { "type": "string", "minLength": 1 },

        "bargainOptions": {
          "type": "array",
          "minItems": 2,
          "items": { "$ref": "#/$defs/BargainOption" }
        }
      },
      "allOf": [
        {
          "if": { "properties": { "type": { "const": "SEQUENCE" } } },
          "then": { "required": ["effects"] }
        },
        {
          "if": { "properties": { "type": { "const": "CHOICE" } } },
          "then": { "required": ["promptKey", "options"] }
        },
        {
          "if": { "properties": { "type": { "const": "CONDITIONAL" } } },
          "then": { "required": ["if", "then", "else"] }
        },
        {
          "if": {
            "properties": {
              "type": {
                "enum": ["REROLL_REVEALED", "EXILE_REPLACE_REVEALED", "CLEANSE_REVEALED"]
              }
            }
          },
          "then": { "required": ["selector"] }
        },
        {
          "if": { "properties": { "type": { "const": "PEEK_TOP_N" } } },
          "then": { "required": ["n", "canReorder"] }
        },
        {
          "if": { "properties": { "type": { "const": "REORDER_TOP_N" } } },
          "then": { "required": ["n"] }
        },
        {
          "if": { "properties": { "type": { "const": "DISABLE_FATE_ACTION" } } },
          "then": { "required": ["fateAction", "scope"] }
        },
        {
          "if": { "properties": { "type": { "const": "SET_WEAPON_RESTRICTION_MODE" } } },
          "then": { "required": ["weaponRestrictionMode", "scope"] }
        },
        {
          "if": { "properties": { "type": { "const": "SET_ORDER_CONSTRAINT" } } },
          "then": { "required": ["orderConstraint", "requiresChooseCarriedFirst", "scope"] }
        },
        {
          "if": { "properties": { "type": { "const": "SET_FLOOR_PARAM" } } },
          "then": { "required": ["paramKey", "paramValue", "scope"] }
        },
        {
          "if": { "properties": { "type": { "const": "BARGAIN" } } },
          "then": { "required": ["promptKey", "options"] }
        }
      ]
    },

    "ChoiceOption": {
      "type": "object",
      "additionalProperties": false,
      "required": ["labelKey", "effect"],
      "properties": {
        "labelKey": { "$ref": "#/$defs/StringKey" },
        "effect": { "$ref": "#/$defs/EffectNode" }
      }
    },

    "BargainOption": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "payGold": { "type": "integer", "minimum": 0, "maximum": 9999 },
        "takeDamage": { "type": "integer", "minimum": 0, "maximum": 999 },
        "heal": { "type": "integer", "minimum": 0, "maximum": 999 },
        "gainGold": { "type": "integer", "minimum": 0, "maximum": 9999 }
      }
    },

    "Predicate": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind"],
      "properties": {
        "kind": {
          "type": "string",
          "enum": ["ROOM_HAS_ENEMY", "ROOM_HAS_ANY_EFFECTIVE_REVERSED", "PLAYER_GOLD_AT_LEAST"]
        },
        "value": { "type": "integer", "minimum": 0, "maximum": 9999 }
      }
    }
  }
}
```

### 16.2 save_blob.schema.json (exact)

File: save_blob.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://foolsgambit.dev/schemas/save_blob.schema.json",
  "title": "Fool's Gambit - Save Blob",
  "type": "object",
  "additionalProperties": false,
  "required": ["header", "seed", "runConfig", "rngState", "state", "actionLog"],
  "properties": {
    "header": { "$ref": "#/$defs/Header" },
    "seed": { "type": "integer" },
    "runConfig": {
      "type": "object",
      "additionalProperties": false,
      "required": ["runLengthTarget", "fateCap"],
      "properties": {
        "runLengthTarget": { "type": "integer", "enum": [7, 14, 21] },
        "fateCap": { "type": "integer", "const": 10 }
      }
    },
    "rngState": {
      "type": "object",
      "additionalProperties": false,
      "required": ["algo", "state"],
      "properties": {
        "algo": { "type": "string", "enum": ["xorshift32"] },
        "state": { "type": "integer", "minimum": 0 }
      }
    },
    "state": { "$ref": "https://foolsgambit.dev/schemas/run_state.schema.json" },
    "actionLog": { "$ref": "https://foolsgambit.dev/schemas/action_log.schema.json" },
    "checksum": {
      "type": ["string", "null"],
      "description": "Optional SHA-256 checksum of canonical serialization for corruption detection."
    }
  },
  "$defs": {
    "Header": {
      "type": "object",
      "additionalProperties": false,
      "required": ["engineVersion", "contentVersion", "specVersion", "saveVersion", "createdAtUTC"],
      "properties": {
        "engineVersion": { "type": "string", "minLength": 1 },
        "contentVersion": { "type": "string", "minLength": 1 },
        "specVersion": { "type": "string", "const": "v1.1" },
        "saveVersion": { "type": "integer", "minimum": 1 },
        "createdAtUTC": { "type": "string", "minLength": 10 }
      }
    }
  }
}
```

### 16.3 action_log.schema.json (exact)

File: action_log.schema.json

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://foolsgambit.dev/schemas/action_log.schema.json",
  "title": "Fool's Gambit - Action Log",
  "type": "object",
  "additionalProperties": false,
  "required": ["header", "seed", "actions"],
  "properties": {
    "header": { "$ref": "#/$defs/Header" },
    "seed": { "type": "integer" },
    "actions": {
      "type": "array",
      "items": { "$ref": "#/$defs/Action" }
    },
    "checkpoints": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["stepIndex", "stateHash"],
        "properties": {
          "stepIndex": { "type": "integer", "minimum": 0 },
          "stateHash": { "type": "string", "minLength": 8 }
        }
      }
    }
  },
  "$defs": {
    "Header": {
      "type": "object",
      "additionalProperties": false,
      "required": ["engineVersion", "contentVersion", "specVersion", "createdAtUTC"],
      "properties": {
        "engineVersion": { "type": "string", "minLength": 1 },
        "contentVersion": { "type": "string", "minLength": 1 },
        "specVersion": { "type": "string", "const": "v1.1" },
        "createdAtUTC": { "type": "string", "minLength": 10 }
      }
    },

    "ActionType": {
      "type": "string",
      "enum": [
        "START_RUN",
        "START_FLOOR",
        "SELECT_ATTUNEMENT",

        "CHOOSE_FLEE",
        "CHOOSE_ENGAGE",
        "SELECT_CARRIED_CARD",

        "USE_LEAP_OF_FAITH",
        "SPEND_FATE_REROLL",
        "SPEND_FATE_CLEANSE",
        "SPEND_FATE_EXILE_REPLACE",
        "SPEND_FATE_CHEAT_WEAPON",

        "USE_SPELL_CLEANSE",
        "USE_SPELL_REROLL",

        "USE_MAJOR_GIFT",

        "COMMIT_RESOLVE",
        "ACE_CHOICE",
        "ENEMY_FIGHT_CHOICE",
        "SWORDS_AMBUSH_BLOCK_CHOICE",
        "CUPS_8_10_CHOICE",
        "BARGAIN_CHOICE",

        "REORDER_TOP3",
        "REORDER_ROOM4"
      ]
    },

    "Action": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type"],
      "properties": {
        "type": { "$ref": "#/$defs/ActionType" },

        "seed": { "type": "integer" },
        "runLengthTarget": { "type": "integer", "enum": [7, 14, 21] },

        "majorIds": {
          "type": "array",
          "items": { "type": "string" },
          "maxItems": 3
        },

        "slotIndex": { "type": "integer", "minimum": 0, "maximum": 3 },

        "majorId": { "type": "string" },

        "optionId": { "type": "string" },

        "enemyMode": { "type": "string", "enum": ["barehand", "weapon"] },
        "block": { "type": "boolean" },
        "cupsChoice": { "type": "string", "enum": ["heal", "equipArmor"] },
        "bargainChoice": { "type": "string", "enum": ["pay", "takeDamage"] },

        "order": {
          "type": "array",
          "items": { "type": "integer", "minimum": 0 },
          "description": "Permutation for reorder actions (top3 or room4)."
        }
      }
    }
  }
}
```

### 16.4 run_state.schema.json

Use the full RunState schema you already generated (the long one). It must be saved as:

packages/game-data/schemas/run_state.schema.json

If you later add fields, bump saveVersion and implement migration.

---

## 17. Content validator script (Ajv) (required)

Place at:
packages/game-data/scripts/validate-content.mjs

Use the validator outline you already generated. It must:

- validate majors.json against majors.schema.json
- validate strings.en.json
- ensure all referenced string keys exist

Expose from root:
npm run validate:content

---

## 18. Development phases (locked sequence) + deliverables

Each phase must end with:

- tests passing in CI
- patch\_[uniqueID].md updated in devprogress
- any required replay/golden fixtures updated

### Phase A: Foundations

Deliverables:

- monorepo structure
- schemas committed
- content scaffolding committed
- Ajv validator + CI wired
- deterministic RNG module + unit tests
- devprogress patch file for Phase A

Exit criteria:

- npm run validate:content passes
- CI green

### Phase B: Engine core loop (rooms + minors)

Deliverables:

- RunState + reducer skeleton
- deal-to-4 with carried slot behavior
- resolve pipeline with effective orientation
- all Minor suits + Aces + equipment + combat + Fate + Leap
- unit tests for each branch and invariants
- devprogress patch file for Phase B

Exit criteria:

- headless simulation can complete rooms reliably
- tests cover suit logic and combat

### Phase C: Floors + boss

Deliverables:

- floor start procedure
- engaged room counting and flee restriction
- boss deck build from floor discard only
- boss corruption and boss rooms required by floor range
- replay tests for boss scenarios
- devprogress patch file for Phase C

Exit criteria:

- headless simulation can run a full floor loop and boss

### Phase D: Majors via data-driven primitives (no hardcoding)

Deliverables:

- hook dispatcher wired to majors.json
- primitive interpreter complete
- all 21 majors encoded in majors.json
- at least one replay test per major
- devprogress patch file for Phase D

Exit criteria:

- no per-major bespoke code paths (only primitives + interpreter)
- majors behave correctly under tests

### Phase E: Web client MVP

Deliverables:

- Pixi table, HUD, modals, log panel
- UI driven by getLegalActions + applyAction events
- save/resume
- export/import action log
- devprogress patch file for Phase E

Exit criteria:

- playable end-to-end (7-major run) with reproducible logs

### Phase F: Hardening + parity corpus

Deliverables:

- invariants and fuzz/property tests (time budgeted)
- replay corpus (100+ runs) under /replays
- stable state hashing
- devprogress patch file for Phase F

Exit criteria:

- CI includes fuzz/invariants
- replay corpus stable

### Phase G: Unity parity harness (before UI)

Deliverables:

- C# xorshift32 identical
- content loader + schema validation (or pre-validated build step)
- C# reducer + primitives interpreter
- replay runner that compares state hashes at checkpoints
- devprogress patch file for Phase G

Exit criteria:

- parity corpus passes in Unity runner

### Phase H: Unity UI

Deliverables:

- Unity table UI driven by engine
- same action model and logs
- platform save/load
- devprogress patch file for Phase H

Exit criteria:

- parity still passes
- playable Unity build

---

## 19. PR quality gates (required)

Any PR touching packages/game-core must include:

- relevant unit tests and/or replay updates
- if state schema changes: saveVersion bump + migration + schema update
- if content changes: contentVersion update + strings sync + validator passes
- update the phase patch file in devprogress

Bug reports must include:

- engineVersion
- contentVersion
- seed
- exported action log
