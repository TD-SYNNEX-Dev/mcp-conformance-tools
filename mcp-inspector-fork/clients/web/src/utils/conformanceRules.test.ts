import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  FAIL,
  PASS,
  WARN,
  autoCase,
  autoEligibility,
  buildExport,
  coverage,
  coverageLine,
  evaluateCall,
  lintRow,
  lintTool,
  minimalArgs,
  schemaIssues,
  sideEffectReason,
  nullSweep,
  parseCases,
  schemaErrors,
  stripOpenApiNullable,
  summaryLine,
  type TestCase,
  type ToolLike,
} from "./conformanceRules";
import { mismatchDetail } from "./conformanceExplain";

const input = {
  type: "object",
  properties: { keyword: { type: "string", minLength: 1 } },
  required: ["keyword"],
};
const basicSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    message: { type: "string" },
    items: { type: "array", items: { type: "object" } },
  },
  required: ["status", "message", "items"],
};
const nullableSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    message: { type: "string", nullable: true },
  },
  required: ["status", "message"],
};
const nullTool = {
  name: "null_string_field",
  inputSchema: input,
  outputSchema: basicSchema,
};
const nullableTool = {
  name: "nullable_keyword",
  inputSchema: input,
  outputSchema: nullableSchema,
};
const auto: TestCase = {
  tool: "x",
  args: { keyword: "test" },
  expect: "any",
  name: "auto",
};
const ok: TestCase = { tool: "x", args: { keyword: "a" }, expect: "success" };

describe("message: null vs type string", () => {
  const payload = { status: "OK", message: null, items: [] };

  it("schemaErrors reports the exact path", () => {
    expect(schemaErrors(basicSchema, payload)).toEqual([
      {
        path: "/message",
        message: "must be string, got null",
        schemaPath: "/properties/message/type",
      },
    ]);
  });

  it("evaluateCall FAILs with the path and adds a null-sweep FAIL row", () => {
    const rows = evaluateCall(nullTool, auto, "call[auto]", {
      kind: "result",
      result: { structuredContent: payload, content: [] },
      sdkError: "data/message must be string",
    });
    expect(rows[0].status).toBe(FAIL);
    expect(rows[0].detail).toBe(
      "Field /message is null, but the output schema says it must be a string. " +
        "Strict clients (like the Python SDK) will reject this response. " +
        'Fix: return a string, or allow null with "type": ["string", "null"].',
    );
    expect(rows[0].detail).not.toMatch(/Ajv|TS SDK/);
    expect(rows[1].check).toBe("null-sweep");
    expect(rows[1].status).toBe(FAIL);
  });

  it("lint lists message as a required output field that can't be null", () => {
    const r = lintRow(nullTool);
    expect(r.status).toBe(PASS);
    expect(r.detail).toBe(
      "Required output fields that can't be null: status, message, items.",
    );
  });
});

describe("OpenAPI nullable is ignored", () => {
  const payload = { status: "OK", message: null };

  it("plain Ajv (what the TS SDK uses) accepts it", () => {
    const ajv = new Ajv2020({ strict: false });
    expect(ajv.validate(nullableSchema, payload)).toBe(true);
  });

  it("the spec-strict validator rejects it", () => {
    expect(schemaErrors(nullableSchema, payload)).toEqual([
      expect.objectContaining({
        path: "/message",
        message: "must be string, got null",
      }),
    ]);
  });

  it("evaluateCall FAILs even though the TS SDK accepted it, and says why", () => {
    const rows = evaluateCall(nullableTool, auto, "call[auto]", {
      kind: "result",
      result: { structuredContent: payload },
    });
    expect(rows[0].status).toBe(FAIL);
    expect(rows[0].detail).toContain(
      "Its `nullable: true` does not help: that is an OpenAPI keyword, and JSON Schema ignores it.",
    );
    expect(rows[0].detail).toContain(
      "Some clients (e.g. the TypeScript SDK) accept this, others (e.g. the Python SDK) reject it.",
    );
    expect(rows[1].detail).toContain(
      "/message (must be a string; its `nullable: true` is an OpenAPI keyword that JSON Schema ignores)",
    );
  });

  it("lint warns that null is still rejected", () => {
    const r = lintRow(nullableTool);
    expect(r.status).toBe(WARN);
    expect(r.detail).toContain(
      'outputSchema at /properties/message: Uses `nullable: true`. That is an OpenAPI keyword, and JSON Schema ignores it, so this field still rejects null (its type is "string").',
    );
    expect(r.detail).toContain('Fix: use "type": ["string", "null"] instead.');
    expect(lintRow(nullableTool, true).status).toBe(FAIL);
  });

  it("the documented fix passes", () => {
    const fixed = {
      ...nullableSchema,
      properties: {
        status: { type: "string" },
        message: { type: ["string", "null"] },
      },
    };
    expect(schemaErrors(fixed, payload)).toEqual([]);
    expect(nullSweep(fixed, payload)).toEqual([]);
  });

  it("strip keeps a property named nullable", () => {
    const s = {
      type: "object",
      properties: { nullable: { type: "boolean", nullable: true } },
    };
    expect(stripOpenApiNullable(s)).toEqual({
      type: "object",
      properties: { nullable: { type: "boolean" } },
    });
  });
});

describe("lint", () => {
  it("flags a non-object outputSchema and an invalid schema", () => {
    const f = lintTool({
      name: "t",
      inputSchema: { type: "object", properties: { a: { type: 5 } } },
      outputSchema: { type: "array" },
    });
    expect(
      f.filter((x) => x.severity === "error").map((x) => x.schema),
    ).toEqual(["inputSchema", "outputSchema"]);
  });
  it("flags a missing inputSchema", () => {
    expect(lintRow({ name: "t" }).status).toBe(FAIL);
  });
  it("checks tool names and the input schema root", () => {
    const r = lintRow({ name: "bad name!", inputSchema: { type: "string" } });
    expect(r.status).toBe(FAIL);
    expect(r.detail).toContain(
      'Tool name "bad name!" breaks the MCP naming rule',
    );
    expect(r.detail).toContain(
      'inputSchema at /type: The input schema\'s root must be "type": "object"',
    );
    expect(lintRow({ name: "ok.name-1_x", inputSchema: input }).detail).toBe(
      "No output schema, so clients can't validate this tool's results.",
    );
  });
});

describe("plain-language details", () => {
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer" },
      status: { enum: ["active", "inactive"] },
      id: { type: "string" },
      name: { type: "string" },
    },
    required: ["id", "name"],
    additionalProperties: false,
  };
  it("type, required, extra, enum: what, where, and the fix", () => {
    const one = (v: Record<string, unknown>) =>
      mismatchDetail(schemaIssues(schema, v));
    expect(one({ id: "1", name: "n", count: "12" })).toBe(
      'Field /count is a string ("12"), but the output schema says it must be an integer. ' +
        "Strict clients (like the Python SDK) will reject this response. " +
        'Fix: return an integer, or change the schema to "type": "string".',
    );
    expect(one({ id: "1" })).toBe(
      "Required field /name is missing. Strict clients (like the Python SDK) will reject this response. " +
        'Fix: always include "name", or remove it from "required" in the output schema.',
    );
    expect(one({ id: "1", name: "n", debug: true })).toContain(
      'Field /debug is not in the output schema, which does not allow extra fields ("additionalProperties": false).',
    );
    expect(one({ id: "1", name: "n", status: "archived" })).toContain(
      'Field /status is "archived", which is not one of the allowed values ("active", "inactive").',
    );
    expect(one({ name: "n", count: 1.5 })).toMatch(
      /^2 problems with this response\. .* \(1\) Field \/count is a number \(1\.5\).* \(2\) Required field \/id is missing\./,
    );
  });
});

describe("null sweep", () => {
  it("finds nested nulls through $ref, items, and anyOf", () => {
    const s = {
      type: "object",
      $defs: {
        line: { type: "object", properties: { sku: { type: "string" } } },
      },
      properties: {
        lines: { type: "array", items: { $ref: "#/$defs/line" } },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    };
    expect(
      nullSweep(s, { lines: [{ sku: "a" }, { sku: null }], note: null }).map(
        (f) => f.path,
      ),
    ).toEqual(["/lines/1/sku"]);
  });
  it("sweeps JSON text when there is no structuredContent", () => {
    const rows = evaluateCall(nullTool, ok, "call[0]", {
      kind: "result",
      result: {
        content: [{ type: "text", text: '{"status":"OK","message":null}' }],
      },
      sdkError: "no structured content",
    });
    expect(rows[0].status).toBe(FAIL);
    expect(rows[0].detail).toContain(
      "The tool declares an output schema, but the response has no structuredContent.",
    );
    expect(rows[1].detail).toContain(
      "checked the JSON in the text content, because there is no structuredContent",
    );
  });
});

describe("auto-cases", () => {
  it("skips tools whose names suggest side effects, whatever the allowlist says", () => {
    expect(autoEligibility({ name: "submit_form" }, ["*"])).toBe(
      "its name suggests side effects (contains 'submit')",
    );
    expect(sideEffectReason({ name: "delete_record" })).toContain("'delete'");
    expect(sideEffectReason({ name: "search_items" })).toBeNull();
    expect(autoEligibility({ name: "OrderSearch" })).toContain("'order'");
    expect(autoEligibility({ name: "lookup" }, [], ["look*"])).toContain(
      "look*",
    );
    expect(
      autoEligibility({
        name: "lookup",
        annotations: { destructiveHint: true },
      }),
    ).toBe("the server marks it destructive (destructiveHint: true)");
    expect(autoEligibility({ name: "lookup" }, ["get_*"])).toBe(
      "it is not in the auto-allow list",
    );
    expect(autoEligibility({ name: "get_item" }, ["get_*"])).toBeNull();
  });

  it("builds minimal valid args", () => {
    expect(minimalArgs(input)).toEqual({ keyword: "test" });
    expect(
      minimalArgs({
        type: "object",
        properties: {
          d: { type: "string", format: "date" },
          n: { type: "integer", minimum: 3 },
          e: { enum: ["x", "y"] },
          l: { type: "array", minItems: 1, items: { type: "boolean" } },
          opt: { type: "string" },
        },
        required: ["d", "n", "e", "l"],
      }),
    ).toEqual({ d: "2026-01-01", n: 3, e: "x", l: [false] });
  });

  it("reports why it cannot build args", () => {
    const r = autoCase({
      name: "t",
      inputSchema: {
        type: "object",
        properties: { a: { type: "string", pattern: "^[0-9]+$" } },
        required: ["a"],
      },
    });
    expect(r.testCase).toBeNull();
    expect(r.reason).toContain("do not validate");
  });

  it("auto-case errors are WARN, not FAIL", () => {
    const rows = evaluateCall({ name: "t" }, auto, "call[auto]", {
      kind: "error",
      message: "MCP error -32602: bad",
    });
    expect(rows[0].status).toBe(WARN);
  });
});

describe("cases file", () => {
  it("parses the mcp-check format", () => {
    const c = parseCases(
      "healthy_tool:\n  - args: {keyword: a}\n    name: basic\n  - args: {}\n    expect: error\nping:\n",
    );
    expect(c.healthy_tool).toHaveLength(2);
    expect(c.healthy_tool[1].expect).toBe("error");
    expect(c.ping).toEqual([{ tool: "ping", args: {}, expect: "success" }]);
    expect(parseCases('{"a": {"args": {"x": 1}}}', "c.json").a[0].args).toEqual(
      {
        x: 1,
      },
    );
  });
  it("rejects arguments at the wrong level", () => {
    expect(() => parseCases("t:\n  - keyword: a\n")).toThrow(/unknown keys/);
    expect(() => parseCases("t:\n  - expect: maybe\n")).toThrow(/expect/);
    expect(() => parseCases("- a\n")).toThrow(/top level/);
  });
});

describe("coverage + export", () => {
  it("counts exercised tools and names the rest", () => {
    const rows = [
      { tool: "a", check: "call[auto]", status: PASS, detail: "" },
      {
        tool: "b",
        check: "call",
        status: "NOT EXERCISED" as const,
        detail: "",
      },
      { tool: "b", check: "lint", status: PASS, detail: "" },
    ];
    const cov = coverage(["a", "b"], rows);
    expect(coverageLine(cov)).toBe(
      "coverage: 2 tools, 1 exercised, 1 not exercised (b)",
    );
    expect(summaryLine(2, rows)).toContain("1 not exercised");
    expect(coverageLine(coverage(["a"], rows.slice(0, 1)))).toBe(
      "coverage: 1 tool, 1 exercised, 0 not exercised",
    );
    const tools: ToolLike[] = [{ name: "a" }, { name: "b" }];
    const out = buildExport({ tools, rows });
    expect(out.result).toBe("PASS");
    expect(out.coverage).toEqual(cov);
  });
});
