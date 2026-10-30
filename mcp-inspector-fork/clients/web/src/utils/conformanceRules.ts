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
 *   run that one tool yourself and confirm). Values come from the schema
 *   (const/default/enum/examples, format, pattern), else from description or
 *   name hints (marked as guessed); a required value that would only be the
 *   "test" placeholder skips the tool.
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
    if (kind === "inputSchema") out.push(...hintFindings(kind, path, node));
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

function isStringNode(node: Schema): boolean {
  const t = node.type;
  return t === "string" || (Array.isArray(t) && t.includes("string"));
}

/** Description-only constraints: allowed values or a date format the schema doesn't state. */
function hintFindings(
  kind: Finding["schema"],
  path: string,
  node: Schema,
): Finding[] {
  const desc = node.description;
  if (
    typeof desc !== "string" ||
    !isStringNode(node) ||
    "enum" in node ||
    "const" in node
  )
    return [];
  const vals = enumHint(desc);
  if (vals) {
    const listed = vals.map((v) => JSON.stringify(v)).join(", ");
    return [
      {
        schema: kind,
        severity: "warn",
        path: `${path}/description`,
        message: `The description lists allowed values (${listed}), but the schema has no "enum", so clients and test tools can't see them. Fix: add "enum": [${listed}].`,
      },
    ];
  }
  if ("format" in node || "pattern" in node) return [];
  const dh = dateFormatHint(desc);
  let what: string;
  let fmt = "";
  if (dh) {
    what = dh[0];
    fmt = ` (${dh[1]}${dh[2]})`;
  } else if (datetimeHint(desc)) what = "date-time";
  else return [];
  return [
    {
      schema: kind,
      severity: "warn",
      path: `${path}/description`,
      message: `The description asks for a ${what}${fmt}, but the schema has no "format" or "pattern", so clients and test tools can't see it. Fix: add "format": "${what}" (or a "pattern").`,
    },
  ];
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
  /** auto-cases: values guessed from a description or name (shown in the row) */
  guessed?: GuessedValue[];
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

// Sample values per JSON Schema "format" ({today} is today's UTC date, YYYY-MM-DD). Same table as mcp-check.
const FORMATS: Record<string, string> = {
  date: "{today}",
  "date-time": "{today}T00:00:00Z",
  time: "00:00:00Z",
  duration: "P1D",
  email: "test@example.com",
  "idn-email": "test@example.com",
  hostname: "example.com",
  "idn-hostname": "example.com",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
  uri: "https://example.com",
  "uri-reference": "https://example.com",
  iri: "https://example.com",
  "iri-reference": "https://example.com",
  "uri-template": "https://example.com/{id}",
  url: "https://example.com",
  uuid: "00000000-0000-4000-8000-000000000000",
  "json-pointer": "/a",
  "relative-json-pointer": "0",
  regex: ".*",
};
const NO_HINT = "no enum, format, pattern, examples or description hint";

/** A required value would only be the "test" placeholder (the tool is skipped, not called). */
export class PlaceholderError extends AutoCaseError {}

const own = (o: object, k: string) =>
  Object.prototype.hasOwnProperty.call(o, k);

// ----------------------------------------------------------------- description / name hints
// Mirror of mcp-check's hints.py (same regexes, same order). Generic heuristics only.

const ENUM_LEAD =
  /(?:\benum\b|\bone of\b|\b(?:allowed|possible|valid|accepted|supported|permitted) values?\b)\s*(?:is|are)?\s*[:=]?\s*/i;
const ENUM_TOKEN = /^[A-Za-z0-9_.:+-]+$/;
const QUOTES = "\"'`\u2018\u2019\u201c\u201d()[]{}";
const DATE_PART = "(y{4}|y{2}|m{1,2}|d{1,2})";
const DATE_TOKEN_SRC = `${DATE_PART}([-/.]?)${DATE_PART}\\2${DATE_PART}`;
const DATE_TOKEN = new RegExp(
  `(?<![A-Za-z0-9])${DATE_TOKEN_SRC}(?![A-Za-z0-9])`,
  "gi",
);
const DATE_TOKEN_FULL = new RegExp(`^${DATE_TOKEN_SRC}$`, "i");
const TIME_TAIL = /^(\s*'T'\s*|\s*T\s*|\s+)(hh?):mm(:ss)?/i;
const DATETIME =
  /\biso[\s_-]?8601\b|\bdate[\s_-]?time\b|\brfc[\s_-]?3339\b|\btimestamps?\b/i;
const NOT_ISO = /\b(?:unix|epoch)\b/i;
const NAME_TOKENS = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z0-9]+|[A-Z]+/g;
const NOT_DATE = new Set([
  "candidate",
  "candidates",
  "validate",
  "update",
  "updates",
  "mandate",
  "mandates",
  "consolidate",
  "accommodate",
  "liquidate",
]);
const NOT_TIME = new Set([
  "runtime",
  "uptime",
  "lifetime",
  "overtime",
  "onetime",
  "anytime",
]);
const TEXT_NAMES = new Set([
  "q",
  "query",
  "keyword",
  "keywords",
  "search",
  "searchterm",
  "searchtext",
  "searchquery",
  "term",
  "terms",
  "text",
  "freetext",
]);
const RANGE = new Set([
  "start",
  "end",
  "from",
  "to",
  "begin",
  "since",
  "until",
  "after",
  "before",
]);

function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

/** Values a description lists as allowed ("Enum: a, b"), or null. */
export function enumHint(description: unknown): string[] | null {
  if (typeof description !== "string") return null;
  const m = ENUM_LEAD.exec(description);
  if (!m) return null;
  let rest = description.slice(m.index + m[0].length);
  const lead = /^[^:.;\n]{0,40}:\s*/.exec(rest); // "one of the following: a, b"
  if (lead) rest = rest.slice(lead[0].length);
  rest = rest.split(/\.\s|\.$|;|\n/)[0];
  const vals: string[] = [];
  for (const raw of rest.split(/,|\||\/|\bor\b|\band\b/)) {
    const v = stripChars(raw.trim(), QUOTES).trim();
    if (!v) continue;
    if (!ENUM_TOKEN.test(v)) break;
    vals.push(v);
  }
  return vals.length ? vals : null;
}

/** [kind, date token, time tail] for the first date-format token in the text, or null. */
export function dateFormatHint(
  description: unknown,
): ["date" | "date-time", string, string] | null {
  if (typeof description !== "string") return null;
  for (const m of description.matchAll(DATE_TOKEN)) {
    const kinds = new Set([m[1], m[3], m[4]].map((g) => g[0].toLowerCase()));
    if (kinds.size !== 3) continue;
    const tail = TIME_TAIL.exec(
      description.slice((m.index ?? 0) + m[0].length),
    );
    return [tail ? "date-time" : "date", m[0], tail ? tail[0] : ""];
  }
  return null;
}

/** Render a date token like "dd/MM/yyyy" (plus an optional time tail) for `today` (YYYY-MM-DD). */
export function renderDateFormat(
  token: string,
  tail: string,
  today: string,
): string {
  const y = today.slice(0, 4);
  const mo = today.slice(5, 7);
  const d = today.slice(8, 10);
  const m = DATE_TOKEN_FULL.exec(token);
  if (!m) throw new AutoCaseError(`not a date token: ${token}`);
  const parts = [m[1], m[3], m[4]].map((g) => {
    const k = g[0].toLowerCase();
    return k === "y" ? (g.length === 4 ? y : y.slice(2)) : k === "m" ? mo : d;
  });
  let out = parts.join(m[2]);
  if (tail) {
    const t = TIME_TAIL.exec(tail);
    if (t)
      out +=
        (t[1].toLowerCase().includes("t") ? "T" : " ") +
        "00:00" +
        (t[3] ? ":00" : "");
  }
  return out;
}

/** True if the text asks for an ISO 8601 / RFC 3339 date-time or a timestamp (not a Unix/epoch one). */
export function datetimeHint(description: unknown): boolean {
  return (
    typeof description === "string" &&
    DATETIME.test(description) &&
    !NOT_ISO.test(description)
  );
}

function nameTokens(name: string): string[] {
  return (name.match(NAME_TOKENS) ?? []).map((t) => t.toLowerCase());
}

/** "date-time", "date" or "text" (a free-text search field) from a property name, or null. */
export function nameKind(name: string): "date" | "date-time" | "text" | null {
  const toks = nameTokens(name);
  if (
    toks.some(
      (t) =>
        t === "time" ||
        t === "timestamp" ||
        t === "datetime" ||
        ((t.endsWith("time") || t.endsWith("timestamp")) && !NOT_TIME.has(t)),
    )
  )
    return "date-time";
  if (
    toks.length >= 2 &&
    toks[toks.length - 1] === "at" &&
    toks[toks.length - 2].endsWith("ed")
  )
    return "date-time"; // createdAt, updated_at
  if (
    toks.some(
      (t) => (t.startsWith("date") || t.endsWith("date")) && !NOT_DATE.has(t),
    )
  )
    return "date";
  if (toks.some((t) => TEXT_NAMES.has(t))) return "text";
  return null;
}

/** Name with its one range word (start/end, from/to, ...) removed; null if it has none. */
export function rangeKey(name: string): string | null {
  const toks = nameTokens(name);
  const hits = toks.flatMap((t, i) => (RANGE.has(t) ? [i] : []));
  if (hits.length !== 1) return null;
  return toks.filter((_, i) => i !== hits[0]).join("_");
}

// ----------------------------------------------------------------- pattern -> sample
// Literals, escapes (\d \w \s ...), classes, groups, alternation (first branch) and quantifiers
// (their minimum). Lookarounds, backreferences and \p{..} are not supported (null). The sample is
// always re-checked against the pattern. Mirror of mcp-check's pattern_sample.

const CLASS_ESC: Record<string, string> = {
  d: "0-9",
  w: "a-zA-Z0-9_",
  s: " ",
};
const ATOM_ESC: Record<string, string> = {
  d: "0",
  D: "a",
  w: "a",
  W: "-",
  s: " ",
  S: "a",
  n: "\n",
  t: "\t",
  r: "\r",
  f: "\f",
  v: "\v",
};
const NEG_CANDIDATES = "aA0_- .x";
const QUANT = /^\{(\d+)(,\d*)?\}/;

class Unsupported extends Error {}

const atomEsc = (e: string) => (own(ATOM_ESC, e) ? ATOM_ESC[e] : e);

function classItems(
  p: string,
  i0: number,
): [Array<[string, string]>, boolean, number] {
  let i = i0;
  const neg = i < p.length && p[i] === "^";
  if (neg) i++;
  const items: Array<[string, string]> = [];
  let first = true;
  while (i < p.length && (p[i] !== "]" || first)) {
    first = false;
    const c = p[i];
    let ch: string;
    if (c === "\\") {
      if (i + 1 >= p.length) throw new Unsupported();
      const e = p[i + 1];
      i += 2;
      if (own(CLASS_ESC, e)) {
        const spec = CLASS_ESC[e];
        for (let j = 0; j < spec.length; ) {
          if (j + 2 < spec.length && spec[j + 1] === "-") {
            items.push([spec[j], spec[j + 2]]);
            j += 3;
          } else {
            items.push([spec[j], spec[j]]);
            j += 1;
          }
        }
        continue;
      }
      if ("DWSpP".includes(e)) throw new Unsupported();
      ch = atomEsc(e);
    } else {
      ch = c;
      i += 1;
    }
    if (i + 1 < p.length && p[i] === "-" && p[i + 1] !== "]") {
      let hi = p[i + 1];
      if (hi === "\\") {
        if (i + 2 >= p.length) throw new Unsupported();
        hi = atomEsc(p[i + 2]);
        i += 3;
      } else i += 2;
      items.push([ch, hi]);
    } else items.push([ch, ch]);
  }
  if (i >= p.length) throw new Unsupported();
  return [items, neg, i + 1];
}

function quant(p: string, i0: number): [number, number] {
  let i = i0;
  if (i >= p.length) return [1, i];
  const c = p[i];
  let n: number;
  if (c === "*" || c === "?") {
    n = 0;
    i += 1;
  } else if (c === "+") {
    n = 1;
    i += 1;
  } else if (c === "{") {
    const m = QUANT.exec(p.slice(i));
    if (!m) return [1, i];
    n = Number(m[1]);
    i += m[0].length;
  } else return [1, i];
  if (i < p.length && (p[i] === "?" || p[i] === "+")) i += 1;
  return [Math.min(n, 1000), i];
}

function alt(p: string, i0: number): [string, number] {
  let first: string | null = null;
  let i = i0;
  for (;;) {
    const [s, j] = seq(p, i);
    i = j;
    if (first === null) first = s;
    if (i < p.length && p[i] === "|") {
      i += 1;
      continue;
    }
    return [first, i];
  }
}

function seq(p: string, i0: number): [string, number] {
  let out = "";
  let i = i0;
  while (i < p.length && p[i] !== "|" && p[i] !== ")") {
    const c = p[i];
    if (c === "^" || c === "$") {
      i += 1;
      continue;
    }
    if ("*+?".includes(c) || (c === "{" && QUANT.test(p.slice(i))))
      throw new Unsupported();
    let atom: string;
    if (c === "(") {
      i += 1;
      if (p.startsWith("?:", i)) i += 2;
      else if (
        p.startsWith("?<", i) &&
        !p.startsWith("?<=", i) &&
        !p.startsWith("?<!", i)
      ) {
        const close = p.indexOf(">", i);
        if (close < 0) throw new Unsupported();
        i = close + 1;
      } else if (i < p.length && p[i] === "?") throw new Unsupported();
      [atom, i] = alt(p, i);
      if (i >= p.length || p[i] !== ")") throw new Unsupported();
      i += 1;
    } else if (c === "[") {
      const [items, neg, j] = classItems(p, i + 1);
      i = j;
      if (neg) {
        const pick = [...NEG_CANDIDATES].find(
          (ch) => !items.some(([lo, hi]) => lo <= ch && ch <= hi),
        );
        if (pick === undefined) throw new Unsupported();
        atom = pick;
      } else {
        if (!items.length) throw new Unsupported();
        atom = items[0][0];
      }
    } else if (c === ".") {
      atom = "a";
      i += 1;
    } else if (c === "\\") {
      if (i + 1 >= p.length) throw new Unsupported();
      const e = p[i + 1];
      i += 2;
      if (e === "b" || e === "B") continue;
      if (/[0-9]/.test(e) || "pPkcux".includes(e)) throw new Unsupported();
      atom = atomEsc(e);
    } else {
      atom = c;
      i += 1;
    }
    const [n, j] = quant(p, i);
    i = j;
    out += atom.repeat(n);
  }
  return [out, i];
}

/** A short string that matches `pattern` (JSON Schema regex, unanchored), or null. */
export function patternSample(pattern: string): string | null {
  try {
    const [s, i] = alt(pattern, 0);
    if (i !== pattern.length) return null;
    return new RegExp(pattern, "u").test(s) ? s : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- value generation

/** A value auto-cases took from a description or name, not from the schema itself. */
export interface GuessedValue {
  path: string;
  value: unknown;
  source: string;
}

interface Ctx {
  today: string;
  guessed: GuessedValue[];
  placeholders: string[];
  kinds: Map<string, string>;
}

const newCtx = (today: string): Ctx => ({
  today,
  guessed: [],
  placeholders: [],
  kinds: new Map(),
});

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

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

const firstValue = (values: unknown[]) =>
  values.find((v) => v !== null && v !== undefined) ?? values[0];

function placeholder(schema: Schema): string {
  const n = Number(schema.minLength ?? 0);
  const s = "test".repeat(Math.floor(n / 4) + 1).slice(0, Math.max(n, 4));
  return s.slice(0, Number(schema.maxLength ?? 1e6));
}

function stringValue(
  schema: Schema,
  ctx: Ctx,
  path: string,
  name: string,
): string {
  const today = ctx.today;
  const fmt = schema.format;
  if (typeof fmt === "string" && own(FORMATS, fmt)) {
    if (fmt === "date" || fmt === "date-time") ctx.kinds.set(path, fmt);
    return FORMATS[fmt].replace("{today}", today);
  }
  const pat = schema.pattern;
  if (typeof pat === "string") {
    const s = patternSample(pat);
    if (s === null)
      throw new AutoCaseError(
        `can't generate a value for ${path} that matches its pattern ${JSON.stringify(pat)}`,
      );
    return s;
  }
  const guess = (value: string, source: string, kind?: string) => {
    ctx.guessed.push({ path, value, source });
    if (kind) ctx.kinds.set(path, kind);
    return value;
  };
  const desc = schema.description;
  const vals = enumHint(desc);
  if (vals) return guess(vals[0], "description lists allowed values");
  const dh = dateFormatHint(desc);
  if (dh) {
    const [kind, token, tail] = dh;
    return guess(
      renderDateFormat(token, tail, today),
      `description date format ${token}${tail}`,
      kind,
    );
  }
  if (datetimeHint(desc))
    return guess(
      `${today}T00:00:00Z`,
      "description asks for a date-time",
      "date-time",
    );
  const nk = name ? nameKind(name) : null;
  if (nk === "date") return guess(today, "name suggests a date", "date");
  if (nk === "date-time")
    return guess(
      `${today}T00:00:00Z`,
      "name suggests a date-time",
      "date-time",
    );
  if (nk === "text")
    return guess(placeholder(schema), "name suggests free text");
  ctx.placeholders.push(path);
  return placeholder(schema);
}

const isNum = (v: unknown): v is number => typeof v === "number";

function numberValue(schema: Schema, integer: boolean): number {
  let lo = isNum(schema.minimum) ? schema.minimum : undefined;
  if (isNum(schema.exclusiveMinimum))
    lo =
      lo !== undefined
        ? Math.max(lo, schema.exclusiveMinimum + 1)
        : schema.exclusiveMinimum + 1;
  let hi = isNum(schema.maximum) ? schema.maximum : undefined;
  if (isNum(schema.exclusiveMaximum))
    hi =
      hi !== undefined
        ? Math.min(hi, schema.exclusiveMaximum - 1)
        : schema.exclusiveMaximum - 1;
  let v = lo ?? 1;
  if (hi !== undefined && v > hi) v = hi;
  const step = schema.multipleOf;
  if (isNum(step) && step > 0) v = Math.ceil(v / step) * step;
  return integer ? Math.trunc(v) : v;
}

function valueFor(
  schemaIn: unknown,
  root: unknown,
  depth: number,
  ctx: Ctx,
  path: string,
  name: string,
): unknown {
  if (depth > 12) throw new AutoCaseError("schema nests too deeply");
  const schema = resolveStrict(schemaIn, root);
  if (schema === true || schema === undefined || schema === null) return null;
  if (!isObj(schema)) throw new AutoCaseError("unsupported schema");
  if (Object.keys(schema).length === 0) return null;
  if ("const" in schema) return schema.const;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length)
    return firstValue(schema.enum);
  if (Array.isArray(schema.examples) && schema.examples.length)
    return firstValue(schema.examples);
  for (const key of ["anyOf", "oneOf"]) {
    const opts = schema[key];
    if (Array.isArray(opts) && opts.length) {
      const nonNull = opts.filter((o) => !(isObj(o) && o.type === "null"));
      let best: [unknown, Ctx] | null = null;
      let last: unknown = null;
      for (const o0 of nonNull.length ? nonNull : opts) {
        let opt = resolveStrict(o0, root);
        if (
          isObj(opt) &&
          !("description" in opt) &&
          typeof schema.description === "string"
        )
          opt = { ...opt, description: schema.description }; // hints usually sit on the parent
        const sub = newCtx(ctx.today);
        let v: unknown;
        try {
          v = valueFor(opt, root, depth + 1, sub, path, name);
        } catch (e) {
          if (!(e instanceof AutoCaseError)) throw e;
          last = e;
          continue;
        }
        if (!sub.placeholders.length) {
          best = [v, sub];
          break;
        }
        if (best === null) best = [v, sub];
      }
      if (best === null)
        throw last ?? new AutoCaseError("no usable anyOf/oneOf option");
      const [v, sub] = best;
      ctx.guessed.push(...sub.guessed);
      ctx.placeholders.push(...sub.placeholders);
      for (const [k, kind] of sub.kinds) ctx.kinds.set(k, kind);
      return v;
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
    return valueFor(merged, root, depth + 1, ctx, path, name);
  }
  let t = schema.type as unknown;
  if (Array.isArray(t)) t = t.find((x) => x !== "null") ?? "null";
  if (t === undefined && "properties" in schema) t = "object";
  switch (t) {
    case "object": {
      const props = isObj(schema.properties) ? schema.properties : {};
      const out: Record<string, unknown> = {};
      const req = (
        Array.isArray(schema.required) ? schema.required : []
      ).filter((n): n is string => typeof n === "string");
      const child = new Map(req.map((n) => [n, path ? `${path}.${n}` : n]));
      for (const n of req) {
        const p = child.get(n) as string;
        if (own(props, n))
          out[n] = valueFor(props[n], root, depth + 1, ctx, p, n);
        else {
          ctx.placeholders.push(p);
          out[n] = "test";
        }
      }
      // A range (startDate/endDate, from/to, ...) gets the same value on both ends, so limits hold.
      for (const n of req) {
        const p = child.get(n) as string;
        const key = rangeKey(n);
        if (!ctx.placeholders.includes(p) || key === null) continue;
        const partner = req.find(
          (m) =>
            m !== n &&
            rangeKey(m) === key &&
            ctx.kinds.has(child.get(m) as string),
        );
        if (partner !== undefined) {
          out[n] = out[partner];
          ctx.placeholders.splice(ctx.placeholders.indexOf(p), 1);
          ctx.kinds.set(
            p,
            ctx.kinds.get(child.get(partner) as string) as string,
          );
          ctx.guessed.push({
            path: p,
            value: out[n],
            source: `range pair with ${partner}`,
          });
        }
      }
      return out;
    }
    case "array": {
      const n = Number(schema.minItems ?? 0);
      return Array.from({ length: n }, (_, i) =>
        valueFor(
          schema.items ?? {},
          root,
          depth + 1,
          ctx,
          `${path}[${i}]`,
          name,
        ),
      );
    }
    case "string":
      return stringValue(schema, ctx, path, name);
    case "integer":
    case "number":
      return numberValue(schema, t === "integer");
    case "boolean":
      return false;
    default:
      return null;
  }
}

export interface AutoArgs {
  args: Record<string, unknown>;
  /** values taken from a description or name ({path, value, source}) */
  guessed: GuessedValue[];
}

/**
 * Required properties only, each with the most realistic value the schema allows (same rules as
 * mcp-check's build_args). Throws PlaceholderError if a required value would only be the "test"
 * placeholder (unless allowPlaceholders), and AutoCaseError if the args can't be built or don't validate.
 */
export function buildAutoArgs(
  inputSchema: unknown,
  opts: { today?: string; allowPlaceholders?: boolean } = {},
): AutoArgs {
  if (!isObj(inputSchema))
    throw new AutoCaseError("inputSchema is not an object");
  const ctx = newCtx(opts.today ?? todayUtc());
  let args = valueFor(inputSchema, inputSchema, 0, ctx, "", "");
  if (args === null) args = {};
  if (!isObj(args))
    throw new AutoCaseError("inputSchema does not describe an object");
  if (ctx.placeholders.length && !opts.allowPlaceholders)
    throw new PlaceholderError(
      `can't build a realistic value for ${ctx.placeholders.join(", ")} (${NO_HINT})`,
    );
  const errs = schemaErrors(inputSchema, args);
  if (errs.length)
    throw new AutoCaseError(
      `the generated args do not validate at ${errs[0].path}: ${errs[0].message}`,
    );
  return { args, guessed: ctx.guessed };
}

/** Required properties only, most realistic values; throws if they can't be built or would not validate. */
export function minimalArgs(
  inputSchema: unknown,
  opts: { today?: string; allowPlaceholders?: boolean } = {},
): Record<string, unknown> {
  return buildAutoArgs(inputSchema, opts).args;
}

/**
 * The single-tool editor's starting point: the generated args (a "test" placeholder is allowed
 * here, since you can edit it) and what was guessed, or {} if nothing valid can be built.
 */
export function generatedArgs(tool: ToolLike): AutoArgs {
  try {
    return buildAutoArgs(tool.inputSchema, { allowPlaceholders: true });
  } catch {
    return { args: {}, guessed: [] };
  }
}

/** Pretty JSON of generatedArgs(tool).args. */
export function generatedArgsText(tool: ToolLike): string {
  return JSON.stringify(generatedArgs(tool).args, null, 2);
}

/** Row-detail note for values guessed from a description or name (same text as mcp-check). */
export function guessedNote(guessed: GuessedValue[] | undefined): string {
  if (!guessed?.length) return "";
  return (
    " Values guessed from the description or name: " +
    guessed
      .map((g) => `${g.path} = ${JSON.stringify(g.value)} (${g.source})`)
      .join(", ") +
    "."
  );
}

export function autoCase(
  tool: ToolLike,
  allow: string[] = [],
  deny: string[] = [],
): { testCase: TestCase | null; reason: string } {
  const reason = autoEligibility(tool, allow, deny);
  if (reason) return { testCase: null, reason };
  try {
    const { args, guessed } = buildAutoArgs(
      tool.inputSchema ?? { type: "object" },
    );
    return {
      testCase: { tool: tool.name, args, expect: "any", name: "auto", guessed },
      reason: "",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      testCase: null,
      reason:
        e instanceof PlaceholderError
          ? `it ${msg}`
          : `it could not build valid args (${msg})`,
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
  if (testCase.guessed?.length) data.guessed_args = testCase.guessed;
  const row = (status: Status, detail: string): Row => ({
    tool: tool.name,
    check: label,
    status,
    ms: outcome.ms,
    detail: detail + guessedNote(testCase.guessed),
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
