/**
 * Plain-language explanations for schema problems found in a tool result.
 *
 * Every message says what the schema expected, what came back, where (JSON
 * path), and how to fix it. This is a word-for-word mirror of mcp-check's
 * `mcp_check/explain.py`, so the Conformance tab and the CLI read the same.
 *
 * An issue is `{ kind, path }` plus kind-specific fields (see `Issue`).
 */
import type { ErrorObject } from "ajv";

export const STRICT =
  "Strict clients (like the Python SDK) will reject this response.";
export const MIXED =
  "Some clients (e.g. the TypeScript SDK) accept this, others (e.g. the Python SDK) reject it.";
export const NULLABLE_IGNORED =
  "Its `nullable: true` does not help: that is an OpenAPI keyword, and JSON Schema ignores it.";
export const MISSING_SC =
  "The tool declares an output schema, but the response has no structuredContent.";
export const MISSING_SC_FIX =
  "Fix: return the result in structuredContent as a JSON object that matches the output schema (you can keep a text copy in content).";
export const MAX_ISSUES = 5;

export type Issue =
  | { kind: "null"; path: string; expected: string[]; nullable: boolean }
  | { kind: "type"; path: string; expected: string[]; actual: unknown }
  | { kind: "required"; path: string; name: string }
  | { kind: "extra"; path: string; name: string }
  | { kind: "enum"; path: string; allowed: unknown[]; actual: unknown }
  | { kind: "const"; path: string; allowed: unknown; actual: unknown }
  | { kind: "missing_structured"; path: string }
  | { kind: "other"; path: string; keyword: string; message: string };

const ARTICLE: Record<string, string> = {
  string: "a string",
  integer: "an integer",
  number: "a number",
  boolean: "a boolean",
  object: "an object",
  array: "an array",
  null: "null",
};

/** Compact JSON (same as Python's json.dumps with no spaces), cut at `limit` chars. */
export function js(v: unknown, limit = 60): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length <= limit ? s : s.slice(0, limit - 1) + "…";
}

export function jsonKind(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  return "object";
}

export function typesPhrase(types: string[]): string {
  return types.map((t) => ARTICLE[t] ?? `"${t}"`).join(" or ") || "a value";
}

/** ["string", "null"] - with a space after the comma, as people write it. */
export function typeListJson(types: string[]): string {
  return "[" + types.map((t) => `"${t}"`).join(", ") + "]";
}

function valuePhrase(v: unknown): string {
  const k = jsonKind(v);
  if (k === "null") return "null";
  if (k === "array" || k === "object") return ARTICLE[k];
  return `${ARTICLE[k]} (${js(v)})`;
}

function field(path: string): string {
  return path === "" || path === "/"
    ? "The structuredContent"
    : `Field ${path}`;
}

/** [problem sentence, "Fix: ..." sentence]. */
export function describe(i: Issue): [string, string] {
  const f = field(i.path);
  switch (i.kind) {
    case "missing_structured":
      return [MISSING_SC, MISSING_SC_FIX];
    case "null": {
      let p = `${f} is null, but the output schema says it must be ${typesPhrase(i.expected)}.`;
      if (i.nullable) p += " " + NULLABLE_IGNORED;
      return [
        p,
        `Fix: return ${typesPhrase(i.expected)}, or allow null with "type": ${typeListJson([...i.expected, "null"])}.`,
      ];
    }
    case "type":
      return [
        `${f} is ${valuePhrase(i.actual)}, but the output schema says it must be ${typesPhrase(i.expected)}.`,
        `Fix: return ${typesPhrase(i.expected)}, or change the schema to "type": "${jsonKind(i.actual)}".`,
      ];
    case "required":
      return [
        `Required field ${i.path} is missing.`,
        `Fix: always include "${i.name}", or remove it from "required" in the output schema.`,
      ];
    case "extra":
      return [
        `Field ${i.path} is not in the output schema, which does not allow extra fields ("additionalProperties": false).`,
        `Fix: stop sending "${i.name}", or add it to "properties" in the output schema.`,
      ];
    case "enum": {
      const allowed = i.allowed
        .slice(0, 10)
        .map((a) => js(a))
        .join(", ");
      return [
        `${f} is ${js(i.actual)}, which is not one of the allowed values (${allowed}).`,
        `Fix: return one of the allowed values, or add ${js(i.actual)} to the enum in the output schema.`,
      ];
    }
    case "const":
      return [
        `${f} is ${js(i.actual)}, but the output schema requires exactly ${js(i.allowed)}.`,
        "Fix: return that exact value, or change the schema.",
      ];
    default:
      return [
        `${f} does not match the output schema (${i.keyword}: ${i.message}).`,
        "Fix: change the response or the output schema so they agree.",
      ];
  }
}

/** Only the ignored-`nullable` case splits clients; everything else is rejected by strict clients. */
export function clientSentence(issues: Issue[]): string {
  return issues.length && issues.every((i) => i.kind === "null" && i.nullable)
    ? MIXED
    : STRICT;
}

export function mismatchDetail(issues: Issue[]): string {
  const client = clientSentence(issues);
  if (issues.length === 1) {
    const [p, fix] = describe(issues[0]);
    return `${p} ${client} ${fix}`;
  }
  const parts = issues
    .slice(0, MAX_ISSUES)
    .map((i, n) => `(${n + 1}) ${describe(i).join(" ")}`);
  const more =
    issues.length > MAX_ISSUES ? ` (+${issues.length - MAX_ISSUES} more)` : "";
  return (
    `${issues.length} problems with this response. ${client} ` +
    parts.join(" ") +
    more
  );
}

/** Short reason for the null check: 'must be a string' (+ ignored nullable note). */
export function nullReason(sub: Record<string, unknown>): string {
  const t = sub.type;
  const ts = Array.isArray(t)
    ? t.map(String)
    : typeof t === "string"
      ? [t]
      : [];
  let msg = ts.length ? `must be ${typesPhrase(ts)}` : "must not be null";
  if (sub.nullable === true)
    msg +=
      "; its `nullable: true` is an OpenAPI keyword that JSON Schema ignores";
  return msg;
}

export function nullSweepDetail(
  nulls: Array<{ path: string; message: string }>,
  fromText: boolean,
): string {
  const n = nulls.length;
  const src = fromText
    ? " (checked the JSON in the text content, because there is no structuredContent)"
    : "";
  const listed =
    nulls
      .slice(0, 8)
      .map((x) => `${x.path} (${x.message})`)
      .join("; ") + (n > 8 ? `; +${n - 8} more` : "");
  return (
    `Null check: ${n} field${n !== 1 ? "s" : ""} ${n !== 1 ? "are" : "is"} null where the output ` +
    `schema does not allow null${src}: ${listed}. ` +
    'Fix: send a real value, or allow null in the schema (e.g. "type": ["string", "null"]).'
  );
}

// --------------------------------------------------------------------- Ajv -> issues

function esc(name: string): string {
  return String(name).replace(/~/g, "~0").replace(/\//g, "~1");
}

function join(base: string, name: string): string {
  return (base === "/" ? "" : base.replace(/\/$/, "")) + "/" + esc(name);
}

/** The schema node a `#/a/b/keyword` schemaPath points into (the node holding `keyword`). */
function nodeAt(root: unknown, schemaPath: string): Record<string, unknown> {
  const parts = schemaPath.replace(/^#/, "").split("/").filter(Boolean);
  parts.pop();
  let node: unknown = root;
  for (const raw of parts) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof node !== "object" || node === null) return {};
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "object" && node !== null && !Array.isArray(node)
    ? (node as Record<string, unknown>)
    : {};
}

/**
 * Map Ajv errors (allErrors, compiled from the nullable-stripped schema) to
 * issues. `original` is the schema as the server sent it, used to tell whether
 * a field carried OpenAPI `nullable: true`. Errors inside anyOf/oneOf branches
 * are dropped (the anyOf/oneOf error itself is kept), like Python's jsonschema.
 */
export function issuesFromAjv(
  errors: ErrorObject[],
  original: unknown,
): Issue[] {
  const out: Issue[] = [];
  for (const e of errors) {
    if (/\/(anyOf|oneOf)\/\d+\//.test(e.schemaPath)) continue;
    const path = e.instancePath || "/";
    const p = e.params as Record<string, unknown>;
    switch (e.keyword) {
      case "type": {
        const t = p.type;
        const expected = Array.isArray(t)
          ? t.map(String)
          : String(t).split(",");
        if (e.data === null)
          out.push({
            kind: "null",
            path,
            expected,
            nullable: nodeAt(original, e.schemaPath).nullable === true,
          });
        else out.push({ kind: "type", path, expected, actual: e.data });
        break;
      }
      case "required": {
        const name = String(p.missingProperty);
        out.push({ kind: "required", path: join(path, name), name });
        break;
      }
      case "additionalProperties": {
        if (e.schema === false) {
          const name = String(p.additionalProperty);
          out.push({ kind: "extra", path: join(path, name), name });
        } else
          out.push({
            kind: "other",
            path,
            keyword: e.keyword,
            message: e.message ?? e.keyword,
          });
        break;
      }
      case "enum":
        out.push({
          kind: "enum",
          path,
          allowed: (p.allowedValues as unknown[]) ?? [],
          actual: e.data,
        });
        break;
      case "const":
        out.push({
          kind: "const",
          path,
          allowed: p.allowedValue,
          actual: e.data,
        });
        break;
      default:
        out.push({
          kind: "other",
          path,
          keyword: e.keyword,
          message: e.message ?? e.keyword,
        });
    }
  }
  const seen = new Set<string>();
  return out
    .sort((a, b) =>
      a.path === b.path
        ? a.kind < b.kind
          ? -1
          : a.kind > b.kind
            ? 1
            : 0
        : a.path < b.path
          ? -1
          : 1,
    )
    .filter((i) => {
      const k = `${i.path}|${i.kind}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}
