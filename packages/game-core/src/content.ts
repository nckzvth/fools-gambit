import type { MajorId } from "./types.js";

export type StringsBundle = Record<string, string>;

export type SelectorKind =
  | "PLAYER_CHOICE"
  | "RANDOM"
  | "LEFTMOST"
  | "HIGHEST_VALUE"
  | "IF_ENEMY_PRESENT_PLAYER_CHOICE"
  | "IF_ANY_REVERSED_PLAYER_CHOICE";

export type Selector = { kind: SelectorKind; tieBreak?: "PLAYER_CHOICE" };

export type BargainOption = {
  payGold?: number;
  takeDamage?: number;
  heal?: number;
  gainGold?: number;
};

export type Predicate = {
  kind: "ROOM_HAS_ENEMY" | "ROOM_HAS_ANY_EFFECTIVE_REVERSED" | "PLAYER_GOLD_AT_LEAST";
  value?: number;
};

export type ChoiceOption = { labelKey: string; effect: EffectNode };

export type EffectNode = {
  type:
    | "NOOP"
    | "SEQUENCE"
    | "CHOICE"
    | "CONDITIONAL"
    | "REROLL_REVEALED"
    | "EXILE_REPLACE_REVEALED"
    | "CLEANSE_REVEALED"
    | "PEEK_TOP_N"
    | "REORDER_TOP_N"
    | "REORDER_ROOM_BY_VALUE"
    | "REORDER_ROOM_ARBITRARY"
    | "BARGAIN"
    | "DISABLE_FATE_ACTION"
    | "SET_WEAPON_RESTRICTION_MODE"
    | "SET_ORDER_CONSTRAINT"
    | "SET_FLOOR_PARAM"
    | "FORCED_EXILE_FIRST_RESOLVE_ATTEMPT";

  effects?: EffectNode[];

  promptKey?: string;
  options?: ChoiceOption[];

  if?: Predicate;
  then?: EffectNode;
  else?: EffectNode;

  selector?: Selector;

  n?: 3;
  canReorder?: boolean;

  fateAction?: "CLEANSE" | "REROLL";
  scope?: "THIS_ROOM" | "THIS_FLOOR";

  weaponRestrictionMode?: "DEFAULT" | "STRICT";

  orderConstraint?: "NONE" | "LEFT_TO_RIGHT" | "RIGHT_TO_LEFT" | "SUIT_ORDER" | "ASC_VALUE";
  requiresChooseCarriedFirst?: boolean;

  paramKey?: string;
  paramValue?: string;

  bargainOptions?: BargainOption[];
};

export type HookId = "FLOOR_START" | "ROOM_REVEALED" | "ORDER_CONSTRAINT" | "BEFORE_FIRST_RESOLVE_ATTEMPT" | "AFTER_FIRST_RESOLUTION";

export type MajorDefinition = {
  id: MajorId;
  ui: { nameKey: string; shadowSummaryKey: string; giftSummaryKey: string };
  shadow: { trigger: HookId; effect: EffectNode };
  gift: { effect: EffectNode };
};

export type MajorsContent = { contentVersion: string; majors: MajorDefinition[] };

export type LoadedContent = {
  majors: MajorsContent;
  strings: StringsBundle;
  majorById: Record<MajorId, MajorDefinition>;
};

let loaded: LoadedContent | null = null;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function loadContent(bundle: { majors: MajorsContent; strings: StringsBundle }): LoadedContent {
  assert(bundle.majors && typeof bundle.majors === "object", "loadContent: majors bundle required");
  assert(typeof bundle.majors.contentVersion === "string" && bundle.majors.contentVersion.length > 0, "loadContent: majors.contentVersion required");
  assert(Array.isArray(bundle.majors.majors) && bundle.majors.majors.length === 21, "loadContent: majors.majors must be length 21");
  assert(bundle.strings && typeof bundle.strings === "object" && !Array.isArray(bundle.strings), "loadContent: strings bundle required");

  const majorById = Object.create(null) as Record<MajorId, MajorDefinition>;
  for (const m of bundle.majors.majors) {
    majorById[m.id] = m;
  }

  loaded = { majors: bundle.majors, strings: bundle.strings, majorById };
  return loaded;
}

export function getLoadedContent(): LoadedContent {
  if (!loaded) throw new Error("Content not loaded. Call loadContent({majors, strings}) first.");
  return loaded;
}

