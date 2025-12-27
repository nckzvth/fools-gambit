import type { RunState } from "./types.js";

export type HashableRunState = Omit<RunState, "debug">;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = canonicalize(v);
    }
    return out;
  }
  throw new Error(`Unsupported value in canonicalize: ${String(value)}`);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function buildHashInput(state: RunState): HashableRunState {
  const { debug: _debug, ...rest } = state;
  return rest;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  if (globalThis.crypto?.subtle?.digest) {
    const data = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
    return bytesToHex(new Uint8Array(digest));
  }

  const nodeCrypto = await import("node:crypto");
  return nodeCrypto.createHash("sha256").update(text).digest("hex");
}

export async function hashRunState(state: RunState): Promise<string> {
  const json = stableStringify(buildHashInput(state));
  return sha256Hex(json);
}
