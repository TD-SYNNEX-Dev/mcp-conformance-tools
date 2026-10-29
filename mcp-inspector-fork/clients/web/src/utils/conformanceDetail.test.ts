import { describe, it, expect } from "vitest";
import {
  highlightsFor,
  jsonLines,
  lineMatches,
  resultView,
  rowDetail,
  schemaPointer,
} from "./conformanceDetail";
import {
  buildExport,
  evaluateCall,
  lintRow,
  type TestCase,
} from "./conformanceRules";

const schema = {
  type: "object",
  properties: {
    message: { type: "string" },
    items: { type: "array", items: { $ref: "#/$defs/item" } },
    status: { enum: ["active", "inactive"] },
    name: { type: "string" },
  },
  required: ["message", "name"],
  additionalProperties: false,
  $defs: { item: { type: "object", properties: { id: { type: "integer" } } } },
};

const marked = (value: unknown, pointer: string, mode?: "subtree" | "open") =>
  jsonLines(value)
    .filter((l) => lineMatches(l, pointer, mode))
    .map((l) => l.text.trim());

describe("jsonLines", () => {
  it("renders exactly JSON.stringify(v, null, 2), one pointer per line", () => {
    const v = { a: 1, b: { c: [true, null], d: {} }, e: [] };
    const lines = jsonLines(v);
    expect(lines.map((l) => l.text).join("\n")).toBe(
      JSON.stringify(v, null, 2),
    );
    expect(lines.map((l) => l.pointer)).toEqual([
      "",
      "/a",
      "/b",
      "/b/c",
      "/b/c/0",
      "/b/c/1",
      "/b/c",
      "/b/d",
      "/b",
      "/e",
      "",
    ]);
  });

  it("escapes ~ and / in keys like JSON Pointer", () => {
    const lines = jsonLines({ "a/b": 1, "c~d": 2 });
    expect(lines.map((l) => l.pointer)).toContain("/a~1b");
    expect(lines.map((l) => l.pointer)).toContain("/c~0d");
  });
});

describe("path highlighting", () => {
  it("marks a leaf, a whole subtree, or only the opening line", () => {
    const v = { message: null, items: [{ id: "x" }], name: "n" };
    expect(marked(v, "/message")).toEqual(['"message": null,']);
    expect(marked(v, "/items")).toEqual([
      '"items": [',
      "{",
      '"id": "x"',
      "}",
      "],",
    ]);
    expect(marked(v, "", "open")).toEqual(["{"]);
    expect(marked(v, "/nope")).toEqual([]);
  });

  it("maps instance paths to schema pointers through properties, items and $ref", () => {
    expect(schemaPointer(schema, "/message")).toBe("/properties/message");
    expect(schemaPointer(schema, "/items/3/id")).toBe(
      "/$defs/item/properties/id",
    );
    expect(schemaPointer(schema, "/items/0")).toBe("/$defs/item");
    expect(schemaPointer(schema, "/")).toBe("");
    expect(schemaPointer(schema, "/unknown/deep")).toBe("");
    const branchy = {
      anyOf: [
        { type: "null" },
        { type: "object", properties: { x: { type: "string" } } },
      ],
    };
    expect(schemaPointer(branchy, "/x")).toBe("/anyOf/1/properties/x");
  });

  it("turns each issue kind into result + schema marks", () => {
    const hs = highlightsFor(
      [
        {
          kind: "null",
          path: "/message",
          expected: ["string"],
          nullable: false,
        },
        { kind: "required", path: "/name", name: "name" },
        { kind: "extra", path: "/debug", name: "debug" },
        {
          kind: "enum",
          path: "/status",
          allowed: ["active"],
          actual: "archived",
        },
        { kind: "missing_structured", path: "/" },
      ],
      [{ path: "/message" }],
      schema,
    );
    expect(hs).toEqual([
      {
        result: "/structuredContent/message",
        resultMode: "subtree",
        schema: "/properties/message",
        note: "/message is null",
      },
      {
        result: "/structuredContent",
        resultMode: "open",
        schema: "/properties/name",
        note: "/name is missing",
      },
      {
        result: "/structuredContent/debug",
        resultMode: "subtree",
        schema: "/additionalProperties",
        note: "/debug is not allowed",
      },
      {
        result: "/structuredContent/status",
        resultMode: "subtree",
        schema: "/properties/status",
        note: "/status is not an allowed value",
      },
      {
        result: null,
        resultMode: "subtree",
        schema: null,
        note: "no structuredContent in the result",
      },
    ]);
  });

  it("points a null found in JSON text content at /content", () => {
    expect(highlightsFor([], [{ path: "/message" }], schema, "text")).toEqual([
      {
        result: "/content",
        resultMode: "subtree",
        schema: "/properties/message",
        note: "/message is null",
      },
    ]);
  });
});

const tool = {
  name: "null_string_field",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  outputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
};
const testCase: TestCase = {
  tool: tool.name,
  name: "auto",
  args: { query: "test" },
  expect: "any",
};
const result = {
  content: [{ type: "text", text: '{"message":null}' }],
  structuredContent: { message: null },
};

describe("row detail + export", () => {
  it("call rows carry the args, the raw result and the output schema", () => {
    const rows = evaluateCall(tool, testCase, "call[auto]", {
      kind: "result",
      result,
    });
    expect(rows.map((r) => r.check)).toEqual(["call[auto]", "null-sweep"]);
    expect(rows[0].data).toMatchObject({
      args: { query: "test" },
      output_schema: tool.outputSchema,
      result: {
        content: result.content,
        structuredContent: { message: null },
        isError: false,
      },
      // the existing fields stay
      structured_content: { message: null },
      is_error: false,
      content_text: ['{"message":null}'],
    });

    const d = rowDetail(rows[0], undefined, tool);
    expect(d?.kind === "call" && d.highlights.map((h) => h.result)).toEqual([
      "/structuredContent/message",
    ]);
    // the null-sweep row shows its call, with only its own nulls marked
    const sweep = rowDetail(rows[1], rows[0], tool);
    expect(sweep).toMatchObject({
      kind: "call",
      args: { query: "test" },
      schema: tool.outputSchema,
      highlights: [{ schema: "/properties/message", note: "/message is null" }],
    });
  });

  it("export rows include args, result and output_schema, keeping the old fields", () => {
    const rows = [
      lintRow(tool),
      ...evaluateCall(tool, testCase, "call[auto]", { kind: "result", result }),
    ];
    const body = JSON.parse(
      JSON.stringify(buildExport({ tools: [tool], rows, autoCases: true })),
    );
    expect(Object.keys(body)).toEqual([
      "tool",
      "generated_at",
      "server_info",
      "tool_count",
      "cases_file",
      "auto_cases",
      "result",
      "coverage",
      "rows",
      "tools",
    ]);
    const call = body.rows[1];
    expect(call.check).toBe("call[auto]");
    expect(call.data.args).toEqual({ query: "test" });
    expect(call.data.result).toEqual({
      content: result.content,
      structuredContent: { message: null },
      isError: false,
    });
    expect(call.data.output_schema).toEqual(tool.outputSchema);
    expect(call.data.issues[0]).toMatchObject({
      kind: "null",
      path: "/message",
    });
  });

  it("a call that threw still has args and schema, and no result", () => {
    const [row] = evaluateCall(
      tool,
      { ...testCase, expect: "success", name: "x" },
      "call[0] x",
      { kind: "error", message: "boom" },
    );
    expect(rowDetail(row, undefined, tool)).toMatchObject({
      kind: "call",
      result: null,
      error: "boom",
      schema: tool.outputSchema,
    });
  });

  it("lint rows show both schemas and mark lint findings", () => {
    const t = {
      name: "nullable_keyword",
      inputSchema: { type: "object" },
      outputSchema: {
        type: "object",
        properties: { message: { type: "string", nullable: true } },
      },
    };
    const d = rowDetail(lintRow(t), undefined, t);
    expect(d).toMatchObject({
      kind: "lint",
      marks: {
        inputSchema: [],
        outputSchema: ["/properties/message/nullable"],
      },
    });
    expect(
      rowDetail({ tool: "x", check: "call", data: undefined }, undefined, t),
    ).toBeNull();
  });

  it("resultView defaults content and isError", () => {
    expect(resultView({})).toEqual({ content: [], isError: false });
  });
});
