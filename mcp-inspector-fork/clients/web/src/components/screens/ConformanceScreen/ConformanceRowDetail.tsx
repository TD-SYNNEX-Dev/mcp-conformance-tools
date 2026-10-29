/** Focused findings and readable JSON evidence, without repeating the row summary. */
import {
  Alert,
  Badge,
  Code,
  Divider,
  Group,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
} from "@mantine/core";
import { CopyButton } from "../../elements/CopyButton/CopyButton";
import {
  jsonLines,
  lineMatches,
  type RowDetail,
} from "../../../utils/conformanceDetail";

interface Mark {
  pointer: string;
  mode: "subtree" | "open";
}

const EvidenceCard = Paper.withProps({
  withBorder: true,
  radius: "md",
  variant: "panel",
  miw: 0,
  bg: "var(--inspector-surface-code)",
});
const EvidenceHeader = Group.withProps({
  justify: "space-between",
  wrap: "nowrap",
  p: "sm",
  bg: "var(--inspector-surface-card)",
});
const SectionTitle = Text.withProps({ size: "sm", fw: 600 });
const SectionHeader = Group.withProps({ justify: "space-between", gap: "sm" });
const SectionHint = Text.withProps({ size: "xs", c: "dimmed" });
const EvidenceGrid = SimpleGrid.withProps({
  cols: { base: 1, lg: 2 },
  spacing: "md",
});
const BlockScroll = ScrollArea.Autosize.withProps({
  mah: "50vh",
  type: "auto",
  offsetScrollbars: true,
  p: "sm",
});
const JsonText = Text.withProps({
  component: "pre",
  m: 0,
  ff: "monospace",
  fz: "sm",
  lh: 1.7,
});
const JsonLine = Text.withProps({
  component: "div",
  pl: "xs",
  ff: "inherit",
  fz: "inherit",
  lh: "inherit",
});
const FindingCard = Paper.withProps({
  withBorder: true,
  radius: "md",
  p: "md",
  bg: "var(--inspector-surface-card)",
});
const FindingHeading = Group.withProps({ gap: "xs", mb: "xs", wrap: "wrap" });
const FindingMessage = Text.withProps({ size: "sm", lh: 1.7 });
const FindingPath = Code.withProps({ fz: "xs", variant: "monoBreak" });
const Workspace = Stack.withProps({ gap: "lg" });
const FindingsList = Stack.withProps({ gap: "sm" });
const SummaryAlert = Alert.withProps({ variant: "light", radius: "md" });
const EmptyResult = Text.withProps({ size: "sm", p: "md", c: "dimmed" });

/** Pretty-printed JSON with marked fields, a fixed heading, and independent scrolling. */
function JsonBlock({
  title,
  value,
  marks = [],
  copyLabel,
  tone = "red",
}: {
  title: string;
  value: unknown;
  marks?: Mark[];
  copyLabel: string;
  tone?: string;
}) {
  const lines = jsonLines(value);
  const text = JSON.stringify(value ?? null, null, 2);
  return (
    <EvidenceCard>
      <EvidenceHeader>
        <SectionTitle>{title}</SectionTitle>
        <CopyButton value={text} label={copyLabel} />
      </EvidenceHeader>
      <Divider />
      <BlockScroll>
        <JsonText
          aria-label={title}
          data-testid={`json-${copyLabel.replace(/\s+/g, "-")}`}
        >
          {lines.map((line, i) => {
            const hit = marks.some((m) => lineMatches(line, m.pointer, m.mode));
            return (
              <JsonLine
                key={i}
                data-pointer={line.pointer}
                data-highlight={hit ? "true" : undefined}
                bg={hit ? `var(--mantine-color-${tone}-light)` : undefined}
              >
                {line.text}
              </JsonLine>
            );
          })}
        </JsonText>
      </BlockScroll>
    </EvidenceCard>
  );
}

/** Show each finding once; keep complete call explanations and schema context. */
export function ConformanceRowDetail({
  detail,
  summary,
}: {
  detail: RowDetail;
  summary: string;
}) {
  if (detail.kind === "lint") {
    const findings = detail.findings.filter((f) => f.severity !== "info");
    const requiredFields = detail.findings
      .filter((f) => f.severity === "info" && f.schema === "outputSchema")
      .map((f) =>
        (f.path.split("/").pop() ?? "").replace(/~1/g, "/").replace(/~0/g, "~"),
      );
    const tone = findings.some((f) => f.severity === "error")
      ? "red"
      : "yellow";
    const toMarks = (pointers: string[]): Mark[] =>
      pointers.map((pointer) => ({ pointer, mode: "subtree" }));
    return (
      <Workspace data-testid="row-detail">
        <FindingsList>
          <SectionHeader>
            <SectionTitle>Schema findings</SectionTitle>
            <Badge color={findings.length ? tone : "green"}>
              {findings.length
                ? `${findings.length} finding${findings.length === 1 ? "" : "s"}`
                : "No issues"}
            </Badge>
          </SectionHeader>
          {findings.map((finding, i) => (
            <FindingCard key={i}>
              <FindingHeading>
                <Badge color={finding.severity === "error" ? "red" : "yellow"}>
                  {finding.severity === "error" ? "Error" : "Warning"}
                </Badge>
                <SectionTitle>{finding.schema}</SectionTitle>
                {finding.path && <FindingPath>{finding.path}</FindingPath>}
              </FindingHeading>
              <FindingMessage>{finding.message}</FindingMessage>
            </FindingCard>
          ))}
          {requiredFields.length > 0 && (
            <SummaryAlert color="blue" title="Required output fields">
              These fields must be present and cannot be null:{" "}
              {requiredFields.join(", ")}.
            </SummaryAlert>
          )}
          {!detail.outputSchema && (
            <SummaryAlert color="yellow" title="No output schema">
              Clients cannot validate this tool&apos;s results without an output
              schema.
            </SummaryAlert>
          )}
        </FindingsList>
        <FindingsList>
          <SectionHeader>
            <SectionTitle>Schemas</SectionTitle>
            {findings.length > 0 && (
              <SectionHint>
                Highlighted lines match the findings above
              </SectionHint>
            )}
          </SectionHeader>
          <EvidenceGrid>
            <JsonBlock
              title="Input schema"
              value={detail.inputSchema}
              marks={toMarks(detail.marks.inputSchema)}
              copyLabel="input schema"
              tone={tone}
            />
            <JsonBlock
              title="Structured schema (outputSchema)"
              value={detail.outputSchema}
              marks={toMarks(detail.marks.outputSchema)}
              copyLabel="schema"
              tone={tone}
            />
          </EvidenceGrid>
        </FindingsList>
      </Workspace>
    );
  }
  const resultMarks: Mark[] = detail.highlights
    .filter((h) => h.result !== null)
    .map((h) => ({ pointer: h.result as string, mode: h.resultMode }));
  const schemaMarks: Mark[] = detail.highlights
    .filter((h) => h.schema !== null)
    .map((h) => ({ pointer: h.schema as string, mode: "subtree" }));
  return (
    <Workspace data-testid="row-detail">
      <SummaryAlert
        color={detail.highlights.length || detail.error ? "red" : "blue"}
        title="Check result"
      >
        {summary}
      </SummaryAlert>
      <JsonBlock title="Args sent" value={detail.args} copyLabel="args" />
      <FindingsList>
        <SectionHeader>
          <SectionTitle>Response and schema</SectionTitle>
          {detail.highlights.length > 0 && (
            <SectionHint>
              Problem fields are highlighted in the JSON below
            </SectionHint>
          )}
        </SectionHeader>
        <EvidenceGrid>
          {detail.result ? (
            <JsonBlock
              title="Result"
              value={detail.result}
              marks={resultMarks}
              copyLabel="result"
            />
          ) : (
            <EvidenceCard>
              <EvidenceHeader>
                <SectionTitle>Result</SectionTitle>
              </EvidenceHeader>
              <Divider />
              <EmptyResult>
                No result: {detail.error ?? "the call did not return"}
              </EmptyResult>
            </EvidenceCard>
          )}
          <JsonBlock
            title="Structured schema (outputSchema)"
            value={detail.schema}
            marks={schemaMarks}
            copyLabel="schema"
          />
        </EvidenceGrid>
      </FindingsList>
    </Workspace>
  );
}
