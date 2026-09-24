# AI Billing Topology — Dynatrace App

A Dynatrace App that visualizes **AI Unit Billing for Agentic Invocations**. It shows how GenAI skill calls flow from client applications through workflows or conversations to individual tools, letting you identify cost drivers at a glance and drill into specific invocation events.

---

## What it does

The **AI Billing Topology** page reads `dt.system.events` for records with `event.kind == "GENAI_EVENT"` or `event.type == "GenAI Skill Invocation"` and renders them as a three-column Sankey chart:

```
Client Application  →  Workflow / Conversation  →  Tool (skill)
```

Flow width represents invocation count. Filters let you scope to a specific time range, acting user (`user.email`), or client application. Clicking any Workflow/Conversation ID in the breakdown table opens a full event detail viewer below showing every field on the raw events.

---

## Project structure

```
app.config.json          App metadata: name, ID, version, scopes, target environment URL
package.json             npm scripts and dependencies
eslint.config.mjs        ESLint flat config — enforces subcategory Strato imports, no-secrets, no-eval

ui/
  main.tsx               React entry point — mounts <AppRoot> (handles theme/font globally)
  tsconfig.json          TypeScript config for UI code
  declarations.d.ts      Static asset type declarations (SVG, PNG)

  app/
    App.tsx              Router setup — three routes: /, /data, /billing
    components/
      Header.tsx         Top navigation bar with links to all routes
      Card.tsx           Reusable card component used on the home page
    pages/
      Home.tsx           Landing page with links to Explore Data and external docs
      Data.tsx           DQL sandbox: editable query + TimeseriesChart
      Billing.tsx        AI Billing Topology page (the main feature)

  assets/                Static images and SVGs bundled with the app
```

### Key dependencies

| Package | Role |
|---|---|
| `@dynatrace-sdk/react-hooks` | `useDql` hook — all data fetching |
| `@dynatrace/strato-components` | Strato Design System (charts, tables, forms, layouts) |
| `@dynatrace/strato-design-tokens` | Brand color tokens |
| `@dynatrace/strato-icons` | Icon library |

---

## Running locally

```bash
npm install
npm run start      # dev server with hot reload, opens browser automatically
npm run lint       # ESLint check (must pass before deploying)
npm run build      # production bundle into dist/
npm run deploy     # build + deploy to the environment in app.config.json
```

---

## Billing.tsx — architecture

The page is structured as:

1. **Hero banner** — gradient header with title and description
2. **Filter bar** (`Surface`) — `TimeframeSelector`, multi-select searchable user dropdown, multi-select searchable client application dropdown
3. **Sankey chart** (`Surface`) — three-column topology with branded color palette
4. **Invocation breakdown** (`DataTable`) — aggregated rows; Workflow/Conversation ID cells are clickable
5. **Event detail viewer** — mounts only when a row is clicked; runs a second `useDql` query for that specific ID and renders all returned fields in a horizontally scrollable, line-wrapped table

### DQL field mapping

| Concept | DQL field |
|---|---|
| Client application | `client.application_context` |
| Workflow ID | `workflow.id` |
| Conversation ID | `conversation_id` |
| Tool / skill | `skill` |
| Acting user | `user.email` |

Fields containing dots require backtick quoting in DQL: `` `client.application_context` ``.

Workflow and conversation are unified with `coalesce(`workflow.id`, conversation_id)` → labelled "Workflow / Conversation".

---

## Trials and errors

Getting here required working through several non-obvious constraints in DQL, the Strato component API, and the AppEngine permission model. What follows is a record of what failed and why, to save the next person the same debugging time.

### 1. Wrong storage scope

The first attempt used `storage:events:read` as the app scope. This was wrong — `dt.system.events` is a system table, not a log or event bucket. The correct scope is `storage:system:read`.

**Fix:** `app.config.json` → `{ "name": "storage:system:read" }`.

### 2. Quoted relative timestamps in DQL

DQL's `from:` and `to:` clauses treat quoted strings as ISO 8601 timestamps. Writing `from: "now()-30d"` produced an `INVALID_TIMESTAMP` error because `"now()-30d"` is not a valid ISO date — it's a relative expression.

```dql
-- Wrong
fetch dt.system.events, from: "now()-30d"

-- Right
fetch dt.system.events, from: now()-30d
```

ISO timestamps (from a `Timeframe` selector) must be quoted; relative expressions must not. The dynamic query builder handles both cases explicitly.

### 3. `summarize` requires an aggregation function

DQL's `summarize` command always needs at least one aggregation. Writing `summarize by: { user = \`user.email\` }` produced a `TOO_FEW_PARAMETERS` error.

The pattern for getting a distinct list of values is:

```dql
| summarize count(), by: { user = `user.email` }
| fields user
| filter isNotNull(user)
```

The `count()` is discarded by the subsequent `fields` command, leaving only the distinct values.

### 4. No data from `user.id`

Early queries filtered and grouped by `user.id`. The field existed but returned no data in this environment. The correct field carrying the acting user's identity is `user.email`.

**Discovery method:** A diagnostic query with `summarize count(), by: { k = ... }` for each candidate field, surfaced using a temporary key-display component in the UI.

### 5. Select dropdowns showing nothing

The `Select` component from `@dynatrace/strato-components/forms` requires options to be wrapped in `<Select.Content>`. Options rendered as direct children of `<Select>` are silently ignored. The fix was:

```tsx
<Select multiple value={...} onChange={...}>
  <Select.Filter />         {/* searchable */}
  <Select.Content>          {/* required wrapper */}
    {records.map((r) => (
      <Select.Option key={r} value={r}>{r}</Select.Option>
    ))}
  </Select.Content>
</Select>
```

`Select` does not accept `placeholder` or `loading` props — both cause type errors.

### 6. No native Sankey/topology component

Strato's public chart API (`TimeseriesChart`, `PieChart`, etc.) has no Sankey or flow diagram. The internal `_SankeyChart` component (exported with a leading underscore to signal it is not part of the stable public API) was the only available option that could represent directed multi-layer flows.

It accepts a `colorPalette` prop that takes either a named palette string or a `string[]` of hex values, which is how the Dynatrace brand color palette is applied.

### 7. `SankeyEdge` / `SankeyNode` type incompatibility

`_SankeyChart` expects `ChartData` for both `data` and `nodes`. `ChartData` is `Record<string, unknown>[]`. Custom typed objects like `{ source: string; target: string; value: number }` are not directly assignable to `Record<string, unknown>` in TypeScript without an index signature.

**Fix:** Define the types as intersections with `Record<string, unknown>`:

```ts
type SankeyEdge = Record<string, unknown> & { source: string; target: string; value: number };
type SankeyNode = Record<string, unknown> & { id: string; label: string; col: number };
```

### 8. Timeframe type import location

`Timeframe` is not exported from `@dynatrace/strato-components/filters` (where `TimeframeSelector` lives). It must be imported from:

```ts
import type { Timeframe } from "@dynatrace/strato-components/core";
```

### 9. Linting: `@typescript-eslint/no-base-to-string`

DQL records come back as `Record<string, unknown>`. Calling `String(row[key])` directly triggers `no-base-to-string` because the value could be an object type where `toString()` would produce `[object Object]`. The fix is a typed record alias and a narrow helper:

```ts
type DqlRecord = Record<string, string | number | boolean | null | undefined>;

function str(val: string | number | boolean | null | undefined, fallback = ""): string {
  if (val == null) return fallback;
  return String(val);
}
```

### 10. Node ID collisions in the Sankey graph

Without prefixing, a workflow ID and a client application name could be identical strings, causing the Sankey layout to merge unrelated nodes. All non-app-layer node IDs are prefixed:

```ts
const ctxId  = `ctx:${ctx}`;
const toolId = `tool:${tool}`;
```

The `label` accessor strips the prefix for display; the `id` accessor keeps it for graph topology.

### 11. Event detail table — column width

The first implementation used `table-layout: auto` (the Strato default), causing each dynamic column to be squeezed to a few characters wide when there were 20+ columns. The fix is a fixed pixel width per column (`width: 220`) combined with a horizontal scroll container:

```tsx
<div style={{ overflowX: "auto" }}>
  <DataTable data={records} columns={columns} lineWrap />
</div>
```

`lineWrap` wraps cell content rather than truncating it, which matters for long event payloads.

---

## Deployment

The target environment is configured in `app.config.json` (`environmentUrl`). You need to add your target environment before Deploy. Deploy with:

```bash
npm run deploy
```

The app requires the `storage:system:read` scope to be approved in the target environment's app permissions.
