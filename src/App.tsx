import { useEffect, useMemo, useState } from "react";
import { DndContext, type DragEndEvent, useDraggable, useDroppable } from "@dnd-kit/core";
import { dbExecute, dbQuery } from "./lib/db";
import { ENUMS, TABLES, type ColumnConfig, type TableKey } from "./lib/schema";
import "./App.css";

type ViewKey = "spreadsheet" | "kanban";

type EditState = {
  table: TableKey;
  row: Record<string, unknown>;
  isNew: boolean;
};

const TABLE_KEYS: TableKey[] = [
  "gig_platforms",
  "job_applications",
  "contracting_platforms",
];

const INT_COLUMNS = new Set([
  "id",
  "platform_id",
  "connects_spent",
  "connects_balance",
  "connects_per_proposal",
]);

function loadColumnOrder(table: TableKey): string[] {
  const stored = localStorage.getItem(`pipeline-ui:columnOrder:${table}`);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as string[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      return TABLES[table].columns.map((column) => column.key);
    }
  }
  return TABLES[table].columns.map((column) => column.key);
}

function saveColumnOrder(table: TableKey, order: string[]) {
  localStorage.setItem(`pipeline-ui:columnOrder:${table}`, JSON.stringify(order));
}

function normalizeRow(table: TableKey, row: Record<string, unknown>) {
  const normalized: Record<string, unknown> = { ...row };
  TABLES[table].columns.forEach((column) => {
    if (INT_COLUMNS.has(column.key)) {
      const raw = row[column.key];
      if (raw === null || raw === undefined || raw === "") {
        normalized[column.key] = null;
      } else {
        const parsed = Number(raw);
        normalized[column.key] = Number.isNaN(parsed) ? raw : parsed;
      }
    }
  });
  return normalized;
}

function sqlValue(value: unknown, column: ColumnConfig): string {
  if (value === null || value === undefined || value === "") {
    return "NULL";
  }
  if (column.type === "int") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? "NULL" : String(parsed);
  }
  const text = String(value).replace(/'/g, "''");
  return `'${text}'`;
}

function buildInsertSql(table: TableKey, draft: Record<string, unknown>) {
  const columns = TABLES[table].columns.filter(
    (column) => column.editable && column.key !== "id",
  );
  const names = columns.map((column) => column.key).join(", ");
  const values = columns
    .map((column) => sqlValue(draft[column.key], column))
    .join(", ");
  return `insert into ${table} (${names}) values (${values});`;
}

function buildUpdateSql(table: TableKey, draft: Record<string, unknown>) {
  const columns = TABLES[table].columns.filter(
    (column) => column.editable && column.key !== "id",
  );
  const sets = columns
    .map((column) => `${column.key} = ${sqlValue(draft[column.key], column)}`)
    .join(", ");
  return `update ${table} set ${sets} where id = ${Number(draft.id)};`;
}

type DragCardData = {
  table: TableKey;
  id: number;
};

function KanbanColumn({
  table,
  status,
  onAdd,
  children,
}: {
  table: TableKey;
  status: string;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${table}:${status}`,
    data: { status },
  });

  return (
    <div ref={setNodeRef} className={`kanban-column${isOver ? " over" : ""}`}>
      <div className="kanban-header">
        <h3>{status}</h3>
        <button className="ghost" onClick={onAdd}>
          Add
        </button>
      </div>
      <div className="kanban-cards">{children}</div>
    </div>
  );
}

function KanbanCard({
  table,
  id,
  onOpen,
  children,
}: {
  table: TableKey;
  id: number;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `card:${table}:${id}`,
    data: { table, id } satisfies DragCardData,
  });

  const style = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    opacity: isDragging ? 0.55 : 1,
  } as React.CSSProperties;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`card${isDragging ? " dragging" : ""}`}
      onClick={onOpen}
      {...listeners}
      {...attributes}
    >
      {children}
    </div>
  );
}

function App() {
  const [activeView, setActiveView] = useState<ViewKey>("spreadsheet");
  const [activeTable, setActiveTable] = useState<TableKey>("gig_platforms");
  const [dbOnline, setDbOnline] = useState(true);
  const [data, setData] = useState<Record<TableKey, Record<string, unknown>[]>>({
    gig_platforms: [],
    job_applications: [],
    contracting_platforms: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortState, setSortState] = useState<{ key: string; dir: "asc" | "desc" } | null>(
    null,
  );
  const [columnOrder, setColumnOrder] = useState<Record<TableKey, string[]>>({
    gig_platforms: loadColumnOrder("gig_platforms"),
    job_applications: loadColumnOrder("job_applications"),
    contracting_platforms: loadColumnOrder("contracting_platforms"),
  });
  const [filters, setFilters] = useState<
    Record<TableKey, Record<string, Set<string>>>
  >({
    gig_platforms: { status: new Set<string>() },
    job_applications: {
      stage: new Set<string>(),
      engagement_type: new Set<string>(),
      outcome: new Set<string>(),
    },
    contracting_platforms: { status: new Set<string>() },
  });
  const [editing, setEditing] = useState<EditState | null>(null);

  async function loadTable(table: TableKey) {
    const rows = (await dbQuery<Record<string, unknown>[]>(
      `select * from ${table} order by id desc;`,
    )) as Record<string, unknown>[];
    const normalized = rows.map((row) => normalizeRow(table, row));
    setData((prev) => ({ ...prev, [table]: normalized }));
  }

  async function refreshAll() {
    setLoading(true);
    setError(null);
    try {
      await Promise.all(TABLE_KEYS.map((table) => loadTable(table)));
      setDbOnline(true);
    } catch (err) {
      setDbOnline(false);
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshAll();
  }, []);

  useEffect(() => {
    saveColumnOrder(activeTable, columnOrder[activeTable]);
  }, [activeTable, columnOrder]);

  const activeConfig = TABLES[activeTable];
  const orderedColumns = columnOrder[activeTable]
    .map((key) => activeConfig.columns.find((column) => column.key === key))
    .filter(Boolean) as ColumnConfig[];

  const filteredRows = useMemo(() => {
    let rows = [...data[activeTable]];
    const tableFilters = filters[activeTable];
    Object.entries(tableFilters).forEach(([field, values]) => {
      if (values.size > 0) {
        rows = rows.filter((row) => values.has(String(row[field])));
      }
    });
    if (sortState) {
      rows.sort((a, b) => {
        const left = a[sortState.key];
        const right = b[sortState.key];
        if (left === null || left === undefined) return 1;
        if (right === null || right === undefined) return -1;
        if (typeof left === "number" && typeof right === "number") {
          return sortState.dir === "asc" ? left - right : right - left;
        }
        return sortState.dir === "asc"
          ? String(left).localeCompare(String(right))
          : String(right).localeCompare(String(left));
      });
    }
    return rows;
  }, [activeTable, data, filters, sortState]);

  function toggleSort(key: string) {
    setSortState((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }

  function handleHeaderDrop(fromKey: string, toKey: string) {
    if (fromKey === toKey) return;
    setColumnOrder((prev) => {
      const next = [...prev[activeTable]];
      const fromIndex = next.indexOf(fromKey);
      const toIndex = next.indexOf(toKey);
      if (fromIndex === -1 || toIndex === -1) return prev;
      next.splice(fromIndex, 1);
      next.splice(toIndex, 0, fromKey);
      return { ...prev, [activeTable]: next };
    });
  }

  function toggleFilter(table: TableKey, field: string, value: string) {
    setFilters((prev) => {
      const tableFilters = { ...prev[table] };
      const set = new Set(tableFilters[field]);
      if (set.has(value)) {
        set.delete(value);
      } else {
        set.add(value);
      }
      tableFilters[field] = set;
      return { ...prev, [table]: tableFilters };
    });
  }

  function startNewRow(table: TableKey, preset?: Record<string, unknown>) {
    const emptyRow: Record<string, unknown> = { id: null };
    TABLES[table].columns.forEach((column) => {
      if (column.key !== "id") emptyRow[column.key] = null;
    });
    setEditing({
      table,
      row: { ...emptyRow, ...preset },
      isNew: true,
    });
  }

  async function saveRow(edit: EditState) {
    setLoading(true);
    setError(null);
    try {
      if (edit.isNew) {
        await dbExecute(buildInsertSql(edit.table, edit.row));
      } else {
        await dbExecute(buildUpdateSql(edit.table, edit.row));
      }
      await loadTable(edit.table);
      setEditing(null);
      setDbOnline(true);
    } catch (err) {
      setDbOnline(false);
      setError(err instanceof Error ? err.message : "Failed to save row");
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(table: TableKey, id: number, statusValue: string) {
    setLoading(true);
    try {
      const statusField = TABLES[table].statusField;
      await dbExecute(
        `update ${table} set ${statusField} = '${statusValue.replace(/'/g, "''")}' where id = ${id};`,
      );
      await loadTable(table);
      setDbOnline(true);
    } catch (err) {
      setDbOnline(false);
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setLoading(false);
    }
  }

  function handleKanbanDragEnd(event: DragEndEvent) {
    const activeData = event.active.data.current as DragCardData | undefined;
    const status = event.over?.data.current?.status as string | undefined;
    if (!activeData || !status) return;
    if (activeData.table === activeTable) {
      updateStatus(activeTable, activeData.id, status);
    }
  }

  return (
    <div className="app">
      <header className="top-bar">
        <div>
          <div className="eyebrow">Pipeline UI</div>
          <h1>Solo Pipeline Tracker</h1>
          <p className="subtitle">Local Postgres control room for gigs, jobs, and contracts.</p>
        </div>
        <div className="view-toggle">
          <button
            className={activeView === "spreadsheet" ? "active" : ""}
            onClick={() => setActiveView("spreadsheet")}
          >
            Spreadsheet
          </button>
          <button
            className={activeView === "kanban" ? "active" : ""}
            onClick={() => setActiveView("kanban")}
          >
            Kanban
          </button>
        </div>
      </header>

      {!dbOnline && (
        <div className="banner">
          <div>
            <strong>Database offline.</strong> Check Postgres.app and retry.
          </div>
          <button onClick={refreshAll}>Retry</button>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <section className="panel">
        <div className="panel-header">
          <div className="table-toggle">
            {TABLE_KEYS.map((table) => (
              <button
                key={table}
                className={activeTable === table ? "active" : ""}
                onClick={() => {
                  setActiveTable(table);
                  setSortState(null);
                }}
              >
                {TABLES[table].label}
              </button>
            ))}
          </div>
          <div className="panel-actions">
            <button onClick={() => startNewRow(activeTable)}>New Row</button>
            <button className="ghost" onClick={refreshAll} disabled={loading}>
              Refresh
            </button>
          </div>
        </div>

        {activeView === "spreadsheet" && (
          <div className="spreadsheet">
            <div className="filters">
              {activeConfig.filters.map((filter) => (
                <div key={filter.field} className="filter-group">
                  <span className="filter-label">{filter.field}</span>
                  <div className="chip-row">
                    {ENUMS[filter.enumKey].map((value) => (
                      <button
                        key={value}
                        className={
                          filters[activeTable][filter.field]?.has(value)
                            ? "chip active"
                            : "chip"
                        }
                        onClick={() => toggleFilter(activeTable, filter.field, value)}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {orderedColumns.map((column) => (
                      <th
                        key={column.key}
                        draggable
                        onDragStart={(event) =>
                          event.dataTransfer.setData("text/plain", column.key)
                        }
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          const fromKey = event.dataTransfer.getData("text/plain");
                          handleHeaderDrop(fromKey, column.key);
                        }}
                        onClick={() => toggleSort(column.key)}
                      >
                        <span>{column.label}</span>
                        {sortState?.key === column.key && (
                          <span className="sort-indicator">
                            {sortState.dir === "asc" ? "▲" : "▼"}
                          </span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr
                      key={String(row.id)}
                      onClick={() =>
                        setEditing({
                          table: activeTable,
                          row: row as Record<string, unknown>,
                          isNew: false,
                        })
                      }
                    >
                      {orderedColumns.map((column) => (
                        <td key={column.key}>{String(row[column.key] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeView === "kanban" && (
          <DndContext onDragEnd={handleKanbanDragEnd}>
            <div className="kanban">
              {ENUMS[activeConfig.filters[0].enumKey].map((status) => (
                <KanbanColumn
                  key={status}
                  table={activeTable}
                  status={status}
                  onAdd={() =>
                    startNewRow(activeTable, { [activeConfig.statusField]: status })
                  }
                >
                  {data[activeTable]
                    .filter((row) => row[activeConfig.statusField] === status)
                    .map((row) => (
                      <KanbanCard
                        key={String(row.id)}
                        table={activeTable}
                        id={Number(row.id)}
                        onOpen={() =>
                          setEditing({
                            table: activeTable,
                            row: row as Record<string, unknown>,
                            isNew: false,
                          })
                        }
                      >
                        {activeTable === "gig_platforms" && (
                          <>
                            <div className="card-title">{String(row.name ?? "")}</div>
                            <div className="card-meta">{String(row.next_action ?? "")}</div>
                            <div className="card-meta">{String(row.next_action_at ?? "")}</div>
                          </>
                        )}
                        {activeTable === "job_applications" && (
                          <>
                            <div className="card-title">{String(row.role_title ?? "")}</div>
                            <div className="card-meta">{String(row.company ?? "")}</div>
                            <div className="card-meta">{String(row.rate_or_salary ?? "")}</div>
                            <div className="card-meta">{String(row.outcome ?? "")}</div>
                            <div className="card-meta">{String(row.next_action_at ?? "")}</div>
                          </>
                        )}
                        {activeTable === "contracting_platforms" && (
                          <>
                            <div className="card-title">{String(row.name ?? "")}</div>
                            <div className="card-meta">{String(row.current_rate ?? "")}</div>
                            <div className="card-meta">{String(row.connects_balance ?? "")}</div>
                            <div className="card-meta">{String(row.next_action ?? "")}</div>
                          </>
                        )}
                      </KanbanCard>
                    ))}
                </KanbanColumn>
              ))}
            </div>
          </DndContext>
        )}
      </section>

      {editing && (
        <EditModal
          editState={editing}
          onClose={() => setEditing(null)}
          onSave={saveRow}
        />
      )}
    </div>
  );
}

function EditModal({
  editState,
  onClose,
  onSave,
}: {
  editState: EditState;
  onClose: () => void;
  onSave: (edit: EditState) => void;
}) {
  const { table, row, isNew } = editState;
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...row });

  function updateField(key: string, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">{TABLES[table].label}</div>
            <h2>{isNew ? "New Entry" : "Edit Entry"}</h2>
          </div>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modal-body">
          {TABLES[table].columns.map((column) => {
            const value = draft[column.key] ?? "";
            const disabled = !column.editable;
            return (
              <label key={column.key} className={disabled ? "field disabled" : "field"}>
                <span>{column.label}</span>
                {column.type === "enum" && column.enumKey ? (
                  <select
                    value={String(value ?? "")}
                    onChange={(event) => updateField(column.key, event.target.value)}
                    disabled={disabled}
                  >
                    <option value="">Select</option>
                    {ENUMS[column.enumKey].map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : column.type === "date" ? (
                  <input
                    type="date"
                    value={String(value ?? "").slice(0, 10)}
                    onChange={(event) => updateField(column.key, event.target.value)}
                    disabled={disabled}
                  />
                ) : column.type === "int" ? (
                  <input
                    type="number"
                    value={String(value ?? "")}
                    onChange={(event) => updateField(column.key, event.target.value)}
                    disabled={disabled}
                  />
                ) : (
                  <input
                    type="text"
                    value={String(value ?? "")}
                    onChange={(event) => updateField(column.key, event.target.value)}
                    disabled={disabled}
                  />
                )}
              </label>
            );
          })}
        </div>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button onClick={() => onSave({ table, row: draft, isNew })}>Save</button>
        </div>
      </div>
    </div>
  );
}

export default App;
