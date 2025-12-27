import { applyAction, createRun, getLegalActions, loadContent } from "@fg/game-core";
import type { GameEvent, LegalAction, RunState } from "@fg/game-core";
import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  Texture
} from "pixi.js";

import artManifest from "../../../packages/game-data/content/art/art.manifest.json";
import majors from "../../../packages/game-data/content/majors.json";
import strings from "../../../packages/game-data/content/strings.en.json";

type MajorId = RunState["floor"]["activeMajorId"];

type ActionLogHeader = {
  engineVersion: string;
  contentVersion: string;
  specVersion: "v1.1";
  createdAtUTC: string;
};

type StartRunAction = { type: "START_RUN"; seed: number; runLengthTarget: 7 | 14 | 21 };
type ActionLog = { header: ActionLogHeader; seed: number; actions: Array<StartRunAction | LegalAction> };

const SAVE_KEY = "fg.actionLog.v1";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} element`);
  return el;
}

function nowUTC(): string {
  return new Date().toISOString();
}

function makeHeader(contentVersion: string): ActionLogHeader {
  return { engineVersion: "0.1.0", contentVersion, specVersion: "v1.1", createdAtUTC: nowUTC() };
}

function loadSavedActionLog(): ActionLog | null {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ActionLog;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.seed !== "number" || !Array.isArray(parsed.actions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveActionLog(log: ActionLog): void {
  localStorage.setItem(SAVE_KEY, JSON.stringify(log));
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatMajorId(id: MajorId): string {
  const key = `majors.${id}.name`;
  return (strings as Record<string, string>)[key] ?? id;
}

function formatShadowSummary(id: MajorId): string {
  const key = `majors.${id}.shadow`;
  return (strings as Record<string, string>)[key] ?? key;
}

function suitLabel(s: string): string {
  return s[0]!.toUpperCase() + s.slice(1);
}

function minorRankLabel(card: RunState["decks"]["cards"]["minors"][string]["rank"]): { short: string; numeric: number | null } {
  if (card.kind === "ace") return { short: "A", numeric: null };
  if (card.kind === "number") return { short: String(card.value), numeric: card.value };
  const face = card.face;
  if (face === "page") return { short: "Pg", numeric: 11 };
  if (face === "knight") return { short: "Kn", numeric: 12 };
  if (face === "queen") return { short: "Q", numeric: 13 };
  return { short: "K", numeric: 14 };
}

function toCanonicalMinorArtId(card: RunState["decks"]["cards"]["minors"][string]): string {
  const suit = card.suit;
  const rank = minorRankLabel(card.rank).short;
  return `minor.${suit}.${rank}`;
}

function toCanonicalMajorArtId(majorId: MajorId): string {
  return `major.${majorId}`;
}

function getArtUrlForCanonicalId(canonicalId: string): string {
  // Vite serves/copies `publicDir` at the web root; manifest paths are relative to the art folder.
  const base = import.meta.env.BASE_URL;
  if (canonicalId === "card.back") return new URL(base + artManifest.back, window.location.href).href;
  if (canonicalId === "major.fool") return new URL(base + artManifest.fool, window.location.href).href;

  if (canonicalId.startsWith("major.")) {
    const id = canonicalId.slice("major.".length) as keyof typeof artManifest.majors;
    const rel = (artManifest.majors as any)[id] as string | undefined;
    if (!rel) throw new Error(`Unknown major art id: ${canonicalId}`);
    return new URL(base + rel, window.location.href).href;
  }

  if (canonicalId.startsWith("minor.")) {
    const parts = canonicalId.split(".");
    const suit = parts[1];
    const rank = parts[2];
    if (!suit || !rank) throw new Error(`Invalid canonical minor art id: ${canonicalId}`);
    const rel = (artManifest.minors as any)[suit]?.[rank] as string | undefined;
    if (!rel) throw new Error(`Unknown minor art id: ${canonicalId}`);
    return new URL(base + rel, window.location.href).href;
  }

  throw new Error(`Unknown canonical art id: ${canonicalId}`);
}

async function preloadAllArt(): Promise<void> {
  const urls: string[] = [];
  urls.push(getArtUrlForCanonicalId("card.back"));
  urls.push(getArtUrlForCanonicalId("major.fool"));
  for (const id of Object.keys(artManifest.majors)) urls.push(getArtUrlForCanonicalId(`major.${id}`));
  for (const suit of Object.keys(artManifest.minors)) {
    for (const rank of Object.keys((artManifest.minors as any)[suit] ?? {})) urls.push(getArtUrlForCanonicalId(`minor.${suit}.${rank}`));
  }
  await Assets.load(urls);
}

function describeAction(a: StartRunAction | LegalAction): string {
  if (a.type === "START_RUN") return `START_RUN seed=${a.seed} runLength=${a.runLengthTarget}`;
  switch (a.type) {
    case "CHOOSE_ENGAGE":
      return "Engage";
    case "CHOOSE_FLEE":
      return "Flee";
    case "SELECT_ATTUNEMENT":
      return `Attune: ${a.majorIds.join(", ") || "none"}`;
    case "SELECT_CARRIED_CARD":
      return `Carry: slot ${a.slotIndex + 1}`;
    case "USE_LEAP_OF_FAITH":
      return `Leap → slot ${a.slotIndex + 1}`;
    case "SPEND_FATE_REROLL":
      return `Fate Reroll → slot ${a.slotIndex + 1}`;
    case "SPEND_FATE_CLEANSE":
      return `Fate Cleanse → slot ${a.slotIndex + 1}`;
    case "SPEND_FATE_EXILE_REPLACE":
      return `Fate Exile+Replace → slot ${a.slotIndex + 1}`;
    case "SPEND_FATE_CHEAT_WEAPON":
      return "Fate Cheat-Weapon";
    case "USE_SPELL_CLEANSE":
      return `Spell Cleanse → slot ${a.slotIndex + 1}`;
    case "USE_SPELL_REROLL":
      return `Spell Reroll → slot ${a.slotIndex + 1}`;
    case "USE_MAJOR_GIFT":
      return `Major ${a.majorId}${a.optionId ? ` (${a.optionId})` : ""}${a.slotIndex !== undefined ? ` → slot ${a.slotIndex + 1}` : ""}`;
    case "COMMIT_RESOLVE":
      return `Resolve slot ${a.slotIndex + 1}`;
    case "ACE_CHOICE":
      return `Ace: ${a.optionId}`;
    case "ENEMY_FIGHT_CHOICE":
      return `Fight: ${a.enemyMode}`;
    case "SWORDS_AMBUSH_BLOCK_CHOICE":
      return `Ambush: ${a.block ? "block" : "no block"}`;
    case "CUPS_8_10_CHOICE":
      return `Cups: ${a.cupsChoice}`;
    case "BARGAIN_CHOICE":
      return `Bargain: ${a.bargainChoice}`;
    case "REORDER_TOP3":
      return `Reorder top3: [${a.order.join(",")}]`;
    case "REORDER_ROOM4":
      return `Reorder room: [${a.order.join(",")}]`;
  }
}

function formatEvent(e: GameEvent): string {
  switch (e.type) {
    case "ROOM_REVEALED":
      return "ROOM_REVEALED";
    case "PEEK_TOP_N":
      return `PEEK_TOP_${e.n}`;
    case "PLAYER_HP_CHANGED":
      return `HP ${e.delta >= 0 ? "+" : ""}${e.delta} → ${e.hp}`;
    case "PLAYER_GOLD_CHANGED":
      return `GOLD ${e.delta >= 0 ? "+" : ""}${e.delta} → ${e.gold}`;
    case "PLAYER_FATE_CHANGED":
      return `FATE ${e.delta >= 0 ? "+" : ""}${e.delta} → ${e.fate}`;
    case "CARD_BOTTOMED":
      return `BOTTOMED ${e.cardId}`;
    case "CARD_EXILED":
      return `EXILED ${e.cardId}`;
    case "CARD_RESOLVED":
      return `RESOLVED slot ${e.slotIndex + 1} ${e.cardId}`;
    case "EQUIP_WEAPON":
      return `EQUIP weapon ${e.cardId}`;
    case "EQUIP_ARMOR":
      return `EQUIP armor ${e.cardId}`;
    case "EQUIP_SPELL":
      return `EQUIP spell ${e.cardId}`;
    case "DISCARD_EQUIPMENT":
      return `DISCARD ${e.kind} ${e.cardId}`;
  }
}

type DragPayload =
  | { kind: "ROOM_CARD"; slotIndex: number; startX: number; startY: number }
  | { kind: "FLEE_CARD"; startX: number; startY: number }
  | { kind: "FATE_TOKEN"; startX: number; startY: number }
  | { kind: "FOOL_TOKEN"; startX: number; startY: number }
  | { kind: "SPELL_CARD"; startX: number; startY: number };

type UiMode =
  | { kind: "PLAY" }
  | { kind: "PROMPT_CHOICE"; actions: LegalAction[]; anchor?: { x: number; y: number } }
  | { kind: "PROMPT_REORDER_TOP3"; top3: string[] }
  | { kind: "PROMPT_REORDER_ROOM4"; slots: Array<string | null> };

async function main() {
  loadContent({ majors: majors as any, strings: strings as any });

  const host = $("stage");
  const seedInput = $("seedInput") as HTMLInputElement;
  const runLengthSelect = $("runLengthSelect") as HTMLSelectElement;
  const newRunBtn = $("newRunBtn") as HTMLButtonElement;
  const resumeBtn = $("resumeBtn") as HTMLButtonElement;
  const exportBtn = $("exportBtn") as HTMLButtonElement;
  const importInput = $("importInput") as HTMLInputElement;
  const toggleLogBtn = $("toggleLogBtn") as HTMLButtonElement;
  const closeLogBtn = $("closeLogBtn") as HTMLButtonElement;
  const logPanel = $("logPanel") as HTMLDivElement;
  const logPanelBody = $("logPanelBody") as HTMLDivElement;

  const app = new Application();
  await app.init({ resizeTo: host, antialias: true, backgroundAlpha: 0 });
  host.appendChild(app.canvas);

  // Layers
  const root = new Container();
  app.stage.addChild(root);

  const table = new Container();
  table.sortableChildren = true;
  root.addChild(table);

  const ui = new Container();
  root.addChild(ui);

  const overlay = new Container();
  overlay.sortableChildren = true;
  root.addChild(overlay);

  const tooltipLayer = new Container();
  root.addChild(tooltipLayer);

  // Loading screen
  const loadingText = new Text({
    text: "Loading art…",
    style: new TextStyle({ fill: 0xe6e6e6, fontFamily: "system-ui", fontSize: 18 })
  });
  loadingText.anchor.set(0.5);
  loadingText.position.set(app.screen.width / 2, app.screen.height / 2);
  ui.addChild(loadingText);
  try {
    await preloadAllArt();
    ui.removeChild(loadingText);
  } catch (err) {
    loadingText.text = `Failed to load art.\n${String(err)}`;
    throw err;
  }

  // Text styles
  const labelStyle = new TextStyle({ fill: 0xe6e6e6, fontFamily: "system-ui", fontSize: 14 });
  const smallStyle = new TextStyle({ fill: 0x9da3af, fontFamily: "system-ui", fontSize: 12 });

  // Engine session
  let state: RunState | null = null;
  let actionLog: ActionLog | null = null;
  const timeline: Array<{ kind: "ACTION" | "EVENT"; text: string }> = [];
  let lastPeekTop: string[] | null = null;

  let uiMode: UiMode = { kind: "PLAY" };
  let pendingPreviewSlot: number | null = null;
  let armedResolveSlot: number | null = null;
  let pendingDrag: { payload: DragPayload; dragStarted: boolean } | null = null;

  // --- Visual components (card-first) ---
  type CardView = {
    container: Container;
    sprite: Sprite;
    frame: Graphics;
    overlay: Graphics;
    badge: Text;
    slotIndex?: number;
    kind: "ROOM" | "EQUIP" | "FLEE" | "MAJOR" | "TOKEN";
    baseX: number;
    baseY: number;
    w: number;
    h: number;
  };

  function makeCardView(kind: CardView["kind"]): CardView {
    const container = new Container();
    container.eventMode = "static";
    container.cursor = "pointer";

    const frame = new Graphics();
    container.addChild(frame);

    const sprite = new Sprite(Texture.EMPTY);
    sprite.anchor.set(0.5);
    container.addChild(sprite);

    const overlayG = new Graphics();
    container.addChild(overlayG);

    const badge = new Text({ text: "", style: smallStyle });
    badge.anchor.set(0.5);
    container.addChild(badge);

    return { container, sprite, frame, overlay: overlayG, badge, kind, baseX: 0, baseY: 0, w: 0, h: 0 };
  }

  function drawCardFrame(v: CardView, stroke = 0x2a2f3a, fill = 0x0b0f18) {
    v.frame.clear();
    v.frame.roundRect(-v.w / 2, -v.h / 2, v.w, v.h, 16).stroke({ width: 2, color: stroke }).fill({ color: fill });
  }

  function setCardTexture(v: CardView, texture: Texture) {
    v.sprite.texture = texture;
  }

  function layoutCard(v: CardView, x: number, y: number, w: number, h: number) {
    v.baseX = x;
    v.baseY = y;
    v.w = w;
    v.h = h;
    v.container.position.set(x, y);
    v.sprite.position.set(0, 0);
    v.sprite.width = w - 12;
    v.sprite.height = h - 12;
    drawCardFrame(v);
    v.badge.position.set(0, -h / 2 + 12);
    v.overlay.position.set(0, 0);
  }

  function hoverLift(v: CardView, on: boolean) {
    if (uiMode.kind !== "PLAY") return;
    if (pendingDrag?.payload.kind === "ROOM_CARD" && pendingDrag.dragStarted && pendingDrag.payload.slotIndex === v.slotIndex) return;
    v.container.zIndex = on ? 100 : 0;
    v.container.scale.set(on ? 1.03 : 1);
    v.container.position.set(v.baseX, v.baseY - (on ? 10 : 0));
  }

  // Room row (4 cards)
  const roomRow = new Container();
  roomRow.sortableChildren = true;
  table.addChild(roomRow);
  const roomCards: CardView[] = [makeCardView("ROOM"), makeCardView("ROOM"), makeCardView("ROOM"), makeCardView("ROOM")];
  for (let i = 0; i < 4; i += 1) {
    const v = roomCards[i]!;
    v.slotIndex = i;
    roomRow.addChild(v.container);
  }

  // Carry slot (dedicated visible slot that shows carried-in card; accepts drop only when SELECT_CARRIED_CARD is legal)
  const carrySlot = new Container();
  table.addChild(carrySlot);
  const carryFrame = new Graphics();
  carrySlot.addChild(carryFrame);
  const carryLabel = new Text({ text: "Carry", style: smallStyle });
  carryLabel.anchor.set(0.5);
  carrySlot.addChild(carryLabel);
  const carryCard = makeCardView("EQUIP");
  carrySlot.addChild(carryCard.container);

  // Resolve lane
  const resolveLane = new Container();
  table.addChild(resolveLane);
  const resolveLaneG = new Graphics();
  resolveLane.addChild(resolveLaneG);
  const resolveLaneT = new Text({ text: "Resolve", style: smallStyle });
  resolveLaneT.anchor.set(0.5);
  resolveLane.addChild(resolveLaneT);

  // Equipment slots
  const equipRow = new Container();
  table.addChild(equipRow);
  const weaponCard = makeCardView("EQUIP");
  const armorCard = makeCardView("EQUIP");
  const spellCard = makeCardView("EQUIP");
  equipRow.addChild(weaponCard.container, armorCard.container, spellCard.container);
  const weaponLabel = new Text({ text: "Weapon", style: smallStyle });
  const armorLabel = new Text({ text: "Armor", style: smallStyle });
  const spellLabel = new Text({ text: "Spell", style: smallStyle });
  for (const l of [weaponLabel, armorLabel, spellLabel]) {
    l.anchor.set(0.5);
    equipRow.addChild(l);
  }

  // Flee card (card-first)
  const fleeCard = makeCardView("FLEE");
  table.addChild(fleeCard.container);
  const fleeText = new Text({ text: "FLEE", style: labelStyle });
  fleeText.anchor.set(0.5);
  fleeCard.container.addChild(fleeText);

  // HUD strip (informational + token pickup)
  const hud = new Container();
  ui.addChild(hud);
  const hudBg = new Graphics();
  hud.addChild(hudBg);
  const hpText = new Text({ text: "", style: labelStyle });
  const goldText = new Text({ text: "", style: labelStyle });
  const fateText = new Text({ text: "", style: labelStyle });
  hud.addChild(hpText, goldText, fateText);

  const fateToken = makeCardView("TOKEN");
  fateToken.badge.text = "Fate";
  hud.addChild(fateToken.container);
  const foolToken = makeCardView("TOKEN");
  foolToken.badge.text = "Fool";
  hud.addChild(foolToken.container);

  // Floor header
  const floorHeader = new Container();
  ui.addChild(floorHeader);
  const floorText = new Text({ text: "", style: labelStyle });
  const shadowChip = new Text({ text: "", style: smallStyle });
  floorHeader.addChild(floorText, shadowChip);

  // Prompt overlay (card-based choices)
  const promptLayer = new Container();
  promptLayer.sortableChildren = true;
  overlay.addChild(promptLayer);

  // Tooltip
  const tooltip = new Container();
  tooltip.visible = false;
  tooltipLayer.addChild(tooltip);
  const tooltipBg = new Graphics();
  tooltip.addChild(tooltipBg);
  const tooltipText = new Text({ text: "", style: smallStyle });
  tooltipText.anchor.set(0, 0);
  tooltip.addChild(tooltipText);

  function showTooltip(text: string, x: number, y: number) {
    tooltip.visible = true;
    tooltipText.text = text;
    const pad = 8;
    const w = tooltipText.width + pad * 2;
    const h = tooltipText.height + pad * 2;
    tooltipBg.clear().roundRect(0, 0, w, h, 10).fill({ color: 0x0b0f18, alpha: 0.92 }).stroke({ width: 1, color: 0x2a2f3a });
    tooltipText.position.set(pad, pad);
    const clampedX = Math.max(8, Math.min(x + 12, app.screen.width - w - 8));
    const clampedY = Math.max(8, Math.min(y + 12, app.screen.height - h - 8));
    tooltip.position.set(clampedX, clampedY);
  }

  function hideTooltip() {
    tooltip.visible = false;
  }

  function appendLine(kind: "ACTION" | "EVENT", text: string) {
    timeline.push({ kind, text });
    while (timeline.length > 250) timeline.shift();
    logPanelBody.textContent = timeline.map((l) => `${l.kind}: ${l.text}`).join("\n");
    logPanelBody.scrollTop = logPanelBody.scrollHeight;
  }

  function dispatch(action: StartRunAction | LegalAction) {
    assert(state && actionLog, "No active run");

    appendLine("ACTION", describeAction(action));
    actionLog.actions.push(action as any);

    if (action.type === "START_RUN") {
      saveActionLog(actionLog);
      exportBtn.disabled = false;
      return;
    }

    const res = applyAction(state, action);
    state = res.nextState;
    for (const e of res.events) {
      if (e.type === "PEEK_TOP_N") lastPeekTop = e.cardIds;
      appendLine("EVENT", formatEvent(e));
    }
    saveActionLog(actionLog);
    exportBtn.disabled = false;
    renderAll();
  }

  function beginNewRun(seed: number, runLengthTarget: 7 | 14 | 21) {
    state = createRun({ seed, runLengthTarget });
    lastPeekTop = null;
    uiMode = { kind: "PLAY" };
    pendingPreviewSlot = null;
    pendingDrag = null;
    timeline.length = 0;

    actionLog = {
      header: makeHeader((majors as any).contentVersion ?? "unknown"),
      seed,
      actions: [{ type: "START_RUN", seed, runLengthTarget }]
    };
    saveActionLog(actionLog);
    appendLine("ACTION", `START_RUN seed=${seed} runLength=${runLengthTarget}`);
    exportBtn.disabled = false;
    renderAll();
  }

  function replayFromLog(log: ActionLog) {
    assert(log.actions.length > 0 && (log.actions[0] as any).type === "START_RUN", "Log must start with START_RUN");
    const sr = log.actions[0] as StartRunAction;
    let s = createRun({ seed: sr.seed, runLengthTarget: sr.runLengthTarget });
    const events: GameEvent[] = [];
    for (const a of log.actions.slice(1)) {
      const res = applyAction(s, a as LegalAction);
      events.push(...res.events);
      s = res.nextState;
    }
    state = s;
    actionLog = log;
    timeline.length = 0;
    lastPeekTop = null;
    appendLine("ACTION", describeAction(sr));
    for (const a of log.actions.slice(1)) appendLine("ACTION", describeAction(a as LegalAction));
    for (const e of events) {
      if (e.type === "PEEK_TOP_N") lastPeekTop = e.cardIds;
      appendLine("EVENT", formatEvent(e));
    }
    exportBtn.disabled = false;
    renderAll();
  }

  // --- Prompt system (card-based, no side panel required) ---
  const choiceCards: Array<{ view: CardView; action: LegalAction }> = [];
  const choiceTitle = new Text({ text: "", style: labelStyle });
  choiceTitle.anchor.set(0.5);
  promptLayer.addChild(choiceTitle);

  function clearPromptLayer() {
    for (const c of choiceCards) {
      promptLayer.removeChild(c.view.container);
    }
    choiceCards.length = 0;
    promptLayer.removeChildren(1); // keep title at index 0
  }

  function showChoicePrompt(title: string, actions: LegalAction[], anchor?: { x: number; y: number }) {
    clearPromptLayer();
    uiMode = anchor ? { kind: "PROMPT_CHOICE", actions, anchor } : { kind: "PROMPT_CHOICE", actions };
    choiceTitle.text = title;
    choiceTitle.position.set(anchor?.x ?? app.screen.width / 2, (anchor?.y ?? app.screen.height / 2) - 90);
    const max = Math.min(actions.length, 8);
    const cols = Math.min(4, max);
    const rows = Math.ceil(max / cols);
    const cardW = 150;
    const cardH = 200;
    const gap = 14;
    const startX = (anchor?.x ?? app.screen.width / 2) - ((cols - 1) * (cardW + gap)) / 2;
    const startY = (anchor?.y ?? app.screen.height / 2) - ((rows - 1) * (cardH + gap)) / 2;
    for (let i = 0; i < max; i += 1) {
      const a = actions[i]!;
      const v = makeCardView("MAJOR");
      v.container.zIndex = 200 + i;
      promptLayer.addChild(v.container);
      layoutCard(v, startX + (i % cols) * (cardW + gap), startY + Math.floor(i / cols) * (cardH + gap), cardW, cardH);
      setCardTexture(v, Assets.get(getArtUrlForCanonicalId("card.back")) as Texture);
      drawCardFrame(v, 0x7aa2ff, 0x0b0f18);
      const t = new Text({ text: describeAction(a), style: smallStyle });
      t.anchor.set(0.5);
      t.position.set(0, 0);
      v.container.addChild(t);
      v.container.on("pointerenter", (ev) => showTooltip(describeAction(a), ev.globalX, ev.globalY));
      v.container.on("pointerleave", hideTooltip);
      v.container.on("pointerdown", () => {
        hideTooltip();
        uiMode = { kind: "PLAY" };
        clearPromptLayer();
        dispatch(a);
      });
      choiceCards.push({ view: v, action: a });
    }
  }

  function showReorderTop3Prompt(top3: string[]) {
    clearPromptLayer();
    uiMode = { kind: "PROMPT_REORDER_TOP3", top3 };
    choiceTitle.text = "Reorder top 3 (click two to swap, then confirm)";
    choiceTitle.position.set(app.screen.width / 2, app.screen.height / 2 - 120);

    const order = [0, 1, 2];
    let selected: number | null = null;
    const cards: CardView[] = [];
    const w = 180;
    const h = 260;
    const gap = 16;
    const startX = app.screen.width / 2 - (w + gap);
    const y = app.screen.height / 2;
    for (let i = 0; i < 3; i += 1) {
      const v = makeCardView("MAJOR");
      promptLayer.addChild(v.container);
      layoutCard(v, startX + i * (w + gap), y, w, h);
      cards.push(v);
    }

    const confirm = makeCardView("MAJOR");
    promptLayer.addChild(confirm.container);
    layoutCard(confirm, app.screen.width / 2, app.screen.height / 2 + 180, 240, 90);
    setCardTexture(confirm, Assets.get(getArtUrlForCanonicalId("card.back")) as Texture);
    const confirmText = new Text({ text: "Confirm", style: labelStyle });
    confirmText.anchor.set(0.5);
    confirm.container.addChild(confirmText);

    const render = () => {
      for (let i = 0; i < 3; i += 1) {
        const v = cards[i]!;
        const cardId = top3[order[i]!]!;
        const minor = state?.decks.cards.minors[cardId];
        const canonical = minor ? toCanonicalMinorArtId(minor) : "card.back";
        setCardTexture(v, Assets.get(getArtUrlForCanonicalId(canonical)) as Texture);
        drawCardFrame(v, selected === i ? 0x7aa2ff : 0x2a2f3a, 0x0b0f18);
      }
    };
    render();

    for (let i = 0; i < 3; i += 1) {
      const v = cards[i]!;
      v.container.on("pointerdown", () => {
        if (selected === null) selected = i;
        else {
          const tmp = order[selected]!;
          order[selected] = order[i]!;
          order[i] = tmp;
          selected = null;
        }
        render();
      });
    }
    confirm.container.on("pointerdown", () => {
      uiMode = { kind: "PLAY" };
      clearPromptLayer();
      dispatch({ type: "REORDER_TOP3", order: [...order] });
    });
  }

  function showReorderRoomPrompt(slots: Array<string | null>) {
    clearPromptLayer();
    uiMode = { kind: "PROMPT_REORDER_ROOM4", slots };
    choiceTitle.text = "Reorder room (click two to swap, then confirm)";
    choiceTitle.position.set(app.screen.width / 2, app.screen.height / 2 - 140);

    const order = [0, 1, 2, 3];
    let selected: number | null = null;
    const cards: CardView[] = [];
    const w = 170;
    const h = 250;
    const gap = 12;
    const startX = app.screen.width / 2 - (w * 2 + gap * 1.5);
    const y = app.screen.height / 2;
    for (let i = 0; i < 4; i += 1) {
      const v = makeCardView("MAJOR");
      promptLayer.addChild(v.container);
      layoutCard(v, startX + i * (w + gap), y, w, h);
      cards.push(v);
    }

    const confirm = makeCardView("MAJOR");
    promptLayer.addChild(confirm.container);
    layoutCard(confirm, app.screen.width / 2, app.screen.height / 2 + 190, 240, 90);
    setCardTexture(confirm, Assets.get(getArtUrlForCanonicalId("card.back")) as Texture);
    const confirmText = new Text({ text: "Confirm", style: labelStyle });
    confirmText.anchor.set(0.5);
    confirm.container.addChild(confirmText);

    const render = () => {
      for (let i = 0; i < 4; i += 1) {
        const v = cards[i]!;
        const cardId = slots[order[i]!] ?? null;
        if (!cardId || !state) {
          setCardTexture(v, Assets.get(getArtUrlForCanonicalId("card.back")) as Texture);
          drawCardFrame(v, selected === i ? 0x7aa2ff : 0x2a2f3a, 0x0b0f18);
          continue;
        }
        const minor = state.decks.cards.minors[cardId];
        const canonical = minor ? toCanonicalMinorArtId(minor) : "card.back";
        setCardTexture(v, Assets.get(getArtUrlForCanonicalId(canonical)) as Texture);
        drawCardFrame(v, selected === i ? 0x7aa2ff : 0x2a2f3a, 0x0b0f18);
      }
    };
    render();

    for (let i = 0; i < 4; i += 1) {
      const v = cards[i]!;
      v.container.on("pointerdown", () => {
        if (selected === null) selected = i;
        else {
          const tmp = order[selected]!;
          order[selected] = order[i]!;
          order[i] = tmp;
          selected = null;
        }
        render();
      });
    }
    confirm.container.on("pointerdown", () => {
      uiMode = { kind: "PLAY" };
      clearPromptLayer();
      dispatch({ type: "REORDER_ROOM4", order: [...order] });
    });
  }

  function syncPromptFromEngine() {
    if (!state) return;
    const legal = getLegalActions(state);

    if (state.phase === "FloorStart") {
      const claimed = state.majors.claimed;
      if (claimed.length === 0) {
        // No attunement available; auto-confirm empty.
        const a = legal.find((x) => x.type === "SELECT_ATTUNEMENT" && x.majorIds.length === 0);
        if (a) dispatch(a);
        return;
      }

      // Card-based attunement selection prompt.
      const actions = legal.filter((a): a is Extract<LegalAction, { type: "SELECT_ATTUNEMENT" }> => a.type === "SELECT_ATTUNEMENT");
      const anchor = { x: app.screen.width / 2, y: app.screen.height / 2 };
      showChoicePrompt("Attune (up to 3)", actions, anchor);
      return;
    }

    const pending = state.debug?.pendingPrompt;
    if (!pending) {
      if (uiMode.kind !== "PLAY") {
        uiMode = { kind: "PLAY" };
        clearPromptLayer();
      }
      return;
    }

    if (pending.kind === "MAJOR_REORDER_TOP3") {
      const top3 = lastPeekTop?.slice(0, 3) ?? [];
      showReorderTop3Prompt(top3);
      return;
    }

    if (pending.kind === "MAJOR_REORDER_ROOM4") {
      showReorderRoomPrompt([...state.room.slots]);
      return;
    }

    // Generic prompt -> show legal actions as choice cards.
    showChoicePrompt("Choose", legal, { x: app.screen.width / 2, y: app.screen.height / 2 });
  }

  // --- Rendering ---
  function renderHud() {
    if (!state) return;
    const pad = 10;
    const h = 80;
    const width = Math.min(560, app.screen.width - 20);
    const y = app.screen.height - h - 10;
    const x = Math.floor(app.screen.width / 2 - width / 2);
    hud.position.set(x, y);
    hudBg
      .clear()
      .roundRect(0, 0, width, h, 14)
      .fill({ color: 0x0b0f18, alpha: 0.7 })
      .stroke({ width: 1, color: 0x2a2f3a });

    hpText.text = `HP ${state.player.hp}/${state.player.maxHp}`;
    goldText.text = `Gold ${state.player.gold}`;
    fateText.text = `Fate ${state.player.fate}/${state.fateCap}`;
    hpText.position.set(pad, 12);
    goldText.position.set(pad, 34);
    fateText.position.set(pad, 56);

    layoutCard(fateToken, width - 130, 40, 90, 60);
    setCardTexture(fateToken, Assets.get(getArtUrlForCanonicalId("card.back")) as Texture);
    drawCardFrame(fateToken, 0x2a2f3a, 0x0b0f18);
    fateToken.container.cursor = "pointer";

    layoutCard(foolToken, width - 40, 40, 90, 60);
    setCardTexture(foolToken, Assets.get(getArtUrlForCanonicalId("major.fool")) as Texture);
    drawCardFrame(foolToken, 0x2a2f3a, 0x0b0f18);
    foolToken.container.cursor = "pointer";
    foolToken.container.alpha = state.room.leapUsed ? 0.4 : 1;
  }

  function renderHeader() {
    if (!state) return;
    floorHeader.position.set(14, 60);
    floorText.text = `Floor ${state.floor.floorNumber} — Goal ${state.runLengthTarget} — Boss: ${formatMajorId(state.floor.activeMajorId)}`;
    shadowChip.text = `Shadow: ${formatShadowSummary(state.floor.activeMajorId)}${state.floor.bossMode ? " • Boss corruption" : ""}`;
    floorText.position.set(0, 0);
    shadowChip.position.set(0, 20);
  }

  function renderCarrySlot() {
    if (!state) return;
    const w = 140;
    const h = 200;
    carrySlot.position.set(carrySlot.position.x, carrySlot.position.y);
    carryFrame.clear().roundRect(-w / 2, -h / 2, w, h, 16).stroke({ width: 2, color: 0x2a2f3a }).fill({ color: 0x0b0f18, alpha: 0.5 });
    carryLabel.position.set(0, -h / 2 + 14);

    const carriedInIndex = state.room.carriedIndex;
    if (carriedInIndex !== null) {
      const id = state.room.slots[carriedInIndex];
      if (id) {
        const minor = state.decks.cards.minors[id];
        const canonical = minor ? toCanonicalMinorArtId(minor) : "card.back";
        layoutCard(carryCard, 0, 0, w, h);
        setCardTexture(carryCard, Assets.get(getArtUrlForCanonicalId(canonical)) as Texture);
        const reversed = minor?.orientation === "reversed";
        carryCard.container.rotation = reversed ? Math.PI : 0;
        carryCard.badge.text = "Carried";
        return;
      }
    }
    layoutCard(carryCard, 0, 0, w, h);
    setCardTexture(carryCard, Assets.get(getArtUrlForCanonicalId("card.back")) as Texture);
    carryCard.container.rotation = 0;
    carryCard.badge.text = "—";
  }

  function renderEquipment() {
    if (!state) return;
    const w = 130;
    const h = 190;
    const baseX = 140;
    const y = app.screen.height / 2 + 250;
    equipRow.position.set(0, 0);

    const slots = [
      { v: weaponCard, label: weaponLabel, name: "Weapon", id: state.player.weapon?.cardId ?? null },
      { v: armorCard, label: armorLabel, name: "Armor", id: state.player.armor?.cardId ?? null },
      { v: spellCard, label: spellLabel, name: "Spell", id: state.player.spell?.cardId ?? null }
    ];

    for (let i = 0; i < slots.length; i += 1) {
      const s = slots[i]!;
      const x = baseX + i * (w + 16);
      layoutCard(s.v, x, y, w, h);
      s.label.position.set(x, y + h / 2 + 14);

      if (!s.id) {
        setCardTexture(s.v, Assets.get(getArtUrlForCanonicalId("card.back")) as Texture);
        s.v.container.alpha = 0.4;
        s.v.badge.text = s.name;
        s.v.container.rotation = 0;
        continue;
      }
      const card = state.decks.cards.minors[s.id];
      const canonical = card ? toCanonicalMinorArtId(card) : "card.back";
      setCardTexture(s.v, Assets.get(getArtUrlForCanonicalId(canonical)) as Texture);
      s.v.container.alpha = 1;
      s.v.container.rotation = card?.orientation === "reversed" ? Math.PI : 0;
      s.v.badge.text = s.name;
    }

    // Weapon restriction badge
    const weapon = state.player.weapon;
    if (weapon) {
      const last = weapon.lastHelpedDefeatValue;
      if (last !== null) {
        const strict = state.rules.weaponRestrictionMode === "STRICT";
        weaponCard.badge.text = strict ? `Weapon < ${last}` : `Weapon ≤ ${last}`;
      }
    }
  }

  function renderRoomRow() {
    if (!state) return;
    const maxRowW = Math.min(1240, app.screen.width * 0.78);
    const w = Math.min(280, Math.max(190, Math.floor((maxRowW - 3 * 22) / 4)));
    const h = Math.floor(w * 1.45);
    const gap = 22;
    const total = w * 4 + gap * 3;
    const startX = app.screen.width / 2 - total / 2 + w / 2;
    const y = Math.floor(app.screen.height * 0.52);
    for (let i = 0; i < 4; i += 1) {
      const v = roomCards[i]!;
      const x = startX + i * (w + gap);
      layoutCard(v, x, y, w, h);

      const cardId = state.room.slots[i];
      const resolved = state.room.resolvedMask[i];
      if (!cardId) {
        setCardTexture(v, Assets.get(getArtUrlForCanonicalId("card.back")) as Texture);
        v.container.alpha = 0.25;
        v.badge.text = "";
        v.container.rotation = 0;
        v.overlay.clear();
        continue;
      }
      const minor = state.decks.cards.minors[cardId];
      if (!minor) {
        setCardTexture(v, Assets.get(getArtUrlForCanonicalId("card.back")) as Texture);
        v.container.alpha = resolved ? 0.25 : 1;
        drawCardFrame(v, 0x2a2f3a, 0x0b0f18);
        v.badge.text = "";
        v.container.rotation = 0;
        v.overlay.clear();
        continue;
      }
      const canonical = minor ? toCanonicalMinorArtId(minor) : "card.back";
      setCardTexture(v, Assets.get(getArtUrlForCanonicalId(canonical)) as Texture);
      v.container.alpha = resolved ? 0.25 : 1;
      v.container.rotation = minor?.orientation === "reversed" ? Math.PI : 0;

      const legal = getLegalActions(state);
      const isResolvable = legal.some((a) => a.type === "COMMIT_RESOLVE" && a.slotIndex === i);
      const isCarryPick = legal.some((a) => a.type === "SELECT_CARRIED_CARD" && a.slotIndex === i);
      const isLeapTarget = legal.some((a) => a.type === "USE_LEAP_OF_FAITH" && a.slotIndex === i);

      const stroke =
        armedResolveSlot === i
          ? 0x7aa2ff
          : pendingPreviewSlot === i
            ? 0x3a4354
            : isResolvable
              ? 0x66ff99
              : isCarryPick
                ? 0xffd479
                : 0x2a2f3a;
      drawCardFrame(v, stroke, 0x0b0f18);

      v.overlay.clear();
      const cleanseSeal = state.room.pendingCleanses[i];
      if (cleanseSeal) v.overlay.circle(0, 0, 18).stroke({ width: 3, color: 0x7aa2ff, alpha: 0.9 });
      if (isLeapTarget && !state.room.leapUsed) v.overlay.circle(0, -h / 2 + 26, 10).fill({ color: 0xffd479, alpha: 0.9 });

      // Boss corruption veil on numbered minors (effective reversed)
      if (state.floor.bossMode && minor?.rank.kind === "number") {
        v.overlay.roundRect(-w / 2 + 6, -h / 2 + 6, w - 12, h - 12, 14).fill({ color: 0x1b2a55, alpha: 0.18 });
      }

      // Elite marker: reversed courts are elite (+2)
      if (minor?.rank.kind === "court" && minor.orientation === "reversed") {
        v.overlay.roundRect(-w / 2 + 8, -h / 2 + 8, 62, 22, 8).fill({ color: 0x6b1f37, alpha: 0.85 });
        const elite = new Text({ text: "ELITE", style: new TextStyle({ fill: 0xffffff, fontFamily: "system-ui", fontSize: 11 }) });
        elite.anchor.set(0, 0);
        elite.position.set(-w / 2 + 14, -h / 2 + 12);
        v.container.addChild(elite);
        app.ticker.addOnce(() => v.container.removeChild(elite));
      }

      v.badge.text = resolved ? "Resolved" : "";
    }

    // Carry slot and resolve lane placement derived from row.
    carrySlot.position.set(startX - w * 0.9, y - h * 0.35);
    renderCarrySlot();

    const laneW = total;
    const laneH = 70;
    const laneX = app.screen.width / 2;
    const laneY = y - h / 2 - 56;
    resolveLane.position.set(laneX, laneY);
    resolveLaneG.clear().roundRect(-laneW / 2, -laneH / 2, laneW, laneH, 14).stroke({ width: 2, color: 0x2a2f3a }).fill({ color: 0x0b0f18, alpha: 0.35 });
    resolveLaneT.position.set(0, 0);

    // Flee card placement
    layoutCard(fleeCard, startX + (w + gap) * 3 + w * 0.9, y, w * 0.78, h * 0.62);
    setCardTexture(fleeCard, Assets.get(getArtUrlForCanonicalId("card.back")) as Texture);
    const canFlee = getLegalActions(state).some((a) => a.type === "CHOOSE_FLEE");
    fleeCard.container.alpha = canFlee ? 1 : 0.4;
    drawCardFrame(fleeCard, canFlee ? 0x2a2f3a : 0x6b1f37, 0x0b0f18);
    fleeText.position.set(0, 0);

    // Equipment row below the room row, centered.
    const equipY = y + h / 2 + 140;
    const equipW = Math.min(140, Math.max(110, Math.floor(w * 0.55)));
    const equipH = Math.floor(equipW * 1.46);
    const equipGap = 16;
    const equipTotal = equipW * 3 + equipGap * 2;
    const equipStartX = app.screen.width / 2 - equipTotal / 2 + equipW / 2;
    weaponCard.container.position.set(equipStartX, equipY);
    armorCard.container.position.set(equipStartX + (equipW + equipGap), equipY);
    spellCard.container.position.set(equipStartX + 2 * (equipW + equipGap), equipY);
    weaponLabel.position.set(weaponCard.container.position.x, equipY + equipH / 2 + 16);
    armorLabel.position.set(armorCard.container.position.x, equipY + equipH / 2 + 16);
    spellLabel.position.set(spellCard.container.position.x, equipY + equipH / 2 + 16);

    // Re-layout equipment card frames to match new sizes.
    for (const v of [weaponCard, armorCard, spellCard]) {
      layoutCard(v, v.container.position.x, v.container.position.y, equipW, equipH);
    }
    renderEquipment();
  }

  function renderAll() {
    if (!state) return;
    renderHeader();
    renderHud();
    renderRoomRow();
    syncPromptFromEngine();
  }

  // --- Interactions ---
  function setPreview(slotIndex: number | null) {
    pendingPreviewSlot = slotIndex;
    renderRoomRow();
  }

  function legalForSlot(slotIndex: number): LegalAction[] {
    if (!state) return [];
    return getLegalActions(state).filter((a) => (a as any).slotIndex === slotIndex);
  }

  function isPointInCard(v: CardView, x: number, y: number): boolean {
    const b = v.container.getBounds();
    return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  }

  function inRect(cx: number, cy: number, rx: number, ry: number, rw: number, rh: number) {
    return cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh;
  }

  function boundsRect(c: Container) {
    const b = c.getBounds();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }

  function dispatchAutoEngageIfNeeded() {
    if (!state || !actionLog) return;
    if (state.phase !== "RoomChoice") return;
    const legal = getLegalActions(state);
    const engage = legal.find((a) => a.type === "CHOOSE_ENGAGE");
    if (!engage) return;
    dispatch(engage);
  }

  function armResolve(slotIndex: number) {
    armedResolveSlot = slotIndex;
    renderRoomRow();
  }

  function disarmResolve() {
    armedResolveSlot = null;
    renderRoomRow();
  }

  function clickResolve(slotIndex: number) {
    if (!state) return;
    dispatchAutoEngageIfNeeded();
    if (!state) return;

    const legal = getLegalActions(state);
    const canResolve = legal.some((a) => a.type === "COMMIT_RESOLVE" && a.slotIndex === slotIndex);
    if (!canResolve) return;

    if (armedResolveSlot !== slotIndex) {
      armResolve(slotIndex);
      return;
    }
    disarmResolve();
    dispatch({ type: "COMMIT_RESOLVE", slotIndex });
  }

  function pickToken(payloadKind: DragPayload["kind"]) {
    if (!state) return;
    if (uiMode.kind !== "PLAY") return;
    if (payloadKind === "FATE_TOKEN" && state.player.fate <= 0) return;
    if (payloadKind === "FOOL_TOKEN" && state.room.leapUsed) return;
    pendingDrag = { payload: { kind: payloadKind, startX: 0, startY: 0 } as any, dragStarted: false };
  }

  // Room cards
  for (const v of roomCards) {
    v.container.on("pointerenter", (ev) => {
      if (!state) return;
      const idx = v.slotIndex!;
      const cardId = state.room.slots[idx];
      if (!cardId) return;
      const card = state.decks.cards.minors[cardId];
      if (!card) return;
      const rank = minorRankLabel(card.rank);
      const text = [
        `${rank.short} of ${suitLabel(card.suit)} (${card.orientation})`,
        card.rank.kind === "court" && card.orientation === "reversed" ? "Elite (+2)" : "",
        state.floor.bossMode && card.rank.kind === "number" ? "Boss corruption: treated as reversed" : "",
        state.room.pendingCleanses[idx] ? "Cleansed for next resolution" : ""
      ]
        .filter(Boolean)
        .join("\n");
      showTooltip(text, ev.globalX, ev.globalY);
      hoverLift(v, true);
      setPreview(idx);
    });
    v.container.on("pointerleave", () => {
      hideTooltip();
      hoverLift(v, false);
      setPreview(null);
    });

    v.container.on("pointerdown", (ev) => {
      if (!state) return;
      if (uiMode.kind !== "PLAY") return;
      const idx = v.slotIndex!;
      const cardId = state.room.slots[idx];
      if (!cardId) return;

      disarmResolve();
      pendingDrag = { payload: { kind: "ROOM_CARD", slotIndex: idx, startX: ev.globalX, startY: ev.globalY }, dragStarted: false };
    });
  }

  // Flee
  fleeCard.container.on("pointerenter", (ev) => {
    if (!state) return;
    const canFlee = getLegalActions(state).some((a) => a.type === "CHOOSE_FLEE");
    showTooltip(canFlee ? "Drag onto room to flee" : "Cannot flee twice in a row", ev.globalX, ev.globalY);
    hoverLift(fleeCard, true);
  });
  fleeCard.container.on("pointerleave", () => {
    hideTooltip();
    hoverLift(fleeCard, false);
  });
  fleeCard.container.on("pointerdown", (ev) => {
    if (!state) return;
    if (uiMode.kind !== "PLAY") return;
    pendingDrag = { payload: { kind: "FLEE_CARD", startX: ev.globalX, startY: ev.globalY }, dragStarted: false };
  });

  // Fate token pickup
  fateToken.container.on("pointerenter", (ev) => showTooltip("Pick up Fate token (drop on card/weapon)", ev.globalX, ev.globalY));
  fateToken.container.on("pointerleave", hideTooltip);
  fateToken.container.on("pointerdown", (ev) => {
    ev.stopPropagation();
    pickToken("FATE_TOKEN");
  });

  // Fool token pickup
  foolToken.container.on("pointerenter", (ev) => showTooltip("Pick up Fool token (Leap of Faith)", ev.globalX, ev.globalY));
  foolToken.container.on("pointerleave", hideTooltip);
  foolToken.container.on("pointerdown", (ev) => {
    ev.stopPropagation();
    pickToken("FOOL_TOKEN");
  });

  // Spell card drag-to-target
  spellCard.container.on("pointerenter", (ev) => showTooltip("Drag spell onto a room card", ev.globalX, ev.globalY));
  spellCard.container.on("pointerleave", hideTooltip);
  spellCard.container.on("pointerdown", (ev) => {
    if (!state) return;
    if (!state.player.spell) return;
    if (uiMode.kind !== "PLAY") return;
    pendingDrag = { payload: { kind: "SPELL_CARD", startX: ev.globalX, startY: ev.globalY }, dragStarted: false };
  });

  // Global pointer move/up for dragging
  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;

  app.stage.on("pointermove", (ev) => {
    if (!pendingDrag) return;
    const dx = ev.globalX - pendingDrag.payload.startX;
    const dy = ev.globalY - pendingDrag.payload.startY;
    if (!pendingDrag.dragStarted && Math.hypot(dx, dy) > 8) pendingDrag.dragStarted = true;

    const p = pendingDrag.payload;
    if (!pendingDrag.dragStarted) return;

    if (p.kind === "ROOM_CARD") {
      const v = roomCards[p.slotIndex]!;
      v.container.position.set(ev.globalX, ev.globalY);
    } else if (p.kind === "FLEE_CARD") {
      fleeCard.container.position.set(ev.globalX, ev.globalY);
    } else if (p.kind === "FATE_TOKEN") {
      fateToken.container.position.set(ev.globalX, ev.globalY);
    } else if (p.kind === "FOOL_TOKEN") {
      foolToken.container.position.set(ev.globalX, ev.globalY);
    } else if (p.kind === "SPELL_CARD") {
      spellCard.container.position.set(ev.globalX, ev.globalY);
    }
  });

  app.stage.on("pointerup", (ev) => {
    if (!state || !pendingDrag) return;
    const p = pendingDrag.payload;
    const dragStarted = pendingDrag.dragStarted;
    pendingDrag = null;

    const resetPositions = () => {
      renderAll();
    };

    if (!dragStarted) {
      // Treat as click.
      if (p.kind === "ROOM_CARD") {
        const idx = p.slotIndex;
        clickResolve(idx);
        return;
      }
      resetPositions();
      return;
    }

    // Drop targets
    const { x: laneX, y: laneY, w: laneW, h: laneH } = boundsRect(resolveLane);
    const { x: carryX, y: carryY, w: carryW, h: carryH } = boundsRect(carrySlot);
    const { x: weaponX, y: weaponY, w: weaponW, h: weaponH } = boundsRect(weaponCard.container);
    const roomBounds = boundsRect(roomRow);

    if (p.kind === "ROOM_CARD") {
      const idx = p.slotIndex;
      dispatchAutoEngageIfNeeded();
      if (!state) return;
      const legal = getLegalActions(state);
      const canCarryPick = legal.some((a) => a.type === "SELECT_CARRIED_CARD" && a.slotIndex === idx);
      const canResolve = legal.some((a) => a.type === "COMMIT_RESOLVE" && a.slotIndex === idx);

      if (inRect(ev.globalX, ev.globalY, carryX, carryY, carryW, carryH) && canCarryPick) {
        disarmResolve();
        dispatch({ type: "SELECT_CARRIED_CARD", slotIndex: idx });
        return;
      }

      if (inRect(ev.globalX, ev.globalY, laneX, laneY, laneW, laneH) && canResolve) {
        disarmResolve();
        dispatch({ type: "COMMIT_RESOLVE", slotIndex: idx });
        return;
      }

      resetPositions();
      return;
    }

    if (p.kind === "FLEE_CARD") {
      const canFlee = getLegalActions(state).some((a) => a.type === "CHOOSE_FLEE");
      if (inRect(ev.globalX, ev.globalY, roomBounds.x, roomBounds.y, roomBounds.w, roomBounds.h) && canFlee) {
        dispatch({ type: "CHOOSE_FLEE" });
        return;
      }
      resetPositions();
      return;
    }

    if (p.kind === "FOOL_TOKEN") {
      if (state.room.leapUsed) {
        resetPositions();
        return;
      }
      // Drop onto any room card slot with Leap legal.
      for (let i = 0; i < 4; i += 1) {
        const v = roomCards[i]!;
        if (!isPointInCard(v, ev.globalX, ev.globalY)) continue;
        const ok = getLegalActions(state).some((a) => a.type === "USE_LEAP_OF_FAITH" && a.slotIndex === i);
        if (ok) {
          dispatch({ type: "USE_LEAP_OF_FAITH", slotIndex: i });
          return;
        }
      }
      resetPositions();
      return;
    }

    if (p.kind === "SPELL_CARD") {
      if (!state.player.spell) {
        resetPositions();
        return;
      }
      for (let i = 0; i < 4; i += 1) {
        const v = roomCards[i]!;
        if (!isPointInCard(v, ev.globalX, ev.globalY)) continue;
        const legal = getLegalActions(state);
        const opts: LegalAction[] = [];
        if (legal.some((a) => a.type === "USE_SPELL_CLEANSE" && a.slotIndex === i)) opts.push({ type: "USE_SPELL_CLEANSE", slotIndex: i });
        if (legal.some((a) => a.type === "USE_SPELL_REROLL" && a.slotIndex === i)) opts.push({ type: "USE_SPELL_REROLL", slotIndex: i });
        if (opts.length === 0) break;
        showChoicePrompt("Spell", opts, { x: ev.globalX, y: ev.globalY });
        return;
      }
      resetPositions();
      return;
    }

    if (p.kind === "FATE_TOKEN") {
      const legal = getLegalActions(state);
      const canCheat = legal.some((a) => a.type === "SPEND_FATE_CHEAT_WEAPON");
      if (canCheat && inRect(ev.globalX, ev.globalY, weaponX, weaponY, weaponW, weaponH)) {
        dispatch({ type: "SPEND_FATE_CHEAT_WEAPON" });
        return;
      }

      // Drop onto a room card -> choose fate action as choice-cards.
      for (let i = 0; i < 4; i += 1) {
        const v = roomCards[i]!;
        if (!isPointInCard(v, ev.globalX, ev.globalY)) continue;
        const opts: LegalAction[] = [];
        if (legal.some((a) => a.type === "SPEND_FATE_REROLL" && a.slotIndex === i)) opts.push({ type: "SPEND_FATE_REROLL", slotIndex: i });
        if (legal.some((a) => a.type === "SPEND_FATE_CLEANSE" && a.slotIndex === i)) opts.push({ type: "SPEND_FATE_CLEANSE", slotIndex: i });
        if (legal.some((a) => a.type === "SPEND_FATE_EXILE_REPLACE" && a.slotIndex === i)) opts.push({ type: "SPEND_FATE_EXILE_REPLACE", slotIndex: i });
        if (opts.length === 0) {
          resetPositions();
          return;
        }
        showChoicePrompt("Spend Fate", opts, { x: ev.globalX, y: ev.globalY });
        return;
      }
      resetPositions();
      return;
    }
  });

  // --- Controls / log UI (optional, not required to play) ---
  toggleLogBtn.onclick = () => {
    logPanel.style.display = logPanel.style.display === "none" || !logPanel.style.display ? "block" : "none";
  };
  closeLogBtn.onclick = () => {
    logPanel.style.display = "none";
  };

  newRunBtn.onclick = () => {
    const seed = Number(seedInput.value || "1");
    const runLengthTarget = Number(runLengthSelect.value) as 7 | 14 | 21;
    beginNewRun(seed, runLengthTarget);
  };

  exportBtn.onclick = () => {
    if (!actionLog) return;
    downloadJson(`fools-gambit_actionlog_seed${actionLog.seed}.json`, actionLog);
  };

  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = JSON.parse(text) as ActionLog;
    replayFromLog(parsed);
    importInput.value = "";
    resumeBtn.disabled = false;
  };

  const saved = loadSavedActionLog();
  resumeBtn.disabled = !saved;
  resumeBtn.onclick = () => {
    const log = loadSavedActionLog();
    if (log) replayFromLog(log);
  };

  // Boot
  beginNewRun(1, 7);
}

void main();
