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
  buildAutoArgs,
  generatedArgsText,
  guessedNote,
  lintSchema,
  minimalArgs,
  patternSample,
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
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
      minimalArgs(
        {
          type: "object",
          properties: {
            d: { type: "string", format: "date" },
            n: { type: "integer", minimum: 3 },
            e: { enum: ["x", "y"] },
            l: { type: "array", minItems: 1, items: { type: "boolean" } },
            opt: { type: "string" },
          },
          required: ["d", "n", "e", "l"],
        },
        { today: "2026-01-01" },
      ),
    ).toEqual({ d: "2026-01-01", n: 3, e: "x", l: [false] });
  });

  it("reports why it cannot build args", () => {
    const r = autoCase({
      name: "t",
      inputSchema: {
        type: "object",
        properties: { a: { type: "string", pattern: "^(?=9)[0-9]+$" } },
        required: ["a"],
      },
    });
    expect(r.testCase).toBeNull();
    expect(r.reason).toContain("could not build valid args");
    expect(r.reason).toContain("matches its pattern");
    const tooLong = autoCase({
      name: "t",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "string", pattern: "^[0-9]{8}$", maxLength: 4 },
        },
        required: ["a"],
      },
    });
    expect(tooLong.reason).toContain("do not validate");
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

// --------------------------------------------------------------------- realistic auto-case values
// __fixtures__/auto_args_parity.json is a byte-for-byte copy of mcp-check's
// tests/auto_args_parity.json (mcp-check's tests check that), so the CLI and
// the Conformance tab build the same args and lint the same way.
interface ParityFixture {
  today: string;
  args: Array<{
    name: string;
    schema: unknown;
    args?: Record<string, unknown>;
    guessed?: unknown[];
    error?: string;
  }>;
  lint: Array<{ name: string; schema: unknown; findings: unknown[] }>;
}
const PARITY = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "__fixtures__", "auto_args_parity.json"),
    "utf8",
  ),
) as ParityFixture;

describe("auto-case values (parity fixture with mcp-check)", () => {
  it.each(PARITY.args.map((c) => [c.name, c] as const))("%s", (_, fx) => {
    if (fx.error !== undefined)
      expect(() => buildAutoArgs(fx.schema, { today: PARITY.today })).toThrow(
        fx.error,
      );
    else
      expect(buildAutoArgs(fx.schema, { today: PARITY.today })).toEqual({
        args: fx.args,
        guessed: fx.guessed,
      });
  });

  it.each(PARITY.lint.map((c) => [c.name, c] as const))("lint: %s", (_, fx) => {
    const got = lintSchema("inputSchema", fx.schema)
      .filter((f) => f.severity !== "info")
      .map(({ severity, path, message }) => ({ severity, path, message }));
    expect(got).toEqual(fx.findings);
    expect(
      lintSchema("outputSchema", fx.schema).filter(
        (f) => f.severity === "warn",
      ),
    ).toEqual([]);
  });

  it("PRD-style billing tool gets realistic args, marked as guessed", () => {
    const tool: ToolLike = {
      name: "get_billing_summary",
      inputSchema: {
        type: "object",
        properties: {
          startDate: {
            type: "string",
            description: "Start date filter (yyyy-MM-dd).",
          },
          endDate: {
            type: "string",
            description: "End date filter (yyyy-MM-dd).",
          },
          scope: {
            type: "string",
            description: "Enum: invoices, charges. Use charges for line items.",
          },
          limit: { type: "integer" },
        },
        required: ["startDate", "endDate", "scope"],
      },
    };
    const r = autoCase(tool);
    const today = new Date().toISOString().slice(0, 10);
    expect(r.reason).toBe("");
    expect(r.testCase?.args).toEqual({
      startDate: today,
      endDate: today,
      scope: "invoices",
    });
    const rows = evaluateCall(tool, r.testCase as TestCase, "call[auto]", {
      kind: "result",
      result: { isError: true, content: [{ type: "text", text: "bad" }] },
    });
    expect(rows[0].status).toBe(WARN); // grading unchanged
    expect(rows[0].data?.guessed_args).toEqual(r.testCase?.guessed);
    expect(rows[0].detail).toContain(
      `Values guessed from the description or name: startDate = "${today}" (description date format yyyy-MM-dd)`,
    );
  });

  it("skips a required field that would only get the placeholder, naming it", () => {
    const tool: ToolLike = {
      name: "get_thing",
      inputSchema: {
        type: "object",
        properties: { thing_id: { type: "string" }, note: { type: "string" } },
        required: ["thing_id"],
      },
    };
    expect(autoCase(tool)).toEqual({
      testCase: null,
      reason:
        "it can't build a realistic value for thing_id (no enum, format, pattern, examples or description hint)",
    });
    // the single-tool editor still pre-fills something you can edit
    expect(JSON.parse(generatedArgsText(tool))).toEqual({ thing_id: "test" });
    expect(guessedNote([])).toBe("");
  });

  it.each([
    ["^[0-9]{8}$", "00000000"],
    ["^[A-Z]{2}-\\d{4}$", "AA-0000"],
    ["^(foo|bar)_[a-z]+$", "foo_a"],
    ["^[^0-9]+$", "a"],
    ["\\.json$", ".json"],
    ["^(?:ab){2,3}c?$", "abab"],
    ["^\\w+@\\w+\\.com$", "a@a.com"],
    ["^(?=a)", null],
    ["(a)\\1", null],
    ["^\\p{L}+$", null],
  ])("pattern sample %s", (pattern, sample) => {
    expect(patternSample(pattern)).toBe(sample);
  });
});
