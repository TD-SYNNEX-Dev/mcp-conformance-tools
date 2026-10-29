/** Regression coverage for a single explanation per finding and readable evidence. */
import { describe, expect, it } from "vitest";
import { renderWithMantine, screen } from "../../../test/renderWithMantine";
import { lintRow } from "../../../utils/conformanceRules";
import { rowDetail, type RowDetail } from "../../../utils/conformanceDetail";
import { ConformanceRowDetail } from "./ConformanceRowDetail";

function renderLint(outputSchema?: Record<string, unknown>) {
  const tool = {
    name: "lookup",
    inputSchema: { type: "object" as const },
    outputSchema,
  };
  const row = lintRow(tool);
  renderWithMantine(
    <ConformanceRowDetail
      detail={rowDetail(row, undefined, tool)!}
      summary={row.detail}
    />,
  );
  return row;
}

describe("ConformanceRowDetail", () => {
  it("shows a warning explanation once, with its field location and required fields", () => {
    const row = renderLint({
      type: "object",
      properties: { message: { type: "string", nullable: true } },
      required: ["message"],
    });
    const finding = (
      row.data!.findings as Array<{ severity: string; message: string }>
    ).find((f) => f.severity === "warn")!;
    expect(screen.getAllByText(finding.message)).toHaveLength(1);
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(
      screen.getByText("/properties/message/nullable"),
    ).toBeInTheDocument();
    expect(screen.getByText("1 finding")).toBeInTheDocument();
    expect(
      screen.getByText(
        /These fields must be present and cannot be null: message/,
      ),
    ).toBeInTheDocument();
    expect(
      screen
        .getByLabelText("Structured schema (outputSchema)")
        .querySelector("[data-highlight]"),
    ).toBeInTheDocument();
  });

  it("distinguishes schema errors from warnings", () => {
    renderLint({ type: "array", items: { type: "string" } });
    expect(screen.getAllByText("Error").length).toBeGreaterThan(0);
  });

  it("shows a clean schema verdict without repeating the row summary", () => {
    renderLint({ type: "object" });
    expect(screen.getByText("No issues")).toBeInTheDocument();
    expect(
      screen.queryByText("OK: the schemas are valid."),
    ).not.toBeInTheDocument();
  });

  it("explains when an output schema is absent", () => {
    renderLint();
    expect(screen.getByText("No output schema")).toBeInTheDocument();
    expect(screen.getByText(/Clients cannot validate/)).toBeInTheDocument();
  });

  it("shows a call explanation once alongside its result, arguments and schema", () => {
    const detail: RowDetail = {
      kind: "call",
      args: { query: "example" },
      result: { structuredContent: { message: null } },
      error: null,
      schema: { type: "object" },
      highlights: [
        {
          note: "/message is null",
          result: "/structuredContent/message",
          resultMode: "subtree",
          schema: "",
        },
      ],
    };
    renderWithMantine(
      <ConformanceRowDetail
        detail={detail}
        summary="The message is null. Return a string."
      />,
    );
    expect(
      screen.getAllByText("The message is null. Return a string."),
    ).toHaveLength(1);
    expect(screen.queryByText("/message is null")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Args sent")).toHaveTextContent(
      '"query": "example"',
    );
    expect(
      screen.getByLabelText("Result").querySelector("[data-highlight]"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy result" }),
    ).toBeInTheDocument();
  });

  it("handles an unsuccessful call with no result", () => {
    const detail: RowDetail = {
      kind: "call",
      args: {},
      result: null,
      error: "Server disconnected",
      schema: null,
      highlights: [],
    };
    renderWithMantine(
      <ConformanceRowDetail detail={detail} summary="The call failed." />,
    );
    expect(
      screen.getByText("No result: Server disconnected"),
    ).toBeInTheDocument();
  });

  it("renders a successful response without highlights", () => {
    const detail: RowDetail = {
      kind: "call",
      args: {},
      result: {},
      error: null,
      schema: {},
      highlights: [],
    };
    renderWithMantine(
      <ConformanceRowDetail
        detail={detail}
        summary="The result matches the schema."
      />,
    );
    expect(
      screen.getByText("The result matches the schema."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Problem fields are highlighted/),
    ).not.toBeInTheDocument();
  });
});
