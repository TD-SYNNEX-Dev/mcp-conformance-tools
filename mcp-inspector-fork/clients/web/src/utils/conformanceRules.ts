/**
 * Conformance rules for the Conformance tab.
 *
 * A TypeScript mirror of the `mcp-check` CLI (Python SDK) rules, so both tools
 * give the same verdict on the same server:
 *
 * - lint: valid JSON Schema, input/output schema roots must be
 *   `type: "object"`, OpenAPI-only keywords (`nullable`, ...) flagged, tool
 *   names checked, required output fields that can't be null listed.
 * - call validation: `structuredContent` vs `outputSchema` per JSON Schema
 *   2020-12, explained in plain language with the JSON path and a fix (see
 *   conformanceExplain.ts, a word-for-word mirror of mcp-check's explain.py).
 *   OpenAPI `nullable` is stripped first: some clients (e.g. the TypeScript
 *   SDK) honor it and accept `message: null`, but JSON Schema ignores it, so
 *   others (e.g. the Python SDK) reject the same result.
 * - null sweep: every null the schema does not allow, at every depth.
 * - auto-cases: minimal args from `inputSchema`; tools whose names or
 *   annotations suggest side effects are never auto-called (only when you
 *   run that one tool yourself and confirm).
 * - the cases file format (YAML/JSON: tool -> list of {args, expect, name}).
 *
 * Pure functions only. No React, no client.
 */
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import { parse as parseYaml } from "yaml";
import { resultView } from "./conformanceDetail";
import {
  STRICT,
  issuesFromAjv,
  js,
  mismatchDetail,
  nullReason,
  nullSweepDetail,
  typeListJson,
  type Issue,
} from "./conformanceExplain";

export type Status = "PASS" | "FAIL" | "WARN" | "NOT EXERCISED" | "SKIPPED";
export const PASS: Status = "PASS";
export const FAIL: Status = "FAIL";
export const WARN: Status = "WARN";
export const NOT_EXERCISED: Status = "NOT EXERCISED";
export const SKIPPED: Status = "SKIPPED";

type Json = unknown;
type Schema = Record<string, unknown>;

export interface ToolLike {
  name: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface Finding {
  schema: "inputSchema" | "outputSchema" | "name";
  severity: "error" | "warn" | "info";
  path: string;
  message: string;
}

export interface Row {
  tool: string;
  check: string;
  status: Status;
  ms?: number;
  detail: string;
  data?: Record<string, unknown>;
}

export interface PathError {
  path: string;
  message: string;
  schemaPath: string;
}

export interface NullField {
  path: string;
  schemaPath: string;
  message: string;
}

// --------------------------------------------------------------------- lint

/** Keywords that exist in OpenAPI 3.0 Schema Objects but not in JSON Schema 2020-12 -> the fix. */
export const OPENAPI_ONLY: Record<string, string> = {
  nullable: 'Fix: use "type": [<type>, "null"] instead.',
  discriminator: "Fix: remove it (it has no effect for MCP clients).",
  xml: "Fix: remove it (it has no effect for MCP clients).",
  externalDocs: "Fix: remove it (it has no effect for MCP clients).",
  example: 'Fix: rename it to "examples" (a list).',
};

/** MCP tool names: 1-128 chars of A-Z a-z 0-9 _ - . */
export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

const MAP_KEYS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
];
const LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const ONE_KEYS = [
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "additionalItems",
];

function isObj(v: unknown): v is Schema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function esc(name: string): string {
  return String(name).replace(/~/g, "~0").replace(/\//g, "~1");
}

function* walk(node: unknown, path: string): Generator<[string, Schema]> {
  if (!isObj(node)) return;
  yield [path, node];
  for (const key of MAP_KEYS) {
    const sub = node[key];
    if (isObj(sub))
      for (const [name, child] of Object.entries(sub))
        yield* walk(child, `${path}/${key}/${esc(name)}`);
  }
  for (const key of LIST_KEYS) {
    const sub = node[key];
    if (Array.isArray(sub))
      for (let i = 0; i < sub.length; i++)
        yield* walk(sub[i], `${path}/${key}/${i}`);
  }
  for (const key of ONE_KEYS) {
    const sub = node[key];
    if (isObj(sub)) yield* walk(sub, `${path}/${key}`);
    else if (key === "items" && Array.isArray(sub))
      for (let i = 0; i < sub.length; i++)
        yield* walk(sub[i], `${path}/${key}/${i}`);
  }
}

/** True if a JSON Schema validator would accept null for this (sub)schema, approximately. */
export function allowsNull(schema: unknown): boolean {
  if (schema === true) return true;
  if (!isObj(schema)) return false;
  if (Object.keys(schema).length === 0) return true;
  if ("const" in schema) return schema.const === null;
  if ("enum" in schema)
    return Array.isArray(schema.enum) && schema.enum.includes(null);
  for (const key of ["anyOf", "oneOf"]) {
    const opts = schema[key];
    if (Array.isArray(opts) && opts.some(allowsNull)) return true;
  }
  const allOf = schema.allOf;
  if (Array.isArray(allOf) && allOf.length && !allOf.every(allowsNull))
    return false;
  const t = schema.type;
  if (t === undefined) return !("$ref" in schema); // $ref => unknown, assume strict
  if (Array.isArray(t)) return t.includes("null");
  return t === "null";
}

function fmt(v: unknown): string {
  return JSON.stringify(v) ?? String(v);
}

function label(kind: Finding["schema"]): string {
  return kind === "outputSchema" ? "output schema" : "input schema";
}

/** Same text as mcp-check's lint.openapi_message. */
export function openApiMessage(kw: string, val: unknown, node: Schema): string {
  if (kw === "nullable" && val === true) {
    const rest = { ...node };
    delete rest.nullable;
    if (allowsNull(rest))
      return "Uses `nullable: true`, an OpenAPI keyword that JSON Schema ignores. Null is already allowed here, so it is harmless. Fix: remove it.";
    const t = node.type;
    const ts = Array.isArray(t)
      ? t.map(String)
      : typeof t === "string"
        ? [t]
        : [];
    const fix = ts.length
      ? `Fix: use "type": ${typeListJson([...ts, "null"])} instead.`
      : 'Fix: use anyOf with {"type": "null"} instead.';
    return (
      "Uses `nullable: true`. That is an OpenAPI keyword, and JSON Schema ignores it, so this field " +
      `still rejects null (its type is ${js(t)}). Some clients (e.g. the TypeScript SDK) accept null ` +
      `here, others (e.g. the Python SDK) reject it. ${fix}`
    );
  }
  if (kw === "nullable")
    return `Uses \`nullable: ${js(val)}\`, an OpenAPI keyword that JSON Schema ignores. Fix: remove it.`;
  if (kw === "example")
    return `Uses \`example\`, an OpenAPI keyword. JSON Schema uses "examples" (a list). ${OPENAPI_ONLY[kw]}`;
  return `Uses \`${kw}\`, an OpenAPI keyword that JSON Schema ignores. ${OPENAPI_ONLY[kw]}`;
}

/** Pick the validator class the way the SDKs do: `$schema` draft-07/06 => draft-07, else 2020-12. */
function makeAjv(schema: Schema): Ajv {
  const s = typeof schema.$schema === "string" ? schema.$schema : "";
  const opts = {
    strict: false,
    allErrors: true,
    verbose: true,
    validateFormats: false,
  } as const;
  return /draft-0[67]/.test(s)
    ? new Ajv(opts)
    : (new Ajv2020(opts) as unknown as Ajv);
}

function withoutDialect(schema: Schema): Schema {
  const s = typeof schema.$schema === "string" ? schema.$schema : "";
  if (!s || /draft-07|draft\/2020-12/.test(s)) return schema;
  // draft-06/04/2019/unknown: validate with the closest class we have, drop the meta URL.
  const copy = { ...schema };
  delete copy.$schema;
  return copy;
}

export function lintSchema(
  kind: Finding["schema"],
  schema: unknown,
): Finding[] {
  const out: Finding[] = [];
  if (schema === undefined || schema === null) return out;
  if (!isObj(schema))
    return [
      {
        schema: kind,
        severity: "error",
        path: "",
        message: `The ${label(kind)} must be a JSON object, but it is ${typeName(schema)}.`,
      },
    ];

  const ajv = makeAjv(schema);
  const target = withoutDialect(schema);
  let metaOk: boolean;
  try {
    metaOk = ajv.validateSchema(target) as boolean;
  } catch (e) {
    metaOk = false;
    ajv.errors = [
      {
        instancePath: "",
        message: e instanceof Error ? e.message : String(e),
      } as ErrorObject,
    ];
  }
  if (!metaOk && ajv.errors?.length) {
    const e = ajv.errors[0];
    out.push({
      schema: kind,
      severity: "error",
      path: e.instancePath || "",
      message: `Not valid JSON Schema (${e.message ?? "invalid"}), so clients can't validate against it. Fix: correct the schema.`,
    });
  }

  if (schema.type !== undefined && schema.type !== "object")
    out.push({
      schema: kind,
      severity: "error",
      path: "/type",
      message:
        kind === "outputSchema"
          ? 'The output schema\'s root must be "type": "object" (MCP requires it, because structuredContent is always a JSON object). Fix: wrap the value in an object, e.g. {"type": "object", "properties": {"items": ...}}.'
          : 'The input schema\'s root must be "type": "object" (MCP requires it). Some clients (e.g. the TypeScript SDK) refuse to load a tool list that breaks this. Fix: set "type": "object".',
    });

  for (const [path, node] of walk(schema, "")) {
    for (const kw of Object.keys(OPENAPI_ONLY)) {
      if (kw in node && !(kw === "xml" && path.endsWith("/properties"))) {
        out.push({
          schema: kind,
          severity: "warn",
          path: `${path}/${kw}`,
          message: openApiMessage(kw, node[kw], node),
        });
      }
    }
    const req = node.required;
    const props = node.properties;
    if (Array.isArray(req) && isObj(props)) {
      for (const name of req) {
        if (typeof name !== "string") continue;
        const sub = props[name];
        if (sub !== undefined && !allowsNull(sub)) {
          const t = isObj(sub) ? sub.type : sub;
          out.push({
            schema: kind,
            severity: "info",
            path: `${path}/properties/${esc(name)}`,
            message: `Required field "${name}" can't be null (type ${js(t)}).`,
          });
        }
      }
    }
  }
  return out;
}

export function lintTool(tool: ToolLike): Finding[] {
  const findings: Finding[] = [];
  if (!TOOL_NAME.test(String(tool.name ?? "")))
    findings.push({
      schema: "name",
      severity: "warn",
      path: "",
      message: `Tool name ${js(String(tool.name ?? ""))} breaks the MCP naming rule (1-128 characters, only A-Z, a-z, 0-9, "_", "-" and "."). Some clients reject or rename such tools. Fix: rename the tool.`,
    });
  if (tool.inputSchema === undefined)
    findings.push({
      schema: "inputSchema",
      severity: "error",
      path: "",
      message:
        'The tool has no input schema (MCP requires one). Fix: add "inputSchema": {"type": "object"}.',
    });
  else findings.push(...lintSchema("inputSchema", tool.inputSchema));
  findings.push(...lintSchema("outputSchema", tool.outputSchema));
  return findings;
}

/** The lint row for a tool: same status rules and detail layout as mcp-check. */
export function lintRow(tool: ToolLike, strict = false): Row {
  const findings = lintTool(tool);
  const errs = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity === "warn");
  const status: Status =
    errs.length || (warns.length && strict) ? FAIL : warns.length ? WARN : PASS;
  return {
    tool: tool.name,
    check: "lint",
    status,
    detail: lintDetail(tool, findings),
    data: { findings },
  };
}

/** The lint row's detail text (same layout as mcp-check's lint.lint_detail). */
export function lintDetail(tool: ToolLike, findings: Finding[]): string {
  const bits: string[] = [];
  const shown = [
    ...findings.filter((f) => f.severity === "error"),
    ...findings.filter((f) => f.severity === "warn"),
  ];
  for (const f of shown) {
    if (f.schema === "name") {
      bits.push(f.message);
      continue;
    }
    const where =
      f.severity === "warn" ? f.path.slice(0, f.path.lastIndexOf("/")) : f.path;
    bits.push(`${f.schema} at ${where || "/"}: ${f.message}`);
  }
  const req = findings
    .filter((f) => f.severity === "info" && f.schema === "outputSchema")
    .map((f) =>
      (f.path.split("/").pop() ?? "").replace(/~1/g, "/").replace(/~0/g, "~"),
    );
  if (req.length)
    bits.push(`Required output fields that can't be null: ${req.join(", ")}.`);
  if (!tool.outputSchema)
    bits.push(
      "No output schema, so clients can't validate this tool's results.",
    );
  return bits.join(" | ") || "OK: the schemas are valid.";
}

// --------------------------------------------------------------------- validation

/** Deep copy without OpenAPI `nullable` (keyword-aware: a property NAMED nullable is kept). */
export function stripOpenApiNullable(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripOpenApiNullable);
  if (!isObj(schema)) return schema;
  const out: Schema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "nullable" && typeof v === "boolean") continue;
    if (MAP_KEYS.includes(k) && isObj(v)) {
      out[k] = Object.fromEntries(
        Object.entries(v).map(([n, c]) => [n, stripOpenApiNullable(c)]),
      );
    } else if (LIST_KEYS.includes(k) || ONE_KEYS.includes(k)) {
      out[k] = stripOpenApiNullable(v);
    } else out[k] = v;
  }
  return out;
}

export function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function errorText(e: ErrorObject): string {
  if (e.keyword === "type")
    return `must be ${fmt(e.params.type).replace(/"/g, "")}, got ${typeName(e.data)}`;
  if (e.keyword === "required")
    return `must have required property '${String(e.params.missingProperty)}'`;
  return e.message ?? e.keyword;
}

/**
 * Every JSON Schema 2020-12 error for `instance`, with a JSON pointer into the
 * instance. OpenAPI `nullable` is ignored, exactly like Python's jsonschema.
 */
export function schemaErrors(schema: unknown, instance: Json): PathError[] {
  if (!isObj(schema)) return [];
  const strict = withoutDialect(stripOpenApiNullable(schema) as Schema);
  const ajv = makeAjv(strict);
  let validate;
  try {
    validate = ajv.compile(strict);
  } catch (e) {
    return [
      {
        path: "/",
        message: `outputSchema does not compile: ${e instanceof Error ? e.message : String(e)}`,
        schemaPath: "/",
      },
    ];
  }
  if (validate(instance)) return [];
  const errs = (validate.errors ?? []).map((e) => {
    const base = e.instancePath || "";
    const path =
      e.keyword === "required"
        ? `${base}/${esc(String(e.params.missingProperty))}`
        : base || "/";
    return {
      path,
      message: errorText(e),
      schemaPath: e.schemaPath.replace(/^#/, "") || "/",
    };
  });
  const seen = new Set<string>();
  return errs
    .filter((e) => {
      const k = `${e.path}|${e.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) =>
      a.path === b.path
        ? a.message.localeCompare(b.message)
        : a.path.localeCompare(b.path),
    );
}

/**
 * Every problem in `instance` against `schema`, as plain-language issues
 * (see conformanceExplain.ts). `undefined`/`null` instance = no structuredContent.
 */
export function schemaIssues(schema: unknown, instance: Json): Issue[] {
  if (instance === undefined || instance === null)
    return [{ kind: "missing_structured", path: "/" }];
  if (!isObj(schema)) return [];
  const strict = withoutDialect(stripOpenApiNullable(schema) as Schema);
  const ajv = makeAjv(strict);
  let validate;
  try {
    validate = ajv.compile(strict);
  } catch (e) {
    return [
      {
        kind: "other",
        path: "/",
        keyword: "schema",
        message: `the output schema does not compile: ${e instanceof Error ? e.message : String(e)}`,
      },
    ];
  }
  if (validate(instance)) return [];
  return issuesFromAjv(validate.errors ?? [], schema);
}

export function formatPathErrors(errs: PathError[], max = 5): string {
  return errs
    .slice(0, max)
    .map((e) => `${e.path}: ${e.message}`)
    .join("; ");
}

// --------------------------------------------------------------------- null sweep

const UNKNOWN = Symbol("unknown");

function resolveRef(schema: unknown, root: unknown): unknown {
  let seen = 0;
  let cur = schema;
  while (isObj(cur) && typeof cur.$ref === "string") {
    const ref = cur.$ref;
    seen++;
    if (!ref.startsWith("#") || seen > 20) return UNKNOWN;
    let node: unknown = root;
    for (const raw of ref.slice(1).split("/").filter(Boolean)) {
      const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isObj(node) || !(part in node)) return UNKNOWN;
      node = node[part];
    }
    cur = node;
  }
  return cur;
}

function containerType(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (isObj(v)) return "object";
  return "other";
}

function branchesFor(schema: Schema, inst: unknown, root: unknown): unknown[] {
  const out: unknown[] = Array.isArray(schema.allOf) ? [...schema.allOf] : [];
  for (const key of ["anyOf", "oneOf"]) {
    const opts = schema[key];
    if (!Array.isArray(opts)) continue;
    for (const opt of opts) {
      const r = resolveRef(opt, root);
      if (!isObj(r)) continue;
      const ts = Array.isArray(r.type) ? r.type : r.type ? [r.type] : [];
      if (
        ts.includes(containerType(inst)) ||
        (!ts.length && ("properties" in r || "items" in r))
      ) {
        out.push(r);
        break;
      }
    }
  }
  return out;
}

/** Every field that is null where the schema does not allow null (the common `message: null` vs `type: string` bug). */
export function nullSweep(schema: unknown, instance: Json): NullField[] {
  const found: NullField[] = [];
  const visit = (
    subIn: unknown,
    inst: unknown,
    ptr: string,
    sptr: string,
    depth: number,
  ): void => {
    if (depth > 40) return;
    const sub = resolveRef(subIn, schema);
    if (sub === UNKNOWN || !isObj(sub)) return;
    if (inst === null) {
      if (!allowsNull(sub)) {
        found.push({
          path: ptr || "/",
          schemaPath: sptr || "/",
          message: nullReason(sub),
        });
      }
      return;
    }
    branchesFor(sub, inst, schema).forEach((b, i) =>
      visit(b, inst, ptr, `${sptr}/branch${i}`, depth + 1),
    );
    if (isObj(inst)) {
      const props = isObj(sub.properties) ? sub.properties : {};
      const addl = sub.additionalProperties;
      for (const [k, v] of Object.entries(inst)) {
        if (k in props)
          visit(
            props[k],
            v,
            `${ptr}/${esc(k)}`,
            `${sptr}/properties/${esc(k)}`,
            depth + 1,
          );
        else if (isObj(addl))
          visit(
            addl,
            v,
            `${ptr}/${esc(k)}`,
            `${sptr}/additionalProperties`,
            depth + 1,
          );
      }
    } else if (Array.isArray(inst)) {
      const prefix = Array.isArray(sub.prefixItems) ? sub.prefixItems : [];
      const items = sub.items;
      inst.slice(0, 500).forEach((v, i) => {
        if (i < prefix.length)
          visit(
            prefix[i],
            v,
            `${ptr}/${i}`,
            `${sptr}/prefixItems/${i}`,
            depth + 1,
          );
        else if (isObj(items))
          visit(items, v, `${ptr}/${i}`, `${sptr}/items`, depth + 1);
      });
    }
  };
  visit(schema, instance, "", "", 0);
  const uniq = new Map<string, NullField>();
  for (const f of found) if (!uniq.has(f.path)) uniq.set(f.path, f);
  return [...uniq.values()];
}

// --------------------------------------------------------------------- cases file

export interface TestCase {
  tool: string;
  args: Record<string, unknown>;
  /** success | error | any (any = auto-case: only a schema mismatch FAILs) */
  expect: "success" | "error" | "any";
  name?: string;
}

export class CasesError extends Error {}

/** Same format and the same errors as mcp-check's `load_cases`. */
export function parseCases(
  text: string,
  filename = "cases.yaml",
): Record<string, TestCase[]> {
  let data: unknown;
  try {
    data = filename.toLowerCase().endsWith(".json")
      ? JSON.parse(text)
      : parseYaml(text);
  } catch (e) {
    throw new CasesError(
      `${filename}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (data === null || data === undefined) return {};
  if (!isObj(data))
    throw new CasesError(
      `${filename}: top level must be a mapping of tool name -> list of cases`,
    );
  const out: Record<string, TestCase[]> = {};
  for (const [tool, raw] of Object.entries(data)) {
    let entries: unknown = raw;
    if (entries === null) entries = [{}];
    if (isObj(entries)) entries = [entries];
    if (!Array.isArray(entries))
      throw new CasesError(`${filename}: ${tool}: expected a list of cases`);
    out[tool] = entries.map((e0, i) => {
      const e = e0 === null ? {} : e0;
      if (!isObj(e))
        throw new CasesError(
          `${filename}: ${tool}[${i}]: each case must be a mapping with \`args\``,
        );
      const unknown = Object.keys(e)
        .filter((k) => !["args", "expect", "name"].includes(k))
        .sort();
      if (unknown.length)
        throw new CasesError(
          `${filename}: ${tool}[${i}]: unknown keys ${JSON.stringify(unknown)} (put tool arguments under \`args\`)`,
        );
      const args = e.args ?? {};
      if (!isObj(args))
        throw new CasesError(
          `${filename}: ${tool}[${i}]: \`args\` must be a mapping`,
        );
      const expect = String(e.expect ?? "success").toLowerCase();
      if (expect !== "success" && expect !== "error")
        throw new CasesError(
          `${filename}: ${tool}[${i}]: expect must be success or error`,
        );
      return {
        tool,
        args,
        expect,
        name: typeof e.name === "string" ? e.name : undefined,
      };
    });
  }
  return out;
}

// --------------------------------------------------------------------- auto-cases

/** Tools whose name contains any of these are never auto-called (substring, case-insensitive). */
export const DEFAULT_DENY = [
  "submit",
  "create",
  "update",
  "delete",
  "place",
  "order",
  "send",
  "cancel",
  "write",
  "post",
] as const;

function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

export function matchesGlob(name: string, pattern: string): boolean {
  return globToRegExp(pattern).test(name);
}

export function denied(name: string, extra: string[] = []): string | null {
  const low = name.toLowerCase();
  for (const w of DEFAULT_DENY) if (low.includes(w)) return w;
  for (const p of extra) {
    const pl = p.toLowerCase();
    if (matchesGlob(low, pl) || (!/[*?[]/.test(p) && low.includes(pl)))
      return p;
  }
  return null;
}

/** Why this tool looks like it changes something (so it is never called without asking), or null. */
export function sideEffectReason(
  tool: ToolLike,
  deny: string[] = [],
): string | null {
  const hit = denied(tool.name, deny);
  if (hit) return `its name suggests side effects (contains '${hit}')`;
  if (tool.annotations?.destructiveHint === true)
    return "the server marks it destructive (destructiveHint: true)";
  if (tool.annotations?.readOnlyHint === false)
    return "the server marks it as not read-only (readOnlyHint: false)";
  return null;
}

/** null if the tool may be auto-called, else the plain-language reason. Side effects always win over allow. */
export function autoEligibility(
  tool: ToolLike,
  allow: string[] = [],
  deny: string[] = [],
): string | null {
  const why = sideEffectReason(tool, deny);
  if (why) return why;
  if (allow.length && !allow.some((p) => matchesGlob(tool.name, p)))
    return "it is not in the auto-allow list";
  return null;
}

/** NOT EXERCISED detail for a tool auto-cases skipped (same text as mcp-check). */
export function notCalledDetail(reason: string): string {
  return `Not called: there is no case for it, and auto-cases skips it because ${reason}. Add a case, or run this tool on its own.`;
}

export const NO_CASE_DETAIL =
  "Not called: there is no case for it. Turn on auto-cases, or run this tool on its own.";

export class AutoCaseError extends Error {}

const FORMATS: Record<string, string> = {
  date: "2026-01-01",
  "date-time": "2026-01-01T00:00:00Z",
  time: "00:00:00Z",
  email: "test@example.com",
  uri: "https://example.com",
  url: "https://example.com",
  uuid: "00000000-0000-4000-8000-000000000000",
};

function resolveStrict(schema: unknown, root: unknown): unknown {
  let cur = schema;
  for (let d = 0; isObj(cur) && typeof cur.$ref === "string" && d < 20; d++) {
    const ref = cur.$ref;
    if (!ref.startsWith("#"))
      throw new AutoCaseError(`remote $ref '${ref}' not supported`);
    let node: unknown = root;
    for (const raw of ref.slice(1).split("/").filter(Boolean)) {
      const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isObj(node) || !(part in node))
        throw new AutoCaseError(`unresolvable $ref '${ref}'`);
      node = node[part];
    }
    cur = node;
  }
  return cur;
}

function valueFor(schemaIn: unknown, root: unknown, depth = 0): unknown {
  if (depth > 12) throw new AutoCaseError("schema nests too deeply");
  const schema = resolveStrict(schemaIn, root);
  if (schema === true || schema === undefined || schema === null) return null;
  if (!isObj(schema)) throw new AutoCaseError("unsupported schema");
  if (Object.keys(schema).length === 0) return null;
  if ("const" in schema) return schema.const;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.examples) && schema.examples.length)
    return schema.examples[0];
  for (const key of ["anyOf", "oneOf"]) {
    const opts = schema[key];
    if (Array.isArray(opts) && opts.length) {
      const nonNull = opts.filter((o) => !(isObj(o) && o.type === "null"));
      return valueFor((nonNull.length ? nonNull : opts)[0], root, depth + 1);
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const merged: Schema = { ...schema };
    delete merged.allOf;
    for (const p0 of schema.allOf) {
      const part = resolveStrict(p0, root);
      if (!isObj(part)) continue;
      for (const [k, v] of Object.entries(part)) {
        if (k === "properties")
          merged.properties = {
            ...(merged.properties as Schema),
            ...(v as Schema),
          };
        else if (k === "required")
          merged.required = [
            ...new Set([
              ...((merged.required as string[]) ?? []),
              ...(v as string[]),
            ]),
          ];
        else if (!(k in merged)) merged[k] = v;
      }
    }
    return valueFor(merged, root, depth + 1);
  }
  let t = schema.type as unknown;
  if (Array.isArray(t)) t = t.find((x) => x !== "null") ?? "null";
  if (t === undefined && "properties" in schema) t = "object";
  switch (t) {
    case "object": {
      const props = isObj(schema.properties) ? schema.properties : {};
      const out: Record<string, unknown> = {};
      for (const name of (schema.required as string[]) ?? [])
        out[name] =
          name in props ? valueFor(props[name], root, depth + 1) : "test";
      return out;
    }
    case "array": {
      const n = Number(schema.minItems ?? 0);
      return Array.from({ length: n }, () =>
        valueFor(schema.items ?? {}, root, depth + 1),
      );
    }
    case "string": {
      const f = schema.format;
      if (typeof f === "string" && f in FORMATS) return FORMATS[f];
      const n = Number(schema.minLength ?? 0);
      const s = "test".repeat(Math.floor(n / 4) + 1).slice(0, Math.max(n, 4));
      return s.slice(0, Number(schema.maxLength ?? 1e6));
    }
    case "integer":
    case "number": {
      let lo = schema.minimum as number | undefined;
      if (lo === undefined && typeof schema.exclusiveMinimum === "number")
        lo = schema.exclusiveMinimum + 1;
      let v = lo ?? 1;
      const hi = schema.maximum as number | undefined;
      if (hi !== undefined && v > hi) v = hi;
      return t === "integer" ? Math.trunc(v) : v;
    }
    case "boolean":
      return false;
    default:
      return null;
  }
}

/** Required properties only, smallest plausible values; throws if the result would not validate. */
/** Pretty JSON of the smallest valid args for a tool (the single-tool editor's starting point), or "{}". */
export function generatedArgsText(tool: ToolLike): string {
  try {
    return JSON.stringify(minimalArgs(tool.inputSchema), null, 2);
  } catch {
    return "{}";
  }
}

export function minimalArgs(inputSchema: unknown): Record<string, unknown> {
  if (!isObj(inputSchema))
    throw new AutoCaseError("inputSchema is not an object");
  let args = valueFor(inputSchema, inputSchema);
  if (args === null) args = {};
  if (!isObj(args))
    throw new AutoCaseError("inputSchema does not describe an object");
  const errs = schemaErrors(inputSchema, args);
  if (errs.length)
    throw new AutoCaseError(
      `the generated args do not validate at ${errs[0].path}: ${errs[0].message}`,
    );
  return args;
}

export function autoCase(
  tool: ToolLike,
  allow: string[] = [],
  deny: string[] = [],
): { testCase: TestCase | null; reason: string } {
  const reason = autoEligibility(tool, allow, deny);
  if (reason) return { testCase: null, reason };
  try {
    const args = minimalArgs(tool.inputSchema ?? { type: "object" });
    return {
      testCase: { tool: tool.name, args, expect: "any", name: "auto" },
      reason: "",
    };
  } catch (e) {
    return {
      testCase: null,
      reason: `it could not build valid args (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

// --------------------------------------------------------------------- call evaluation

export interface CallResultLike {
  structuredContent?: unknown;
  isError?: boolean;
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

/** What one tools/call produced. `sdkError` is the TypeScript SDK's own output-validation verdict. */
export type CallOutcome =
  | { kind: "result"; result: CallResultLike; sdkError?: string; ms?: number }
  | { kind: "error"; message: string; ms?: number };

export function callLabel(testCase: TestCase, index: number): string {
  if (testCase.expect === "any") return "call[auto]";
  if (testCase.name === "args") return "call[args]";
  return `call[${index}]` + (testCase.name ? ` ${testCase.name}` : "");
}

/**
 * Verdict for one call, plus a `null-sweep` row when disallowed nulls were
 * found. Mirrors mcp-check's runner._call; the strict JSON Schema 2020-12
 * verdict (what Python-SDK clients enforce) is the one that FAILs.
 */
export function evaluateCall(
  tool: ToolLike,
  testCase: TestCase,
  label: string,
  outcome: CallOutcome,
): Row[] {
  const schema = tool.outputSchema;
  const data: Record<string, unknown> = {
    args: testCase.args,
    expect: testCase.expect,
    output_schema: schema ?? null,
  };
  const row = (status: Status, detail: string): Row => ({
    tool: tool.name,
    check: label,
    status,
    ms: outcome.ms,
    detail,
    data,
  });
  const auto = testCase.expect === "any";
  const autoArgs = `the auto-generated args ${js(testCase.args, 200)}`;
  const unrealistic =
    "The made-up args may just be unrealistic; add a real case, or run this tool on its own with your own args.";
  if (outcome.kind === "error") {
    data.error = outcome.message;
    if (auto)
      return [
        row(
          WARN,
          `The call failed for ${autoArgs}: ${outcome.message.slice(0, 300)}. ${unrealistic}`,
        ),
      ];
    if (testCase.expect === "error")
      return [
        row(PASS, `The call failed, as this case expects: ${outcome.message}`),
      ];
    return [row(FAIL, `The call failed: ${outcome.message}`)];
  }

  const r = outcome.result;
  const structured = r.structuredContent;
  const isError = r.isError === true;
  const texts = (r.content ?? [])
    .slice(0, 3)
    .map((c) => (c.type === "text" ? (c.text ?? null) : null));
  data.structured_content = structured;
  data.is_error = isError;
  data.content_text = texts;
  data.sdk_error = outcome.sdkError;
  data.result = resultView(r);

  const rows: Row[] = [];
  let issues: Issue[] = [];
  let nulls: NullField[] = [];
  let sweepSource = "structuredContent";
  if (isObj(schema) && !isError) {
    data.schema_errors =
      structured === undefined || structured === null
        ? []
        : schemaErrors(schema, structured);
    issues = schemaIssues(schema, structured);
    data.issues = issues;
    let target: unknown = structured ?? undefined;
    if (target === undefined) {
      for (const t of texts) {
        try {
          const parsed: unknown = t ? JSON.parse(t) : undefined;
          if (isObj(parsed)) {
            target = parsed;
            sweepSource = "text";
            break;
          }
        } catch {
          /* not JSON */
        }
      }
    }
    if (target !== undefined) {
      nulls = nullSweep(schema, target);
      if (nulls.length) {
        data.null_fields = nulls;
        data.null_sweep_source = sweepSource;
      }
    }
  }
  if (nulls.length) {
    rows.push({
      tool: tool.name,
      check: "null-sweep",
      status: FAIL,
      detail: nullSweepDetail(nulls, sweepSource === "text"),
      data: { null_fields: nulls, null_sweep_source: sweepSource },
    });
  }

  let main: Row;
  if (isError) {
    const msg = texts.filter(Boolean).join("; ");
    const errTxt = msg
      ? ` Error text: "${msg.slice(0, 300)}".`
      : " The error result has no text in content, so clients can't show what went wrong.";
    main =
      testCase.expect === "error"
        ? row(
            PASS,
            "The tool reported an error, as this case expects." + errTxt,
          )
        : auto
          ? row(
              WARN,
              `The tool reported an error for ${autoArgs}.${errTxt} ${unrealistic}`,
            )
          : row(
              FAIL,
              "The tool reported an error (isError: true)." +
                errTxt +
                " Fix: check the args (or, in a cases file, set expect: error if this case is meant to fail).",
            );
  } else if (testCase.expect === "error") {
    main = row(
      FAIL,
      "This case expects an error, but the call succeeded. Fix: check the args, or change the case to expect: success.",
    );
  } else if (issues.length) {
    main = row(FAIL, mismatchDetail(issues));
  } else if (outcome.sdkError) {
    main = row(
      FAIL,
      `${STRICT} The TypeScript SDK rejected it: ${outcome.sdkError}`,
    );
  } else if (nulls.length) {
    main = row(
      WARN,
      "Validation passed, but the null check found null fields the output schema does not allow (see the null-sweep row).",
    );
  } else {
    const a = auto ? ` (auto-generated args: ${js(testCase.args, 200)})` : "";
    main = isObj(schema)
      ? row(PASS, `OK: structuredContent matches the output schema.${a}`)
      : row(
          PASS,
          `OK: the call succeeded. The tool has no output schema, so there is nothing to validate.${a}`,
        );
  }
  return [main, ...rows];
}

// --------------------------------------------------------------------- coverage + export

export interface Coverage {
  tools: number;
  exercised: number;
  not_exercised: string[];
}

export function coverage(toolNames: string[], rows: Row[]): Coverage {
  const hit = new Set(
    rows
      .filter(
        (r) =>
          r.check.startsWith("call") &&
          r.status !== NOT_EXERCISED &&
          r.status !== SKIPPED,
      )
      .map((r) => r.tool),
  );
  const missing = toolNames.filter((n) => !hit.has(n));
  return {
    tools: toolNames.length,
    exercised: toolNames.length - missing.length,
    not_exercised: missing,
  };
}

export function coverageLine(cov: Coverage, maxNames = 40): string {
  const miss = cov.not_exercised;
  const names =
    miss.slice(0, maxNames).join(", ") +
    (miss.length > maxNames ? `, ... +${miss.length - maxNames} more` : "");
  return (
    `coverage: ${cov.tools} tool${cov.tools === 1 ? "" : "s"}, ${cov.exercised} exercised, ${miss.length} not exercised` +
    (miss.length ? ` (${names})` : "")
  );
}

export function summaryLine(toolCount: number, rows: Row[]): string {
  const count = (pred: (r: Row) => boolean, s: Status) =>
    rows.filter((r) => pred(r) && r.status === s).length;
  const isCall = (r: Row) => r.check.startsWith("call");
  const isLint = (r: Row) => r.check === "lint";
  const sweeps = rows.filter((r) => r.check === "null-sweep");
  const nullCount = sweeps.reduce(
    (n, r) => n + ((r.data?.null_fields as unknown[]) ?? []).length,
    0,
  );
  return (
    `tools: ${toolCount}` +
    ` | lint: ${count(isLint, PASS)} pass, ${count(isLint, WARN)} warn, ${count(isLint, FAIL)} fail` +
    ` | calls: ${count(isCall, PASS)} pass, ${count(isCall, FAIL)} fail, ${count(isCall, WARN)} warn, ${count(isCall, NOT_EXERCISED)} not exercised` +
    (count(isCall, SKIPPED) ? `, ${count(isCall, SKIPPED)} skipped` : "") +
    (sweeps.length
      ? ` | null sweep: ${nullCount} disallowed null field(s) in ${sweeps.length} call(s)`
      : "")
  );
}

export function buildExport(input: {
  server?: { name?: string; version?: string };
  tools: ToolLike[];
  rows: Row[];
  casesFile?: string;
  autoCases?: boolean;
}): Record<string, unknown> {
  const names = input.tools.map((t) => t.name);
  return {
    tool: "mcp-inspector conformance (mirrors mcp-check)",
    generated_at: new Date().toISOString(),
    server_info: input.server ?? null,
    tool_count: names.length,
    cases_file: input.casesFile ?? null,
    auto_cases: Boolean(input.autoCases),
    result: input.rows.some((r) => r.status === FAIL) ? "FAIL" : "PASS",
    coverage: coverage(names, input.rows),
    rows: input.rows,
    tools: input.tools,
  };
}
