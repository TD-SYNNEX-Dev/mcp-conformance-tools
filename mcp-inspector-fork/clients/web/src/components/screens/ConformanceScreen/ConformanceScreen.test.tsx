import { describe, it, expect, vi, afterEach } from "vitest";
import userEvent from "@testing-library/user-event";
import type { Tool } from "@modelcontextprotocol/client";
import { renderWithMantine, screen } from "../../../test/renderWithMantine";
import { ConformanceScreen } from "./ConformanceScreen";

const input = {
  type: "object" as const,
  properties: { query: { type: "string", minLength: 1 } },
  required: ["query"],
};
const out = {
  type: "object" as const,
  properties: { status: { type: "string" }, message: { type: "string" } },
  required: ["status", "message"],
};
const tools: Tool[] = [
  { name: "null_string_field", inputSchema: input, outputSchema: out },
  { name: "healthy_tool", inputSchema: input, outputSchema: out },
  { name: "delete_record", inputSchema: input },
];

function setup() {
  const listToolsPage = vi.fn(async (cursor?: string) =>
    cursor
      ? { tools: tools.slice(2) }
      : { tools: tools.slice(0, 2), nextCursor: "p2" },
  );
  const callTool = vi.fn(async (tool: Tool, args: Record<string, unknown>) => ({
    kind: "result" as const,
    result:
      tool.name === "healthy_tool" && args.query === "error"
        ? {
            isError: true,
            content: [{ type: "text" as const, text: "query not allowed" }],
          }
        : {
            structuredContent: {
              status: "OK",
              message: tool.name === "healthy_tool" ? "fine" : null,
            },
            content: [],
          },
  }));
  renderWithMantine(
    <ConformanceScreen listToolsPage={listToolsPage} callTool={callTool} />,
  );
  return { listToolsPage, callTool };
}

afterEach(() => vi.unstubAllGlobals());

describe("ConformanceScreen", () => {
  it("without cases or auto-cases, calls nothing and marks every tool Not exercised", async () => {
    const { callTool, listToolsPage } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Run checks" }));
    expect(listToolsPage).toHaveBeenCalledTimes(2);
    expect(callTool).not.toHaveBeenCalled();
    expect(await screen.findAllByText("Not exercised")).toHaveLength(3);
  });

  it("auto-cases FAILs message:null in plain language and never calls delete_record", async () => {
    const { callTool } = setup();
    await userEvent.click(screen.getByLabelText(/Auto-cases/));
    await userEvent.click(screen.getByRole("button", { name: "Run checks" }));
    expect(
      await screen.findByText(
        /Field \/message is null, but the output schema says it must be a string\./,
      ),
    ).toBeInTheDocument();
    const called = callTool.mock.calls.map(([t]) => t.name);
    expect(called).toEqual(["null_string_field", "healthy_tool"]);
    expect(
      screen.getByText(
        /coverage: 3 tools, 2 exercised, 1 not exercised \(delete_record\)/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/its name suggests side effects \(contains 'delete'\)/),
    ).toBeInTheDocument();
  });

  it("tests one tool with custom args, and the summary covers only that tool", async () => {
    const { callTool } = setup();
    await userEvent.click(screen.getByRole("button", { name: "List & lint" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Test healthy_tool" }),
    );
    const editor = screen.getByLabelText(/^Args/);
    expect(JSON.parse((editor as HTMLTextAreaElement).value)).toEqual({
      query: "test",
    });
    await userEvent.clear(editor);
    await userEvent.type(editor, '{{"query": "error"}');
    await userEvent.click(
      screen.getByRole("button", { name: "Run this tool" }),
    );
    expect(
      await screen.findByText(/The tool reported an error \(isError: true\)/),
    ).toBeInTheDocument();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0][1]).toEqual({ query: "error" });
    expect(screen.getByText("call[args]")).toBeInTheDocument();
    expect(screen.getByText("Only healthy_tool")).toBeInTheDocument();
    expect(
      screen.getByText("coverage: 1 tool, 1 exercised, 0 not exercised"),
    ).toBeInTheDocument();
  });

  it("asks before calling a tool that may change data", async () => {
    const { callTool } = setup();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await userEvent.click(screen.getByRole("button", { name: "List & lint" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Test delete_record" }),
    );
    expect(
      screen.getByText(/Careful: its name suggests side effects/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Run this tool" }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(callTool).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/you did not confirm the call/),
    ).toBeInTheDocument();

    confirm.mockImplementation(() => true);
    await userEvent.click(
      screen.getByRole("button", { name: "Run this tool" }),
    );
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0][0].name).toBe("delete_record");
  });

  it("rejects args that are not a JSON object", async () => {
    const { callTool } = setup();
    await userEvent.click(screen.getByRole("button", { name: "List & lint" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Test healthy_tool" }),
    );
    const editor = screen.getByLabelText(/^Args/);
    await userEvent.clear(editor);
    await userEvent.type(editor, "[[1]");
    await userEvent.click(
      screen.getByRole("button", { name: "Run this tool" }),
    );
    expect(
      await screen.findByText(/Args must be a JSON object/),
    ).toBeInTheDocument();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("opens a dialog with args, raw result and schema with /message marked", async () => {
    setup();
    await userEvent.click(screen.getByLabelText(/Auto-cases/));
    await userEvent.click(screen.getByRole("button", { name: "Run checks" }));
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Show details for null_string_field call[auto]",
      }),
    );
    expect(await screen.findByRole("dialog")).toHaveAccessibleName(
      /null_string_field · call\[auto\]/,
    );
    const panel = await screen.findByTestId("row-detail");
    expect(panel).toHaveTextContent("Field /message is null");
    expect(screen.getByLabelText("Args sent")).toHaveTextContent(
      '"query": "test"',
    );
    const marked = (label: string) =>
      [
        ...screen.getByLabelText(label).querySelectorAll("[data-highlight]"),
      ].map((el) => el.getAttribute("data-pointer"));
    expect(marked("Result")).toEqual(["/structuredContent/message"]);
    expect(marked("Structured schema (outputSchema)")).toEqual([
      "/properties/message",
      "/properties/message/type",
      "/properties/message", // its closing brace
    ]);
    expect(
      screen.getByRole("button", { name: "Copy result" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy schema" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Close",
      }),
    );
    expect(screen.queryByTestId("row-detail")).not.toBeInTheDocument();
  });
});
