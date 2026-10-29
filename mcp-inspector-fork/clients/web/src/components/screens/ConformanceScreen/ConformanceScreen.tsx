/** Conformance workspace: run checks and inspect results in a focused dialog. */
import { useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Flex,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import type { Tool } from "@modelcontextprotocol/client";
import {
  FAIL,
  NOT_EXERCISED,
  PASS,
  WARN,
  autoCase,
  buildExport,
  callLabel,
  coverage,
  coverageLine,
  evaluateCall,
  lintRow,
  generatedArgsText,
  NO_CASE_DETAIL,
  notCalledDetail,
  parseCases,
  sideEffectReason,
  summaryLine,
  type CallOutcome,
  type Row,
  type Status,
  type TestCase,
} from "../../../utils/conformanceRules";
import { rowDetail } from "../../../utils/conformanceDetail";
import { errorMessage } from "../../../utils/errorFormat";
import { ConformanceRowDetail } from "./ConformanceRowDetail";

/**
 * What the Conformance tab needs from the connection. App backs these with
 * `inspectorClient.listTools` and `inspectorClient.callTool(..., {
 * skipOutputValidation: true })`, so the screen sees the raw result plus the
 * TypeScript SDK's own output-validation verdict instead of a thrown error.
 */
export interface ConformancePanelProps {
  listToolsPage: (
    cursor?: string,
  ) => Promise<{ tools: Tool[]; nextCursor?: string }>;
  callTool: (tool: Tool, args: Record<string, unknown>) => Promise<CallOutcome>;
  serverInfo?: { name?: string; version?: string };
}

export interface ConformanceScreenProps extends ConformancePanelProps {
  /** Hide portal content when navigating away, while preserving the workspace. */
  active?: boolean;
}

const MAX_PAGES = 100;

const ScreenLayout = Stack.withProps({
  p: "xl",
  gap: "md",
  h: "calc(100dvh - var(--app-shell-header-height, 0px) - var(--app-shell-footer-height, 0px))",
});

const DetailDialog = Modal.withProps({
  size: "90%",
  centered: true,
  radius: "lg",
  padding: "xl",
  scrollAreaComponent: ScrollArea.Autosize,
});
const DetailSummary = Text.withProps({ size: "sm", mb: "md" });
const DialogHeading = Group.withProps({ gap: "sm", wrap: "wrap" });
const DialogToolName = Text.withProps({ fw: 600, size: "lg" });
const DetailPreview = Text.withProps({ size: "sm", lineClamp: 2 });

const STATUS_COLOR: Record<Status, string> = {
  PASS: "green",
  FAIL: "red",
  WARN: "yellow",
  "NOT EXERCISED": "gray",
  SKIPPED: "gray",
};

function splitGlobs(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function download(name: string, body: string) {
  const url = URL.createObjectURL(
    new Blob([body], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ConformanceScreen({
  listToolsPage,
  callTool,
  serverInfo,
  active = true,
}: ConformanceScreenProps) {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [cases, setCases] = useState<Record<string, TestCase[]>>({});
  const [casesFile, setCasesFile] = useState<string | undefined>();
  const [autoCases, setAutoCases] = useState(false);
  const [strictLint, setStrictLint] = useState(false);
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Single-tool mode: which tool, its args editor, and what was last run. */
  const [pick, setPick] = useState<string | null>(null);
  const [argsText, setArgsText] = useState("");
  const [argsError, setArgsError] = useState<string | null>(null);
  const [onlyTool, setOnlyTool] = useState<string | null>(null);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function listAll(): Promise<Tool[]> {
    const all: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await listToolsPage(cursor);
      all.push(...res.tools);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    setTools(all);
    return all;
  }

  async function onLint() {
    setError(null);
    setDetailIndex(null);
    setBusy("Listing tools…");
    try {
      const all = await listAll();
      setOnlyTool(null);
      setRows(all.map((t) => lintRow(t, strictLint)));
    } catch (e) {
      setError(`tools/list failed: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function onRun() {
    setError(null);
    setDetailIndex(null);
    setBusy("Listing tools…");
    try {
      const all = await listAll();
      setOnlyTool(null);
      const out: Row[] = [];
      const allowList = splitGlobs(allow);
      const denyList = splitGlobs(deny);
      const listed = new Set(all.map((t) => t.name));
      for (const tool of all) {
        out.push(lintRow(tool, strictLint));
        let todo = cases[tool.name] ?? [];
        if (!todo.length) {
          if (!autoCases) {
            out.push({
              tool: tool.name,
              check: "call",
              status: NOT_EXERCISED,
              detail: NO_CASE_DETAIL,
            });
            continue;
          }
          const { testCase, reason } = autoCase(tool, allowList, denyList);
          if (!testCase) {
            out.push({
              tool: tool.name,
              check: "call",
              status: NOT_EXERCISED,
              detail: notCalledDetail(reason ?? ""),
            });
            continue;
          }
          todo = [testCase];
        }
        for (let i = 0; i < todo.length; i++) {
          setBusy(`Calling ${tool.name}…`);
          const started = performance.now();
          let outcome: CallOutcome;
          try {
            outcome = await callTool(tool, todo[i].args);
          } catch (e) {
            outcome = { kind: "error", message: errorMessage(e) };
          }
          outcome.ms = Math.round(performance.now() - started);
          out.push(
            ...evaluateCall(tool, todo[i], callLabel(todo[i], i), outcome),
          );
          setRows([...out]);
        }
      }
      for (const name of Object.keys(cases))
        if (!listed.has(name))
          out.push({
            tool: name,
            check: "call",
            status: WARN,
            detail:
              "The cases file has a case for this tool, but the server does not list it.",
          });
      setRows(out);
    } catch (e) {
      setError(`run failed: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  }

  function choose(name: string | null) {
    setPick(name);
    setArgsError(null);
    const tool = (tools ?? []).find((t) => t.name === name);
    setArgsText(tool ? generatedArgsText(tool) : "");
  }

  async function runOne(tool: Tool, testCase: TestCase, index: number) {
    setBusy(`Calling ${tool.name}…`);
    const started = performance.now();
    let outcome: CallOutcome;
    try {
      outcome = await callTool(tool, testCase.args);
    } catch (e) {
      outcome = { kind: "error", message: errorMessage(e) };
    }
    outcome.ms = Math.round(performance.now() - started);
    return evaluateCall(tool, testCase, callLabel(testCase, index), outcome);
  }

  /**
   * Run just the picked tool. Edited args -> one case that must succeed
   * (`call[args]`). Unchanged generated args -> the cases-file cases if there
   * are any, else the generated args (`call[auto]`). A tool that looks like it
   * has side effects is only called after an explicit confirm.
   */
  async function onRunOne() {
    const tool = (tools ?? []).find((t) => t.name === pick);
    if (!tool) return;
    setError(null);
    let args: unknown;
    try {
      args = JSON.parse(argsText.trim() || "{}");
    } catch (e) {
      setArgsError(`Args are not valid JSON: ${errorMessage(e)}`);
      return;
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      setArgsError('Args must be a JSON object, e.g. {"query": "test"}.');
      return;
    }
    setArgsError(null);
    const edited =
      JSON.stringify(args) !==
      JSON.stringify(JSON.parse(generatedArgsText(tool)));
    const fromFile = cases[tool.name] ?? [];
    const todo: TestCase[] = edited
      ? [
          {
            tool: tool.name,
            name: "args",
            args: args as Record<string, unknown>,
            expect: "success",
          },
        ]
      : fromFile.length
        ? fromFile
        : [
            {
              tool: tool.name,
              name: "auto",
              args: args as Record<string, unknown>,
              expect: "any",
            },
          ];

    const out: Row[] = [lintRow(tool, strictLint)];
    setDetailIndex(null);
    setOnlyTool(tool.name);
    const why = sideEffectReason(tool, splitGlobs(deny));
    if (why) {
      const ok = window.confirm(
        `${tool.name}: ${why}, so calling it may change data on the server.\n\n` +
          `Call it anyway with these args?\n${JSON.stringify(args)}`,
      );
      if (!ok) {
        out.push({
          tool: tool.name,
          check: "call",
          status: NOT_EXERCISED,
          detail: `Not called: ${why}, so it may change data, and you did not confirm the call.`,
        });
        setRows(out);
        return;
      }
    }
    try {
      for (let i = 0; i < todo.length; i++) {
        out.push(...(await runOne(tool, todo[i], i)));
        setRows([...out]);
      }
    } finally {
      setBusy(null);
    }
  }

  async function onCasesFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const parsed = parseCases(await file.text(), file.name);
      setCases(parsed);
      setCasesFile(file.name);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function onExport() {
    const body = buildExport({
      server: serverInfo,
      tools: tools ?? [],
      rows,
      casesFile,
      autoCases,
    });
    download("conformance-report.json", JSON.stringify(body, null, 2));
  }

  const names = onlyTool ? [onlyTool] : (tools ?? []).map((t) => t.name);
  const picked = (tools ?? []).find((t) => t.name === pick);
  const pickedWhy = picked ? sideEffectReason(picked, splitGlobs(deny)) : null;
  const hasCalls = rows.some((r) => r.check.startsWith("call"));
  const failed = rows.some((r) => r.status === FAIL);
  const caseCount = Object.values(cases).reduce((n, c) => n + c.length, 0);

  const selectedRow = detailIndex === null ? undefined : rows[detailIndex];
  const selectedDetail = selectedRow
    ? rowDetail(
        selectedRow,
        rows[(detailIndex as number) - 1],
        (tools ?? []).find((t) => t.name === selectedRow.tool),
      )
    : null;

  return (
    <ScreenLayout>
      <DetailDialog
        opened={active && !!selectedRow}
        onClose={() => setDetailIndex(null)}
        title={
          selectedRow ? (
            <DialogHeading>
              <DialogToolName>
                {selectedRow.tool} · {selectedRow.check}
              </DialogToolName>
              <Badge color={STATUS_COLOR[selectedRow.status]}>
                {selectedRow.status}
              </Badge>
            </DialogHeading>
          ) : (
            "Check details"
          )
        }
      >
        {selectedRow &&
          (selectedDetail ? (
            <ConformanceRowDetail
              detail={selectedDetail}
              summary={selectedRow.detail}
            />
          ) : (
            <DetailSummary>{selectedRow.detail}</DetailSummary>
          ))}
      </DetailDialog>
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Title order={3}>Conformance</Title>
          <Text size="sm" c="dimmed">
            Checks each tool&apos;s schemas, calls the tools, and checks every
            result against its output schema (JSON Schema 2020-12, the way
            strict clients do). Each problem says what was expected, what came
            back, where, and how to fix it. Same rules and wording as mcp-check.
          </Text>
        </Stack>
        <Group gap="xs">
          <Button variant="default" onClick={onLint} disabled={!!busy}>
            List &amp; lint
          </Button>
          <Button
            variant="default"
            onClick={() => fileRef.current?.click()}
            disabled={!!busy}
          >
            Load cases…
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".yaml,.yml,.json"
            hidden
            aria-label="Cases file"
            onChange={(e) => {
              void onCasesFile(e.currentTarget.files?.[0]);
              e.currentTarget.value = "";
            }}
          />
          <Button onClick={onRun} loading={!!busy && busy !== null}>
            Run checks
          </Button>
          <Button
            variant="default"
            onClick={onExport}
            disabled={!rows.length || !!busy}
          >
            Export JSON
          </Button>
        </Group>
      </Group>

      <Group gap="lg" align="flex-end">
        <Checkbox
          label="Auto-cases (call tools with generated args; tools that may change data are skipped)"
          checked={autoCases}
          onChange={(e) => setAutoCases(e.currentTarget.checked)}
        />
        <Checkbox
          label="Strict lint (warnings fail)"
          checked={strictLint}
          onChange={(e) => setStrictLint(e.currentTarget.checked)}
        />
        <TextInput
          size="xs"
          label="Auto allow (globs)"
          placeholder="e.g. get_*, *_search"
          value={allow}
          onChange={(e) => setAllow(e.currentTarget.value)}
        />
        <TextInput
          size="xs"
          label="Extra deny (words/globs)"
          placeholder="e.g. approve, *_po"
          value={deny}
          onChange={(e) => setDeny(e.currentTarget.value)}
        />
      </Group>

      <Text size="sm" c="dimmed">
        Cases:{" "}
        {casesFile
          ? `${casesFile} (${caseCount} case(s), ${Object.keys(cases).length} tool(s))`
          : "none loaded"}
        {busy ? ` · ${busy}` : ""}
      </Text>

      {error && (
        <Alert color="red" title="Error">
          {error}
        </Alert>
      )}

      <Paper withBorder p="sm">
        <Text size="sm" fw={600} mb={4}>
          Test one tool
        </Text>
        {tools ? (
          <Stack gap="xs">
            <Group align="flex-end" gap="xs">
              <Select
                size="xs"
                label="Tool"
                placeholder="Pick a tool"
                searchable
                data={tools.map((t) => t.name)}
                value={pick}
                onChange={choose}
                w={280}
              />
              <Button size="xs" onClick={onRunOne} disabled={!picked || !!busy}>
                Run this tool
              </Button>
              <Button
                size="xs"
                variant="default"
                onClick={() => choose(pick)}
                disabled={!picked || !!busy}
              >
                Reset args
              </Button>
            </Group>
            {picked && (
              <>
                <Textarea
                  size="xs"
                  label="Args (JSON object; prefilled with the smallest valid args, edit as you like)"
                  autosize
                  minRows={2}
                  maxRows={8}
                  styles={{ input: { fontFamily: "monospace" } }}
                  value={argsText}
                  error={argsError}
                  onChange={(e) => setArgsText(e.currentTarget.value)}
                />
                {pickedWhy && (
                  <Text size="xs" c="orange">
                    Careful: {pickedWhy}, so it may change data. You will be
                    asked to confirm before it is called.
                  </Text>
                )}
              </>
            )}
          </Stack>
        ) : (
          <Text size="xs" c="dimmed">
            Click “List &amp; lint” (or “Run checks”) first, then pick a tool
            here or use a row&apos;s “Test” button.
          </Text>
        )}
      </Paper>

      {tools && (
        <Paper withBorder p="sm">
          <Flex gap="sm" align="center" wrap="wrap">
            {rows.length > 0 && (
              <Badge color={failed ? "red" : "green"} size="lg">
                {failed ? "FAIL" : "PASS"}
              </Badge>
            )}
            {onlyTool && (
              <Badge variant="outline" size="lg">
                Only {onlyTool}
              </Badge>
            )}
            <Text size="sm" ff="monospace">
              {summaryLine(names.length, rows)}
            </Text>
          </Flex>
          {hasCalls && (
            <Text size="sm" ff="monospace" mt={4}>
              {coverageLine(coverage(names, rows))}
            </Text>
          )}
        </Paper>
      )}

      <ScrollArea flex={1}>
        <Table striped highlightOnHover verticalSpacing={4}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Tool</Table.Th>
              <Table.Th>Check</Table.Th>
              <Table.Th w={130}>Status</Table.Th>
              <Table.Th>ms</Table.Th>
              <Table.Th>Detail</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r, i) => {
              const tool = (tools ?? []).find((t) => t.name === r.tool);

              return (
                <Table.Tr key={`${r.tool}-${r.check}-${i}`}>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <Code>{r.tool}</Code>
                      {r.check === "lint" && tool && (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          aria-label={`Test ${r.tool}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            choose(r.tool);
                          }}
                          disabled={!!busy}
                        >
                          Test
                        </Button>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <Text size="sm">{r.check}</Text>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        aria-haspopup="dialog"
                        aria-label={`Show details for ${r.tool} ${r.check}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDetailIndex(i);
                        }}
                      >
                        Details
                      </Button>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={STATUS_COLOR[r.status]} variant="light">
                      {r.status === NOT_EXERCISED ? "Not exercised" : r.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{r.ms ?? ""}</Table.Td>
                  <Table.Td>
                    <DetailPreview>{r.detail}</DetailPreview>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
        {!rows.length && (
          <Text c="dimmed" size="sm" mt="md">
            Click “List &amp; lint” for a static check, or “Run checks” to call
            every tool that has a case ({PASS} / {FAIL} / {WARN} per call). To
            check a single tool with your own args, use “Test one tool”. Open
            Details to see the args sent, the raw result and the output schema,
            with the problem fields marked.
          </Text>
        )}
      </ScrollArea>
    </ScreenLayout>
  );
}
