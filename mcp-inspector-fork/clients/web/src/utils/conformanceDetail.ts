/**
 * Row detail for the Conformance tab: pretty-printed JSON split into lines
 * that each know their JSON Pointer, plus the pointers to highlight for a
 * row's problems (in the tool result and in the output schema). Mirrors
 * mcp-check's detail.py, which prints the same view for `--show-response`.
 */
import type { Issue } from "./conformanceExplain";

export interface JsonLine {
  /** Indented text of the line, including any key and trailing comma. */
  text: string;
  /** JSON Pointer of the value this line opens, closes, or holds. */
  pointer: string;
  kind: "open" | "close" | "leaf";
}

/** One problem to mark: where in the result, where in the schema. */
export interface Highlight {
  /** Pointer into the displayed result object (`/structuredContent/...`), or null. */
  result: string | null;
  /** "subtree" marks the value and its children; "open" marks only its first line (missing field). */
  resultMode: "subtree" | "open";
  /** Pointer into the output schema, or null. */
  schema: string | null;
  /** Short plain-language note, e.g. "/message is null". */
  note: string;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function esc(name: string): string {
  return String(name).replace(/~/g, "~0").replace(/\//g, "~1");
}

function unesc(part: string): string {
  return part.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function splitPointer(pointer: string): string[] {
  if (pointer === "" || pointer === "/") return [];
  return pointer.split("/").slice(1).map(unesc);
}

/** `JSON.stringify(value, null, 2)`, one entry per line, each tagged with its pointer. */
export function jsonLines(value: unknown): JsonLine[] {
  const out: JsonLine[] = [];
  const visit = (
    v: unknown,
    ptr: string,
    indent: string,
    prefix: string,
    comma: string,
  ): void => {
    const entries: Array<[string, string, unknown]> | null = Array.isArray(v)
      ? v.map((x, i) => [String(i), "", x])
      : isObj(v)
        ? Object.entries(v)
            .filter(([, x]) => x !== undefined)
            .map(([k, x]) => [esc(k), `${JSON.stringify(k)}: `, x])
        : null;
    if (entries === null) {
      const text = v === undefined ? "null" : JSON.stringify(v);
      out.push({
        text: indent + prefix + text + comma,
        pointer: ptr,
        kind: "leaf",
      });
      return;
    }
    const [open, close] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
    if (!entries.length) {
      out.push({
        text: indent + prefix + open + close + comma,
        pointer: ptr,
        kind: "leaf",
      });
      return;
    }
    out.push({ text: indent + prefix + open, pointer: ptr, kind: "open" });
    entries.forEach(([seg, keyText, x], i) =>
      visit(
        x,
        `${ptr}/${seg}`,
        indent + "  ",
        keyText,
        i < entries.length - 1 ? "," : "",
      ),
    );
    out.push({ text: indent + close + comma, pointer: ptr, kind: "close" });
  };
  visit(value, "", "", "", "");
  return out;
}

/** True if this line belongs to the value at `target` (whole subtree, or only its first line). */
export function lineMatches(
  line: JsonLine,
  target: string,
  mode: "subtree" | "open" = "subtree",
): boolean {
  if (mode === "open") return line.pointer === target && line.kind !== "close";
  return line.pointer === target || line.pointer.startsWith(target + "/");
}

function resolveRef(node: unknown, root: unknown): [unknown, string | null] {
  if (
    isObj(node) &&
    typeof node.$ref === "string" &&
    node.$ref.startsWith("#")
  ) {
    const ptr = node.$ref.slice(1);
    let cur: unknown = root;
    for (const part of splitPointer(ptr)) {
      if (!isObj(cur) && !Array.isArray(cur)) return [node, null];
      cur = (cur as Obj)[part];
    }
    return [cur, ptr];
  }
  return [node, null];
}

/**
 * Best-effort pointer to the schema node that describes `instancePath`
 * (`/message` -> `/properties/message`). Follows local $refs, items,
 * prefixItems, additionalProperties, and the first allOf/anyOf/oneOf branch
 * that has the property. Stops at the deepest node it can find.
 */
export function schemaPointer(schema: unknown, instancePath: string): string {
  let ptr = "";
  let node: unknown = schema;
  for (const seg of splitPointer(instancePath)) {
    const [resolved, refPtr] = resolveRef(node, schema);
    if (refPtr !== null) ptr = refPtr;
    node = resolved;
    if (!isObj(node)) return ptr;
    const step = stepInto(node, seg, schema);
    if (!step) return ptr;
    ptr += step[0];
    node = step[1];
  }
  const [, refPtr] = resolveRef(node, schema);
  return refPtr ?? ptr;
}

function stepInto(
  node: Obj,
  seg: string,
  root: unknown,
): [string, unknown] | null {
  if (isObj(node.properties) && seg in node.properties)
    return [`/properties/${esc(seg)}`, node.properties[seg]];
  if (/^\d+$/.test(seg)) {
    const i = Number(seg);
    if (Array.isArray(node.prefixItems) && i < node.prefixItems.length)
      return [`/prefixItems/${i}`, node.prefixItems[i]];
    if (isObj(node.items)) return ["/items", node.items];
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const list = node[key];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const [branch, refPtr] = resolveRef(list[i], root);
      if (!isObj(branch)) continue;
      const step = stepInto(branch, seg, root);
      if (step) return [(refPtr ?? `/${key}/${i}`) + step[0], step[1]];
    }
  }
  if (isObj(node.additionalProperties))
    return ["/additionalProperties", node.additionalProperties];
  return null;
}

function parentOf(pointer: string): string {
  const i = pointer.lastIndexOf("/");
  return i <= 0 ? "" : pointer.slice(0, i);
}

function under(base: string, path: string): string {
  return path === "/" || path === "" ? base : base + path;
}

/**
 * What to mark for one row. Pointers into the result are relative to the
 * displayed result object `{content, structuredContent, isError}`; the null
 * check on JSON text content can only point at `/content`.
 */
export function highlightsFor(
  issues: Issue[],
  nullFields: Array<{ path: string }>,
  schema: unknown,
  nullSource: "structuredContent" | "text" = "structuredContent",
): Highlight[] {
  const out: Highlight[] = [];
  const seen = new Set<string>();
  const add = (h: Highlight) => {
    const k = `${h.result}|${h.resultMode}|${h.schema}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(h);
    }
  };
  for (const i of issues) {
    switch (i.kind) {
      case "missing_structured":
        add({
          result: null,
          resultMode: "subtree",
          schema: null,
          note: "no structuredContent in the result",
        });
        break;
      case "required":
        add({
          result: under("/structuredContent", parentOf(i.path)),
          resultMode: "open",
          schema: schemaPointer(schema, i.path),
          note: `${i.path} is missing`,
        });
        break;
      case "extra":
        add({
          result: under("/structuredContent", i.path),
          resultMode: "subtree",
          schema: under(
            schemaPointer(schema, parentOf(i.path)),
            "/additionalProperties",
          ),
          note: `${i.path} is not allowed`,
        });
        break;
      default: {
        const what =
          i.kind === "null"
            ? "is null"
            : i.kind === "type"
              ? "has the wrong type"
              : i.kind === "enum"
                ? "is not an allowed value"
                : i.kind === "const"
                  ? "is not the required value"
                  : "does not match";
        add({
          result: under("/structuredContent", i.path),
          resultMode: "subtree",
          schema: schemaPointer(schema, i.path),
          note: `${i.path} ${what}`,
        });
      }
    }
  }
  for (const n of nullFields)
    add({
      result:
        nullSource === "text"
          ? "/content"
          : under("/structuredContent", n.path),
      resultMode: "subtree",
      schema: schemaPointer(schema, n.path),
      note: `${n.path} is null`,
    });
  return out;
}

/** The result as the detail panel and the export show it. */
export function resultView(result: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}): Record<string, unknown> {
  const view: Record<string, unknown> = { content: result.content ?? [] };
  if (result.structuredContent !== undefined)
    view.structuredContent = result.structuredContent;
  view.isError = result.isError === true;
  return view;
}

interface RowLike {
  tool: string;
  check: string;
  data?: Record<string, unknown>;
}

interface FindingLike {
  schema: string;
  severity: string;
  path: string;
  message: string;
}

export type RowDetail =
  | {
      kind: "call";
      args: unknown;
      /** `{content, structuredContent, isError}`, or null when the call threw. */
      result: Record<string, unknown> | null;
      error: string | null;
      schema: unknown;
      highlights: Highlight[];
    }
  | {
      kind: "lint";
      inputSchema: unknown;
      outputSchema: unknown;
      /** Schema pointers with a lint error or warning, per schema. */
      marks: { inputSchema: string[]; outputSchema: string[] };
      notes: string[];
      /** Structured findings for severity badges and readable field locations. */
      findings: FindingLike[];
    };

/**
 * What the detail panel shows for a row, or null when there is nothing to
 * show (a tool that was not called). A null-sweep row shows the call it
 * belongs to (`prev`, the row just before it) with only its own null fields
 * marked.
 */
export function rowDetail(
  row: RowLike,
  prev: RowLike | undefined,
  tool: { inputSchema?: unknown; outputSchema?: unknown } | undefined,
): RowDetail | null {
  if (row.check === "lint") {
    if (!tool) return null;
    const findings = ((row.data?.findings as FindingLike[]) ?? []).filter(
      (f) => f.severity !== "info",
    );
    const pick = (which: string) =>
      findings.filter((f) => f.schema === which).map((f) => f.path);
    return {
      kind: "lint",
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
      marks: {
        inputSchema: pick("inputSchema"),
        outputSchema: pick("outputSchema"),
      },
      findings: (row.data?.findings as FindingLike[]) ?? [],
      notes: findings.map(
        (f) => `${f.schema}${f.path ? ` at ${f.path}` : ""}: ${f.message}`,
      ),
    };
  }
  const sweep = row.check === "null-sweep";
  const call = sweep ? prev : row;
  const data = call?.data;
  if (!call || !data || !("args" in data)) return null;
  const schema = data.output_schema ?? null;
  const nulls = (row.data?.null_fields as Array<{ path: string }>) ?? [];
  const source =
    (row.data?.null_sweep_source ?? data.null_sweep_source) === "text"
      ? "text"
      : "structuredContent";
  return {
    kind: "call",
    args: data.args,
    result: isObj(data.result) ? data.result : null,
    error: typeof data.error === "string" ? data.error : null,
    schema,
    highlights: sweep
      ? highlightsFor([], nulls, schema, source)
      : highlightsFor(
          (data.issues as Issue[]) ?? [],
          (data.null_fields as Array<{ path: string }>) ?? [],
          schema,
          source,
        ),
  };
}
