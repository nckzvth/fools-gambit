import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

function readJson(p) {
  const raw = fs.readFileSync(p, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON at ${p}: ${e.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function collectStringKeysFromMajors(majorsJson) {
  const keys = new Set();

  const majors = majorsJson.majors ?? [];
  for (const m of majors) {
    if (m?.ui?.nameKey) keys.add(m.ui.nameKey);
    if (m?.ui?.shadowSummaryKey) keys.add(m.ui.shadowSummaryKey);
    if (m?.ui?.giftSummaryKey) keys.add(m.ui.giftSummaryKey);

    const visitEffect = (eff) => {
      if (!eff || typeof eff !== "object") return;

      if (eff.type === "CHOICE" || eff.type === "BARGAIN") {
        if (eff.promptKey) keys.add(eff.promptKey);
        if (Array.isArray(eff.options)) {
          for (const opt of eff.options) {
            if (opt?.labelKey) keys.add(opt.labelKey);
            if (opt?.effect) visitEffect(opt.effect);
          }
        }
        return;
      }

      if (eff.type === "SEQUENCE" && Array.isArray(eff.effects)) {
        for (const child of eff.effects) visitEffect(child);
        return;
      }

      if (eff.type === "CONDITIONAL") {
        visitEffect(eff.then);
        visitEffect(eff.else);
        return;
      }

      // primitives: no string keys
    };

    visitEffect(m?.shadow?.effect);
    visitEffect(m?.gift?.effect);
  }

  return [...keys];
}

function main() {
  const repoRoot = process.cwd();
  const schemasDir = path.join(repoRoot, "packages", "game-data", "schemas");
  const dataDir = path.join(repoRoot, "packages", "game-data", "content");

  const majorsSchemaPath = path.join(schemasDir, "majors.schema.json");
  const majorsPath = path.join(dataDir, "majors.json");
  const stringsPath = path.join(dataDir, "strings.en.json");

  const majorsSchema = readJson(majorsSchemaPath);
  const majorsJson = readJson(majorsPath);
  const stringsJson = readJson(stringsPath);

  const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);

  const validateMajors = ajv.compile(majorsSchema);
  const ok = validateMajors(majorsJson);
  if (!ok) {
    console.error("majors.json failed schema validation:");
    console.error(validateMajors.errors);
    process.exit(1);
  }

  // Strings file must be object<string,string>
  if (typeof stringsJson !== "object" || stringsJson === null || Array.isArray(stringsJson)) {
    console.error("strings.en.json must be an object of string->string");
    process.exit(1);
  }
  for (const [k, v] of Object.entries(stringsJson)) {
    if (typeof v !== "string") {
      console.error(`strings.en.json value for key '${k}' must be a string`);
      process.exit(1);
    }
  }

  // Enforce majors integrity beyond schema:
  // - Exactly 21 majors
  // - Unique ids
  // - Id set is exactly the expected one
  const expectedMajorIds = new Set([
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
  ]);

  const majors = majorsJson.majors ?? [];
  assert(Array.isArray(majors), "majors.json: 'majors' must be an array.");
  assert(majors.length === 21, `majors.json: expected 21 majors, got ${majors.length}.`);

  const seen = new Set();
  for (const m of majors) {
    const id = m?.id;
    assert(typeof id === "string" && id.length > 0, "majors.json: each major must have a non-empty string id.");
    assert(!seen.has(id), `majors.json: duplicate major id '${id}'.`);
    seen.add(id);
    assert(expectedMajorIds.has(id), `majors.json: unexpected major id '${id}'.`);
  }
  for (const id of expectedMajorIds) {
    assert(seen.has(id), `majors.json: missing required major id '${id}'.`);
  }

  // Enforce that all string keys referenced by majors exist in strings file
  const requiredKeys = collectStringKeysFromMajors(majorsJson);
  const missing = requiredKeys.filter((k) => !(k in stringsJson));
  if (missing.length > 0) {
    console.error("Missing required string keys referenced by majors.json:");
    for (const k of missing) console.error(`- ${k}`);
    process.exit(1);
  }

  console.log(`Content validation passed. majors=${majors.length}, stringsChecked=${requiredKeys.length}`);
}

try {
  main();
} catch (e) {
  console.error(e?.stack || String(e));
  process.exit(1);
}
