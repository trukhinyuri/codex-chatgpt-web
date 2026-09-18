// Codex parses the model catalog all or nothing: one row that its schema rejects makes Codex drop
// the whole catalog and fall back to its built-in models, which removes the ChatGPT Web and proxy
// rows for the user. Rows this bridge does not produce itself (CLIProxyAPI's) are therefore checked
// against the schema Codex deserializes (codex-rs/protocol/src/openai_models.rs, ModelInfo) before
// they are merged: a row missing a required field is left out, and an optional field Codex would
// reject is removed so that Codex applies its default.

type JsonObject = Record<string, unknown>;

/** Rows Codex Desktop receives: model/list asks for one page of 100 and never follows the cursor. */
export const CODEX_CATALOG_PAGE_SIZE = 100;

const VISIBILITY = new Set(["list", "hide", "none"]);
const SHELL_TYPES = new Set(["unified_exec", "default", "local", "shell_command", "disabled"]);
const TRUNCATION_MODES = new Set(["bytes", "tokens"]);
const VERBOSITY = new Set(["low", "medium", "high"]);
const REASONING_SUMMARY = new Set(["auto", "concise", "detailed", "none"]);
const WEB_SEARCH_TOOL_TYPES = new Set(["text", "text_and_image"]);
const APPLY_PATCH_TOOL_TYPES = new Set(["freeform"]);
const INPUT_MODALITIES = new Set(["text", "image", "audio"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

function instructionsOf(row: JsonObject): unknown {
  const messages = row.model_messages;
  return isObject(messages) && isString(messages.instructions_template) ? messages.instructions_template : row.base_instructions;
}

/** Why Codex would reject this row, or null when every required field is present and valid. */
export function catalogRowRejection(row: JsonObject): string | null {
  if (!isString(row.slug) || !row.slug) return "slug";
  if (!isString(row.display_name)) return "display_name";
  if (!Array.isArray(row.supported_reasoning_levels)
    || !row.supported_reasoning_levels.every(level => isObject(level) && isString(level.effort) && isString(level.description))) {
    return "supported_reasoning_levels";
  }
  if (!isString(row.shell_type) || !SHELL_TYPES.has(row.shell_type)) return "shell_type";
  if (!isString(row.visibility) || !VISIBILITY.has(row.visibility)) return "visibility";
  if (typeof row.supported_in_api !== "boolean") return "supported_in_api";
  if (!isInteger(row.priority)) return "priority";
  if (typeof row.support_verbosity !== "boolean") return "support_verbosity";
  const truncation = row.truncation_policy;
  if (!isObject(truncation) || !isString(truncation.mode) || !TRUNCATION_MODES.has(truncation.mode) || !isInteger(truncation.limit)) {
    return "truncation_policy";
  }
  if (!isStringArray(row.experimental_supported_tools)) return "experimental_supported_tools";
  if (!isString(instructionsOf(row))) return "instructions";
  return null;
}

type FieldCheck = (value: unknown) => boolean;

// Optional fields: Codex applies a default when they are absent, and rejects the catalog when they
// hold a value it does not know.
const OPTIONAL_FIELDS: Record<string, FieldCheck> = {
  description: value => value === null || isString(value),
  default_reasoning_level: value => value === null || isString(value),
  default_verbosity: value => value === null || (isString(value) && VERBOSITY.has(value)),
  default_reasoning_summary: value => isString(value) && REASONING_SUMMARY.has(value),
  web_search_tool_type: value => isString(value) && WEB_SEARCH_TOOL_TYPES.has(value),
  apply_patch_tool_type: value => value === null || (isString(value) && APPLY_PATCH_TOOL_TYPES.has(value)),
  input_modalities: value => Array.isArray(value) && value.every(item => isString(item) && INPUT_MODALITIES.has(item)),
  additional_speed_tiers: isStringArray,
  service_tiers: value => Array.isArray(value) && value.every(tier => isObject(tier) && isString(tier.id) && isString(tier.name)),
  context_window: value => value === null || isInteger(value),
  max_context_window: value => value === null || isInteger(value),
  auto_compact_token_limit: value => value === null || isInteger(value),
  effective_context_window_percent: isInteger,
  comp_hash: value => value === null || isString(value),
  include_skills_usage_instructions: value => typeof value === "boolean",
  include_plugin_usage_instructions: value => typeof value === "boolean",
  include_apps_usage_instructions: value => typeof value === "boolean",
  supports_reasoning_summary_parameter: value => typeof value === "boolean",
  supports_image_detail_original: value => typeof value === "boolean",
  supports_search_tool: value => typeof value === "boolean",
  supports_experimental_context: value => typeof value === "boolean",
  use_responses_lite: value => typeof value === "boolean",
  node_repl_auto_review_required: value => typeof value === "boolean",
  node_repl_disabled: value => typeof value === "boolean",
};

/** A copy of the row without optional fields Codex would reject, and the names of those removed. */
export function withoutInvalidOptionalFields(row: JsonObject): { row: JsonObject; removed: string[] } {
  const copy = structuredClone(row);
  const removed: string[] = [];
  for (const [field, valid] of Object.entries(OPTIONAL_FIELDS)) {
    if (field in copy && !valid(copy[field])) {
      delete copy[field];
      removed.push(field);
    }
  }
  return { row: copy, removed };
}

/**
 * Keep the catalog within the page Codex Desktop reads. Rows the picker would hide go first, then the
 * lowest-ranked ones; only rows `removable` accepts are ever dropped.
 */
export function withinCatalogPage(models: JsonObject[], removable: (row: JsonObject) => boolean, pageSize = CODEX_CATALOG_PAGE_SIZE): { models: JsonObject[]; dropped: string[] } {
  let excess = models.length - pageSize;
  if (excess <= 0) return { models, dropped: [] };
  const drop = new Set<JsonObject>();
  const candidates = models.filter(removable);
  for (const row of candidates) {
    if (excess <= 0) break;
    if (row.visibility !== "list") {
      drop.add(row);
      excess -= 1;
    }
  }
  for (const row of [...candidates].reverse()) {
    if (excess <= 0) break;
    if (!drop.has(row)) {
      drop.add(row);
      excess -= 1;
    }
  }
  return {
    models: models.filter(row => !drop.has(row)),
    dropped: models.filter(row => drop.has(row)).map(row => String(row.slug)),
  };
}
