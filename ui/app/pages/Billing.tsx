import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { _SankeyChart } from "@dynatrace/strato-components/charts";
import type { Timeframe } from "@dynatrace/strato-components/core";
import { TimeframeSelector } from "@dynatrace/strato-components/filters";
import { Select } from "@dynatrace/strato-components/forms";
import { Flex, Surface } from "@dynatrace/strato-components/layouts";
import { DataTable } from "@dynatrace/strato-components/tables";
import { Heading, Paragraph } from "@dynatrace/strato-components/typography";
import { Button, InlineButton } from "@dynatrace/strato-components/buttons";
import { useDql } from "@dynatrace-sdk/react-hooks";

// ---------------------------------------------------------------------------
// DQL field name constants — update here if event schema changes
// ---------------------------------------------------------------------------
const CLIENT_APP_FIELD = "client.application_context";
const WORKFLOW_FIELD = "workflow.id";
const CONVERSATION_FIELD = "conversation_id";
const SKILL_FIELD = "skill";
const USER_FIELD = "user.email";

// ---------------------------------------------------------------------------
// Static queries (30-day window) for populating filter dropdowns
// ---------------------------------------------------------------------------
const USER_LIST_QUERY = `fetch dt.system.events, from: now()-30d
| filter event.kind == "GENAI_EVENT" OR event.type == "GenAI Skill Invocation"
| summarize count(), by: { user = \`${USER_FIELD}\` }
| fields user
| filter isNotNull(user)
| sort user asc`;

const APP_LIST_QUERY = `fetch dt.system.events, from: now()-30d
| filter event.kind == "GENAI_EVENT" OR event.type == "GenAI Skill Invocation"
| summarize count(), by: { clientApp = \`${CLIENT_APP_FIELD}\` }
| fields clientApp
| filter isNotNull(clientApp)
| sort clientApp asc`;

// ---------------------------------------------------------------------------
// Type-safe string coercion for DQL record fields
// ---------------------------------------------------------------------------
type DqlRecord = Record<string, string | number | boolean | null | undefined>;

function str(val: string | number | boolean | null | undefined, fallback = ""): string {
  if (val == null) return fallback;
  return String(val);
}

// ---------------------------------------------------------------------------
// SankeyChart data transformation
// ---------------------------------------------------------------------------
type SankeyEdge = Record<string, unknown> & {
  source: string;
  target: string;
  value: number;
};

type SankeyNode = Record<string, unknown> & {
  id: string;
  label: string;
  col: number;
};

function toSankeyData(records: DqlRecord[]): {
  edges: SankeyEdge[];
  nodes: SankeyNode[];
} {
  const edges: SankeyEdge[] = [];
  const nodeMap = new Map<string, SankeyNode>();

  for (const row of records) {
    const app = str(row["clientApp"], "Unknown App");
    const ctx = str(row["context"], "Unknown Workflow");
    const tool = str(row["skill"], "Unknown Tool");
    const count = Number(row["invocations"] ?? 0);

    if (count <= 0) continue;

    const ctxId = `ctx:${ctx}`;
    const toolId = `tool:${tool}`;

    edges.push({ source: app, target: ctxId, value: count });
    edges.push({ source: ctxId, target: toolId, value: count });

    if (!nodeMap.has(app)) nodeMap.set(app, { id: app, label: app, col: 0 });
    if (!nodeMap.has(ctxId)) nodeMap.set(ctxId, { id: ctxId, label: ctx, col: 1 });
    if (!nodeMap.has(toolId)) nodeMap.set(toolId, { id: toolId, label: tool, col: 2 });
  }

  return { edges, nodes: Array.from(nodeMap.values()) };
}

// ---------------------------------------------------------------------------
// Context detail viewer — mounts only when a context is selected so the
// useDql call only fires when there is something to show.
// Columns are derived dynamically from whatever fields the query returns.
// ---------------------------------------------------------------------------
interface ContextDetailProps {
  context: string;
  timeframe: Timeframe | null;
}

const ContextDetail = ({ context, timeframe }: ContextDetailProps) => {
  const detailQuery = useMemo(() => {
    const from = timeframe ? `"${timeframe.from.absoluteDate}"` : `now()-2h`;
    const to = timeframe ? `"${timeframe.to.absoluteDate}"` : `now()`;
    return `fetch dt.system.events, from: ${from}, to: ${to}
| filter event.kind == "GENAI_EVENT" OR event.type == "GenAI Skill Invocation"
| filter coalesce(\`${WORKFLOW_FIELD}\`, ${CONVERSATION_FIELD}) == "${context}"
| sort timestamp desc`;
  }, [context, timeframe]);

  const { data, isLoading, error } = useDql({ query: detailQuery });

  const records = useMemo(() => (data?.records ?? []) as DqlRecord[], [data]);

  const columns = useMemo(() => {
    const keys = Object.keys(records[0] ?? {});
    return keys.map((key) => ({
      id: key,
      header: key,
      accessor: (row: DqlRecord) => str(row[key]),
      width: 220,
    }));
  }, [records]);

  if (error) {
    return <Paragraph style={{ color: "red" }}>{error.message}</Paragraph>;
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <DataTable data={records} columns={columns} loading={isLoading} lineWrap />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------
export const Billing = () => {
  const [timeframe, setTimeframe] = useState<Timeframe | null>(null);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [selectedApps, setSelectedApps] = useState<string[]>([]);
  const [selectedContext, setSelectedContext] = useState<string | null>(null);

  const detailRef = useRef<HTMLDivElement>(null);

  // Scroll detail panel into view when a context is selected
  useEffect(() => {
    if (selectedContext && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selectedContext]);

  const { data: userData, error: userError } = useDql({ query: USER_LIST_QUERY });
  const { data: appData, error: appError } = useDql({ query: APP_LIST_QUERY });

  const topologyQuery = useMemo(() => {
    const from = timeframe ? `"${timeframe.from.absoluteDate}"` : `now()-2h`;
    const to = timeframe ? `"${timeframe.to.absoluteDate}"` : `now()`;

    const userClause =
      selectedUsers.length > 0
        ? `| filter in(\`${USER_FIELD}\`, ${selectedUsers.map((u) => `"${u}"`).join(", ")})\n`
        : "";

    const appClause =
      selectedApps.length > 0
        ? `| filter in(\`${CLIENT_APP_FIELD}\`, ${selectedApps.map((a) => `"${a}"`).join(", ")})\n`
        : "";

    return `fetch dt.system.events, from: ${from}, to: ${to}
| filter event.kind == "GENAI_EVENT" OR event.type == "GenAI Skill Invocation"
${userClause}${appClause}| summarize invocations = count(),
            by: {
              userEmail = \`${USER_FIELD}\`,
              clientApp = \`${CLIENT_APP_FIELD}\`,
              context   = coalesce(\`${WORKFLOW_FIELD}\`, ${CONVERSATION_FIELD}),
              skill     = ${SKILL_FIELD}
            }
| filter isNotNull(clientApp) AND isNotNull(skill)`;
  }, [timeframe, selectedUsers, selectedApps]);

  const { data: topoData, isLoading, error } = useDql({ query: topologyQuery });

  const { edges: sankeyEdges, nodes: sankeyNodes } = useMemo(() => {
    const records = (topoData?.records ?? []) as DqlRecord[];
    return toSankeyData(records);
  }, [topoData]);

  const tableRecords = useMemo(
    () => (topoData?.records ?? []) as DqlRecord[],
    [topoData],
  );

  const userRecords = useMemo(
    () => (userData?.records ?? []) as DqlRecord[],
    [userData],
  );
  const appRecords = useMemo(
    () => (appData?.records ?? []) as DqlRecord[],
    [appData],
  );

  // Breakdown columns — context cell is clickable to open the detail viewer
  const onContextClick = useCallback(
    (ctx: string) => setSelectedContext((prev) => (prev === ctx ? null : ctx)),
    [],
  );

  const breakdownColumns = useMemo(
    () => [
      {
        id: "userEmail",
        header: "User",
        accessor: (row: DqlRecord) => str(row["userEmail"]),
      },
      {
        id: "clientApp",
        header: "Client Application",
        accessor: (row: DqlRecord) => str(row["clientApp"]),
      },
      {
        id: "context",
        header: "Workflow / Conversation",
        accessor: (row: DqlRecord) => str(row["context"]),
        cell: ({ value }: { value: string }) => (
          <InlineButton onClick={() => onContextClick(value)}>
            {value}
          </InlineButton>
        ),
      },
      {
        id: "skill",
        header: "Tool (skill)",
        accessor: (row: DqlRecord) => str(row["skill"]),
      },
      {
        id: "invocations",
        header: "Invocations",
        accessor: (row: DqlRecord) => Number(row["invocations"] ?? 0),
      },
    ],
    [onContextClick],
  );

  return (
    <Flex flexDirection="column" gap={16} padding={24}>
      <div
        style={{
          background: "linear-gradient(135deg, #2d2e4e 0%, #474fcf 100%)",
          borderRadius: 8,
          padding: "28px 32px",
        }}
      >
        <Heading level={2} style={{ color: "#ffffff", marginBottom: 8 }}>
          AI Billing Topology
        </Heading>
        <Paragraph style={{ color: "rgba(255,255,255,0.8)" }}>
          Visualize GenAI skill invocations by client application, workflow or
          conversation, and tool. Filter by user or app to drill into specific
          cost drivers.
        </Paragraph>
      </div>

      {/* Filter bar */}
      <Surface>
        <Flex gap={16} alignItems="flex-end" padding={16} flexWrap="wrap">
          <Flex flexDirection="column" gap={4}>
            <Paragraph>Time range</Paragraph>
            <TimeframeSelector value={timeframe} onChange={setTimeframe} />
          </Flex>

          <Flex flexDirection="column" gap={4}>
            <Paragraph>Acting user</Paragraph>
            <Select<string, true>
              multiple={true}
              value={selectedUsers}
              onChange={(val) => setSelectedUsers(val ?? [])}
            >
              <Select.Filter />
              <Select.Content>
                {userRecords.map((u) => {
                  const user = str(u["user"]);
                  return (
                    <Select.Option key={user} value={user}>
                      {user}
                    </Select.Option>
                  );
                })}
              </Select.Content>
            </Select>
            {userError && (
              <Paragraph style={{ color: "red", fontSize: 12 }}>
                {userError.message}
              </Paragraph>
            )}
          </Flex>

          <Flex flexDirection="column" gap={4}>
            <Paragraph>Client application</Paragraph>
            <Select<string, true>
              multiple={true}
              value={selectedApps}
              onChange={(val) => setSelectedApps(val ?? [])}
            >
              <Select.Filter />
              <Select.Content>
                {appRecords.map((a) => {
                  const app = str(a["clientApp"]);
                  return (
                    <Select.Option key={app} value={app}>
                      {app}
                    </Select.Option>
                  );
                })}
              </Select.Content>
            </Select>
            {appError && (
              <Paragraph style={{ color: "red", fontSize: 12 }}>
                {appError.message}
              </Paragraph>
            )}
          </Flex>
        </Flex>
      </Surface>

      {/* Topology chart */}
      <Surface style={{ overflow: "hidden" }}>
        <div
          style={{
            background: "linear-gradient(135deg, #2d2e4e 0%, #474fcf 100%)",
            padding: "16px 20px",
          }}
        >
          <Heading level={3} style={{ color: "#ffffff" }}>
            Invocation Topology
          </Heading>
          <Paragraph style={{ color: "rgba(255,255,255,0.75)", fontSize: 13, marginTop: 4 }}>
            Flow width represents invocation count. Client Application → Workflow / Conversation → Tool.
          </Paragraph>
        </div>
        <Flex flexDirection="column" padding={16} gap={8}>
          <_SankeyChart
            data={sankeyEdges}
            sourceAccessor="source"
            targetAccessor="target"
            valueAccessor="value"
            nodes={sankeyNodes}
            nodeIdAccessor="id"
            nodeLabelAccessor="label"
            columnAccessor="col"
            columnLabels={{
              0: "Client Application",
              1: "Workflow / Conversation",
              2: "Tool",
            }}
            colorPalette={[
              "#474fcf",
              "#6875e0",
              "#2d2e4e",
              "#3d43a8",
              "#9099f0",
              "#1a9bde",
              "#00b4a6",
              "#7b82e8",
            ]}
            loading={isLoading}
            height={480}
          >
            <_SankeyChart.EmptyState>
              No GenAI invocation events found for this time range and filters.
              Verify that events exist in dt.system.events with event.kind ==
              &quot;GENAI_EVENT&quot;.
            </_SankeyChart.EmptyState>
            <_SankeyChart.ErrorState>
              {error?.message ?? "Failed to load billing data."}
            </_SankeyChart.ErrorState>
          </_SankeyChart>
        </Flex>
      </Surface>

      {/* Invocation breakdown — context cells are clickable */}
      <Surface>
        <Flex flexDirection="column" padding={16} gap={8}>
          <div style={{ borderLeft: "3px solid #474fcf", paddingLeft: 10 }}>
            <Heading level={3}>Invocation Breakdown</Heading>
          </div>
          <Paragraph style={{ opacity: 0.7, fontSize: 13 }}>
            Click a Workflow / Conversation ID to inspect its individual events below.
          </Paragraph>
          <DataTable
            data={tableRecords}
            columns={breakdownColumns}
            loading={isLoading}
          />
        </Flex>
      </Surface>

      {/* Context detail viewer — only rendered when a context is selected */}
      {selectedContext && (
        <Surface ref={detailRef}>
          <Flex flexDirection="column" padding={16} gap={8}>
            <Flex justifyContent="space-between" alignItems="center">
              <Flex flexDirection="column" gap={2}>
                <div style={{ borderLeft: "3px solid #474fcf", paddingLeft: 10 }}>
                  <Heading level={3}>Event Detail</Heading>
                </div>
                <Paragraph style={{ opacity: 0.7, fontSize: 13 }}>
                  {selectedContext}
                </Paragraph>
              </Flex>
              <Button
                variant="emphasized"
                onClick={() => setSelectedContext(null)}
              >
                Close
              </Button>
            </Flex>
            <ContextDetail context={selectedContext} timeframe={timeframe} />
          </Flex>
        </Surface>
      )}
    </Flex>
  );
};
