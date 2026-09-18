import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Ties a running daemon back to the exact commit and tree state its runtime bundle was built
 * from (scripts/build-runtime-bundle.ts writes this into the bundle's manifest.json), so a
 * broken or misbehaving install can be diagnosed instead of guessed at from "it's the latest
 * version" alone.
 */
export interface RuntimeBuildStamp {
  commit: string;
  dirty: boolean;
  builtAt: string;
}

/** manifest.json lives at the runtime bundle root, one level above this file's own app/ directory. */
export function defaultManifestPath(): string {
  return join(dirname(import.meta.dir), "manifest.json");
}

export function parseRuntimeBuildStamp(raw: string): RuntimeBuildStamp | undefined {
  let build: Partial<RuntimeBuildStamp> | undefined;
  try {
    build = (JSON.parse(raw) as { build?: Partial<RuntimeBuildStamp> }).build;
  } catch {
    return undefined;
  }
  if (!build
    || typeof build.commit !== "string"
    || typeof build.dirty !== "boolean"
    || typeof build.builtAt !== "string") return undefined;
  return { commit: build.commit, dirty: build.dirty, builtAt: build.builtAt };
}

export function runtimeBuildStamp(manifestPath = defaultManifestPath()): RuntimeBuildStamp | undefined {
  try {
    return parseRuntimeBuildStamp(readFileSync(manifestPath, "utf8"));
  } catch {
    return undefined;
  }
}

export function formatRuntimeBuildStamp(stamp = runtimeBuildStamp()): string {
  if (!stamp) return "build stamp is unavailable (running from source, or a bundle built before stamping)";
  return `built from ${stamp.commit}${stamp.dirty ? " (dirty tree)" : ""} at ${stamp.builtAt}`;
}
