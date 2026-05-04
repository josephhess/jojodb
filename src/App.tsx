import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable } from "@dnd-kit/sortable";
import { dbExecute, dbQuery } from "./lib/db";
import { ENUMS, TABLES, type ColumnConfig, type TableKey } from "./lib/schema";
import "./App.css";

type ViewKey = "spreadsheet" | "kanban";

type EditState = {
  table: TableKey;
  row: Record<string, unknown>;
  isNew: boolean;
};

const TABLE_KEYS = Object.keys(TABLES) as TableKey[];

const INT_COLUMNS = new Set(
  TABLE_KEYS.flatMap((table) =>
    TABLES[table].columns
      .filter((column) => column.type === "int" || column.type === "fk")
      .map((column) => column.key),
  ),
);

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
  if (column.type === "int" || column.type === "fk") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? "NULL" : String(parsed);
  }
  const text = String(value).replace(/'/g, "''");
  return `'${text}'`;
}

function buildFilterState(): Record<TableKey, Record<string, Set<string>>> {
  return TABLE_KEYS.reduce((acc, table) => {
    const tableFilters: Record<string, Set<string>> = {};
    TABLES[table].filters.forEach((filter) => {
      tableFilters[filter.field] = new Set<string>();
    });
    acc[table] = tableFilters;
    return acc;
  }, {} as Record<TableKey, Record<string, Set<string>>>);
}

function getStatusEnumKey(table: TableKey): string | undefined {
  const statusField = TABLES[table].statusField;
  const statusColumn = TABLES[table].columns.find(
    (column) => column.key === statusField && column.type === "enum",
  );
  return statusColumn?.enumKey;
}

function getFieldDisplayValue(
  table: TableKey,
  row: Record<string, unknown>,
  field: string,
  data: Record<TableKey, Record<string, unknown>[]>,
) {
  const column = TABLES[table].columns.find((item) => item.key === field);
  if (!column) return String(row[field] ?? "");
  if (column.type === "fk" && column.references) {
    const refTable = column.references.table as TableKey;
    const refRows = data[refTable] ?? [];
    const match = refRows.find((refRow) => Number(refRow.id) === Number(row[field]));
    const displayValue = match?.[column.references.displayField];
    return String(displayValue ?? row[field] ?? "");
  }
  return String(row[field] ?? "");
}

function buildInsertSql(table: TableKey, draft: Record<string, unknown>) {
  // Skip NULL values so Postgres applies column defaults (e.g. NOT NULL DEFAULT 'x').
  const columns = TABLES[table].columns.filter(
    (column) =>
      column.editable &&
      column.key !== "id" &&
      draft[column.key] !== null &&
      draft[column.key] !== undefined &&
      draft[column.key] !== "",
  );
  if (columns.length === 0) {
    return `insert into ${table} default values;`;
  }
  const names = columns.map((column) => column.key).join(", ");
  const values = columns.map((column) => sqlValue(draft[column.key], column)).join(", ");
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
  children: ReactNode;
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
  children: ReactNode;
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
  } as CSSProperties;

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

function SortableHeader({
  column,
  sortState,
  onSort,
}: {
  column: ColumnConfig;
  sortState: { key: string; dir: "asc" | "desc" } | null;
  onSort: (key: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: column.key });

  const style = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
    opacity: isDragging ? 0.65 : 1,
  } as CSSProperties;

  return (
    <th ref={setNodeRef} style={style} onClick={() => onSort(column.key)}>
      <span>{column.label}</span>
      {sortState?.key === column.key && (
        <span className="sort-indicator">{sortState.dir === "asc" ? "▲" : "▼"}</span>
      )}
      <button
        type="button"
        className="drag-handle"
        ref={setActivatorNodeRef}
        onClick={(event) => event.stopPropagation()}
        {...attributes}
        {...listeners}
      >
        ::
      </button>
    </th>
  );
}

function App() {
  const [activeView, setActiveView] = useState<ViewKey>("spreadsheet");
  const [activeTable, setActiveTable] = useState<TableKey>("gig_platforms");
  const [dbOnline, setDbOnline] = useState(true);
  const [data, setData] = useState<Record<TableKey, Record<string, unknown>[]>>(() =>
    TABLE_KEYS.reduce((acc, table) => {
      acc[table] = [];
      return acc;
    }, {} as Record<TableKey, Record<string, unknown>[]>),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortState, setSortState] = useState<{ key: string; dir: "asc" | "desc" } | null>(
    null,
  );
  const [columnOrder, setColumnOrder] = useState<Record<TableKey, string[]>>(() =>
    TABLE_KEYS.reduce((acc, table) => {
      acc[table] = loadColumnOrder(table);
      return acc;
    }, {} as Record<TableKey, string[]>),
  );
  const [filters, setFilters] = useState<Record<TableKey, Record<string, Set<string>>>>(
    () => buildFilterState(),
  );
  const [editing, setEditing] = useState<EditState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const headerSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

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
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
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
  const statusEnumKey = getStatusEnumKey(activeTable);
  const statusOptions = statusEnumKey ? ENUMS[statusEnumKey] ?? [] : [];

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

  function handleHeaderDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setColumnOrder((prev) => {
      const current = prev[activeTable];
      const fromIndex = current.indexOf(String(active.id));
      const toIndex = current.indexOf(String(over.id));
      if (fromIndex === -1 || toIndex === -1) return prev;
      return {
        ...prev,
        [activeTable]: arrayMove(current, fromIndex, toIndex),
      };
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
    setSaveError(null);
    try {
      if (edit.isNew) {
        await dbExecute(buildInsertSql(edit.table, edit.row));
      } else {
        await dbExecute(buildUpdateSql(edit.table, edit.row));
      }
      await loadTable(edit.table);
      setEditing(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("saveRow:", msg);
      setSaveError(msg);
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
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
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
                      {(ENUMS[filter.enumKey] ?? []).map((value) => (
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
              <DndContext sensors={headerSensors} onDragEnd={handleHeaderDragEnd}>
                <SortableContext items={orderedColumns.map((column) => column.key)}>
                  <table>
                    <thead>
                      <tr>
                        {orderedColumns.map((column) => (
                          <SortableHeader
                            key={column.key}
                            column={column}
                            sortState={sortState}
                            onSort={toggleSort}
                          />
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
                </SortableContext>
              </DndContext>
            </div>
          </div>
        )}

        {activeView === "kanban" && (
          <DndContext onDragEnd={handleKanbanDragEnd}>
            <div className="kanban">
              {statusOptions.map((status) => (
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
                        {activeConfig.cardFields.map((field, index) => (
                          <div
                            key={field}
                            className={index === 0 ? "card-title" : "card-meta"}
                          >
                            {getFieldDisplayValue(activeTable, row, field, data)}
                          </div>
                        ))}
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
          onClose={() => { setEditing(null); setSaveError(null); }}
          onSave={saveRow}
          tableData={data}
          saveError={saveError}
        />
      )}
    </div>
  );
}

function EditModal({
  editState,
  onClose,
  onSave,
  tableData,
  saveError,
}: {
  editState: EditState;
  onClose: () => void;
  onSave: (edit: EditState) => void;
  tableData: Record<TableKey, Record<string, unknown>[]>;
  saveError: string | null;
}) {
  const { table, row, isNew } = editState;
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...row });
  const [attemptedSave, setAttemptedSave] = useState(false);
  const missingRequired = TABLES[table].columns.filter(
    (column) =>
      column.required && (draft[column.key] === null || draft[column.key] === undefined || draft[column.key] === ""),
  );
  const showRequiredMessage = attemptedSave && missingRequired.length > 0;

  function updateField(key: string, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleSaveClick() {
    setAttemptedSave(true);
    if (missingRequired.length > 0) return;
    onSave({ table, row: draft, isNew });
  }

  function getReferenceHint(tableKey: TableKey) {
    if (tableKey === "sources") {
      return "Add a source first in the Sources tab.";
    }
    const tableLabel = TABLES[tableKey]?.label ?? tableKey;
    const singular = tableLabel.endsWith("s") ? tableLabel.slice(0, -1) : tableLabel;
    const article = /^[aeiou]/i.test(singular) ? "an" : "a";
    return `Add ${article} ${singular.toLowerCase()} first in the ${tableLabel} tab.`;
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
                <span>
                  {column.label}
                  {column.required && <span className="required"> *</span>}
                </span>
                {column.type === "enum" && column.enumKey ? (
                  <select
                    value={String(value ?? "")}
                    onChange={(event) => updateField(column.key, event.target.value)}
                    disabled={disabled}
                  >
                    <option value="">Select</option>
                    {(ENUMS[column.enumKey] ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : column.type === "fk" && column.references ? (
                  <>
                    <select
                      value={String(value ?? "")}
                      onChange={(event) => updateField(column.key, event.target.value)}
                      disabled={disabled}
                    >
                      <option value="">Select</option>
                      {(tableData[column.references.table as TableKey] ?? []).map((row) => (
                        <option key={String(row.id)} value={String(row.id)}>
                          {String(row[column.references.displayField] ?? row.id)}
                        </option>
                      ))}
                    </select>
                    {(tableData[column.references.table as TableKey] ?? []).length === 0 && (
                      <span className="field-hint">
                        {getReferenceHint(column.references.table as TableKey)}
                      </span>
                    )}
                  </>
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
          <button onClick={handleSaveClick}>Save</button>
        </div>
        {showRequiredMessage && (
          <div className="field-warning">Fill all required fields before saving.</div>
        )}
        {saveError && (
          <div className="field-warning">{saveError}</div>
        )}
      </div>
    </div>
  );
}

export default App;
