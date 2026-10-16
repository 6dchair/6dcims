import { useCallback, useEffect, useState } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { countOf, formatQty } from "./format";
import {
  FeedbackProvider,
  useConfirm,
  useToast,
  type ConfirmFn,
} from "./feedback";
import {
  localExport,
  localGetAttachmentBlob,
  localRequest,
} from "./localApi";
import { LOCAL_MODE } from "./mode";
import "./App.css";
import "./retro.css";

/* --------------------------------------------------
   CONFIG & HELPERS
-------------------------------------------------- */

const API: string =
  import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000";

/** Backend returns naive UTC datetimes (no "Z"). Parse them as UTC. */
function parseDate(value: string): Date {
  const hasTimezone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasTimezone ? value : `${value}Z`);
}

/** Native Android plugin (FileSavePlugin.java): "Save as" screen. */
const FileSave = registerPlugin<{
  saveFile(options: {
    sourceUri: string;
    fileName: string;
    mimeType?: string;
  }): Promise<{ saved: boolean; uri: string }>;
}>("FileSave");

/** Convert a Blob to plain base64 (no "data:" prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read the file"));

    reader.readAsDataURL(blob);
  });
}

/**
 * Save a file for the user.
 * Phone: opens Android's "Save as" screen (choose folder and name).
 * Browser: normal download.
 * Throws an error with code "CANCELLED" if the user backs out.
 */
async function saveBlobAs(
  blob: Blob,
  filename: string,
  mimeType: string
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const temp = await Filesystem.writeFile({
      path: filename,
      data: await blobToBase64(blob),
      directory: Directory.Cache,
    });

    try {
      await FileSave.saveFile({
        sourceUri: temp.uri,
        fileName: filename,
        mimeType,
      });
    } finally {
      // Remove the temporary copy whatever happened
      await Filesystem.deleteFile({
        path: filename,
        directory: Directory.Cache,
      }).catch(() => undefined);
    }

    return;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** True when an error just means "the user closed the Save screen". */
function isCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";

  return (
    (error as { code?: string })?.code === "CANCELLED" ||
    /cancel/i.test(message)
  );
}

/** Fetch JSON and throw a readable error on failure. */
async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  // Offline mode: the data lives on this device, no server involved
  if (LOCAL_MODE) {
    return localRequest<T>(path, options);
  }

  const response = await fetch(`${API}${path}`, options);

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // Response had no JSON body
  }

  if (!response.ok) {
    const detail =
      data && typeof data === "object" && "detail" in data
        ? (data as { detail: unknown }).detail
        : null;

    throw new Error(
      typeof detail === "string"
        ? detail
        : `Request failed (${response.status})`
    );
  }

  return data as T;
}

function getStockStatus(material: Material): {
  className: string;
  label: string;
} {
  if (material.quantity <= 0) {
    return { className: "status danger", label: "Out of stock" };
  }
  if (material.quantity <= material.minimum_stock) {
    return { className: "status warning", label: "Low stock" };
  }
  return { className: "status good", label: "Available" };
}

function StockBadge({ material }: { material: Material }) {
  const { className, label } = getStockStatus(material);
  return <span className={className}>{label}</span>;
}

/**
 * Deletes a table. If its items have borrowing/consumption records the
 * server refuses, so ask the user whether to delete that history too.
 * Returns false when the user cancels.
 */
async function requestTableDelete(
  table: { id: number; name: string },
  confirm: ConfirmFn
): Promise<boolean> {
  try {
    await request<null>(`/tables/${table.id}`, { method: "DELETE" });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (!message.includes("borrowing or consumption records")) {
      throw error;
    }

    const confirmed = await confirm({
      title: `Delete "${table.name}" and its history?`,
      message:
        "Some items in this table have borrowing or consumption " +
        "records. Deleting the table also deletes those records and " +
        "their attached proofs. This cannot be undone.",
      confirmLabel: "Delete everything",
    });
    if (!confirmed) return false;

    await request<null>(`/tables/${table.id}?force=true`, {
      method: "DELETE",
    });
    return true;
  }
}

/** Format a Date for <input type="datetime-local"> in local time. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-` +
    `${pad(date.getDate())}T${pad(date.getHours())}:` +
    pad(date.getMinutes())
  );
}

function isValidQuantity(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/* --------------------------------------------------
   TYPES
-------------------------------------------------- */

type Material = {
  id: number;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  minimum_stock: number;
  material_type: "reusable" | "consumable";
  borrowable: boolean;
  location: string | null;
  custom_data?: Record<string, string> | null;
  table_id?: number | null;
};

type Settings = {
  system_name: string;
  admin_name: string;
  accent_color: string;
};

type SettingsDialog = "system" | "admin" | "color" | "import" | null;

const DEFAULT_ACCENT = "#1f47c8";

const DEFAULT_SETTINGS: Settings = {
  system_name: "CIMS",
  admin_name: "",
  accent_color: DEFAULT_ACCENT,
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function hexToRgb(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixColors(a: number[], b: number[], amount: number): number[] {
  return a.map((v, i) => Math.round(v * (1 - amount) + b[i] * amount));
}

function rgbCss(color: number[]): string {
  return `rgb(${color.join(",")})`;
}

/** Perceived brightness 0 (black) to 1 (white). */
function brightness(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Re-colours the whole UI from one accent colour. */
function applyAccent(hex: string) {
  if (!HEX_COLOR.test(hex)) return;

  const rgb = hexToRgb(hex);
  const white = [255, 255, 255];
  const black = [0, 0, 0];
  const style = document.documentElement.style;

  style.setProperty("--blue", hex);
  style.setProperty("--blue-dark", rgbCss(mixColors(rgb, black, 0.28)));
  style.setProperty("--blue-soft", rgbCss(mixColors(rgb, white, 0.15)));
  style.setProperty("--blue-tint", `rgba(${rgb.join(",")},0.07)`);
  style.setProperty("--blue-tint-strong", `rgba(${rgb.join(",")},0.14)`);
  style.setProperty("--paper", rgbCss(mixColors(rgb, white, 0.92)));
  style.setProperty("--paper-raised", rgbCss(mixColors(rgb, white, 0.955)));
}

type WarehouseAlert = {
  type: string;
  severity: string;
  message: string;
  material_id?: number;
  borrowing_id?: number;
};

type Borrowing = {
  id: number;
  material_id: number;
  borrower_name: string;
  quantity: number;
  returned_quantity: number;
  borrowed_at: string;
  due_date: string;
  returned_at: string | null;
  status: string;
  remark?: string | null;
};

type MaterialIssue = {
  id: number;
  material_id: number;
  issued_to: string;
  quantity: number;
  project?: string | null;
  purpose?: string | null;
  issued_at: string;
};

type Page =
  | "dashboard"
  | "inventory"
  | "borrowings"
  | "consumed"
  | "alerts";

type TransactionType = "borrowing" | "issue";

interface Attachment {
  id: number;
  transaction_type: TransactionType;
  transaction_id: number;
  original_filename: string;
  content_type: string;
  uploaded_at: string;
}

/* --------------------------------------------------
   INVENTORY COLUMN CONFIGURATION
-------------------------------------------------- */

type ColumnType = "text" | "number" | "date";

type ColumnConfig = {
  key: string;
  label: string;
  visible: boolean;
  custom?: boolean;
  /** Only used by custom columns; defaults to "text" */
  type?: ColumnType;
};

const COLUMN_TYPES: { value: ColumnType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
];

function isColumnType(value: unknown): value is ColumnType {
  return value === "text" || value === "number" || value === "date";
}

/** Built-in columns, in their default order */
const DEFAULT_COLUMNS: ColumnConfig[] = [
  { key: "id", label: "ID", visible: true },
  { key: "name", label: "Material", visible: true },
  { key: "category", label: "Category", visible: true },
  { key: "quantity", label: "Quantity", visible: true },
  { key: "minimum", label: "Minimum", visible: true },
  { key: "borrowable", label: "Borrowable", visible: true },
  { key: "location", label: "Location", visible: true },
  { key: "status", label: "Status", visible: true },
];

/** ID holds the row menu and Material is the main label, so both stay visible */
const LOCKED_COLUMNS = new Set(["id", "name"]);

type InventoryTable = {
  id: number;
  name: string;
  kind: "consumable" | "reusable";
  columns: ColumnConfig[] | null;
};

function normalizeColumns(
  saved: ColumnConfig[] | null | undefined,
  kind: InventoryTable["kind"]
): ColumnConfig[] {
  const defaults = new Map(DEFAULT_COLUMNS.map((c) => [c.key, c]));
  const seen = new Set<string>();
  const result: ColumnConfig[] = [];

  for (const col of Array.isArray(saved) ? saved : []) {
    if (!col || typeof col.key !== "string" || seen.has(col.key)) {
      continue;
    }

    const isCustom = col.key.startsWith("custom:");
    if (!isCustom && !defaults.has(col.key)) continue;

    seen.add(col.key);
    result.push({
      key: col.key,
      label:
        (typeof col.label === "string" && col.label.trim()) ||
        defaults.get(col.key)?.label ||
        "Field",
      visible: col.visible !== false || LOCKED_COLUMNS.has(col.key),
      ...(isCustom
        ? {
            custom: true,
            type: isColumnType(col.type) ? col.type : "text",
          }
        : {}),
    });
  }

  // Add any built-in column missing from the saved layout
  for (const col of DEFAULT_COLUMNS) {
    if (!seen.has(col.key)) result.push(col);
  }

  // "Borrowable" only makes sense for borrowable tables
  return kind === "reusable"
    ? result
    : result.filter((c) => c.key !== "borrowable");
}

/* --------------------------------------------------
   APP
-------------------------------------------------- */

function AppInner() {
  const toast = useToast();
  const [page, setPage] = useState<Page>("dashboard");

  const [materials, setMaterials] = useState<Material[]>([]);
  const [alerts, setAlerts] = useState<WarehouseAlert[]>([]);
  const [borrowings, setBorrowings] = useState<Borrowing[]>([]);
  const [issues, setIssues] = useState<MaterialIssue[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [tables, setTables] = useState<InventoryTable[]>([]);

  // App-wide settings (system name, admin name, accent colour)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<SettingsDialog>(null);

  async function saveSettings(patch: Partial<Settings>) {
    const data = await request<Settings>("/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });

    setSettings({ ...DEFAULT_SETTINGS, ...data });
  }

  function openDialog(next: SettingsDialog) {
    setMenuOpen(false);
    setDialog(next);
  }

  async function exportData() {
    setMenuOpen(false);

    try {
      let blob: Blob;

      if (LOCAL_MODE) {
        blob = await localExport();
      } else {
        const response = await fetch(`${API}/export`);

        if (!response.ok) {
          throw new Error(`Export failed (${response.status})`);
        }

        blob = await response.blob();
      }

      const stamp = new Date()
        .toISOString()
        .slice(0, 16)
        .replace("T", "_")
        .replace(":", "-");

      await saveBlobAs(
        blob,
        `warehouse-backup-${stamp}.zip`,
        "application/zip"
      );

      toast.success(
        Capacitor.isNativePlatform()
          ? "Backup saved."
          : "Backup downloaded."
      );
    } catch (error) {
      console.error(error);

      // Closing the "Save as" screen is not an error
      if (isCancelled(error)) return;

      toast.error(
        `Could not export the data. ${
          error instanceof Error
            ? error.message
            : "Something went wrong."
        }`
      );
    }
  }

  const loadData = useCallback(async () => {
    try {
      const [
        materialsData,
        alertsData,
        borrowingsData,
        issuesData,
        tablesData,
        settingsData,
      ] = await Promise.all([
        request<Material[]>("/materials"),
        request<WarehouseAlert[]>("/alerts"),
        request<Borrowing[]>("/borrowings"),
        request<MaterialIssue[]>("/issues"),
        request<InventoryTable[]>("/tables"),
        // Older backends have no /settings; fall back to the default
        request<Settings>("/settings").catch(() => null),
      ]);

      if (settingsData) {
        setSettings({ ...DEFAULT_SETTINGS, ...settingsData });
      }

      setMaterials(materialsData);
      setTables(tablesData);
      setAlerts(alertsData);
      setBorrowings(borrowingsData);
      setIssues(issuesData);
      setLoadError("");
    } catch (error) {
      console.error("Failed to load warehouse data:", error);
      setLoadError(
        error instanceof Error
          ? error.message
          : "Could not reach the server."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // An empty name falls back to the default
  const systemName =
    settings.system_name.trim() || DEFAULT_SETTINGS.system_name;
  const adminName = settings.admin_name;

  useEffect(() => {
    document.title = systemName;
  }, [systemName]);

  useEffect(() => {
    applyAccent(settings.accent_color);
  }, [settings.accent_color]);

  // LATEST1 sticky header
    // Keep the section buttons stuck right under the top bar on phones
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".topbar");

    if (!header || typeof ResizeObserver === "undefined") return;

    const update = () =>
      document.documentElement.style.setProperty(
        "--topbar-height",
        `${header.offsetHeight}px`
      );

    update();

    const observer = new ResizeObserver(update);
    observer.observe(header);

    return () => observer.disconnect();
  }, [loading]);
  // ///////

  // Close the top-bar menu on any outside click
  useEffect(() => {
    if (!menuOpen) return;

    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);

    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  if (loading) {
    return <div className="loading">Loading warehouse...</div>;
  }

  const navItems: { page: Page; label: string }[] = [
    { page: "dashboard", label: "Dashboard" },
    { page: "inventory", label: "Inventory" },
    { page: "borrowings", label: "Borrowings" },
    { page: "consumed", label: "Consumed" },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>{systemName}</h1>
          <p>Customizable Inventory Management System</p>
        </div>

        <div className="topbar-actions">
          <button
            className="notification-button"
            onClick={() => setPage("alerts")}
          >
            Alerts
            <span
              className={
                alerts.length > 0 ? "badge has-alerts" : "badge"
              }
            >
              {alerts.length}
            </span>
          </button>

          <div className="menu-wrap">
            <button
              type="button"
              className="menu-button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((open) => !open);
              }}
            >
              Menu ▾
            </button>

            {menuOpen && (
              <div
                className="top-menu"
                role="menu"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  role="menuitem"
                  onClick={() => openDialog("system")}
                >
                  Rename system
                </button>
                <button
                  role="menuitem"
                  onClick={() => openDialog("admin")}
                >
                  {adminName ? "Rename admin" : "Add admin name"}
                </button>
                <button
                  role="menuitem"
                  onClick={() => openDialog("color")}
                >
                  Change accent color
                </button>
                <button role="menuitem" onClick={exportData}>
                  Export data
                </button>
                <button
                  role="menuitem"
                  onClick={() => openDialog("import")}
                >
                  Import data
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          {navItems.map((item) => (
            <button
              key={item.page}
              className={
                page === item.page
                  ? "nav-item active"
                  : "nav-item"
              }
              onClick={() => setPage(item.page)}
            >
              {item.label}
            </button>
          ))}

          <button
            className={
              page === "alerts" ? "nav-item active" : "nav-item"
            }
            onClick={() => setPage("alerts")}
          >
            Alerts
            {alerts.length > 0 && (
              <span className="nav-alert-count">
                {alerts.length}
              </span>
            )}
          </button>
        </aside>

        <main className={`content page-${page}`}>
          {loadError && (
            <div className="form-error">
              Could not load data: {loadError}{" "}
              <button
                className="secondary-button"
                onClick={loadData}
              >
                Retry
              </button>
            </div>
          )}

          {page === "dashboard" && (
            <Dashboard
              tables={tables}
              materials={materials}
              alerts={alerts}
              borrowings={borrowings}
              issues={issues}
              onOpenAlerts={() => setPage("alerts")}
            />
          )}

          {page === "inventory" && (
            <Inventory
              tables={tables}
              materials={materials}
              onRefresh={loadData}
            />
          )}

          {page === "borrowings" && (
            <Borrowings
              materials={materials}
              borrowings={borrowings}
              onRefresh={loadData}
            />
          )}

          {page === "consumed" && (
            <Consumed
              materials={materials}
              issues={issues}
              onRefresh={loadData}
            />
          )}

          {page === "alerts" && <Alerts alerts={alerts} />}
        </main>
      </div>

      <footer className="footer">
        <div className="footer-grid">
          <span className="footer-admin">
            Admin: <strong>{adminName || "Not set"}</strong>
            <button
              type="button"
              className="footer-edit"
              onClick={() => setDialog("admin")}
            >
              {adminName ? "Edit" : "Add"}
            </button>
          </span>
          <span>© 2026 · 6dchair</span>
          <span />
        </div>
      </footer>

      {dialog === "system" && (
        <TextSettingDialog
          title="Rename system"
          label="System name"
          initial={settings.system_name}
          placeholder="e.g. 6d Construction"
          allowEmpty
          help={`Leave it empty to use the default name (${DEFAULT_SETTINGS.system_name}).`}
          onSave={(value) =>
            saveSettings({
              system_name: value || DEFAULT_SETTINGS.system_name,
            })
          }
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === "admin" && (
        <TextSettingDialog
          title={adminName ? "Rename admin" : "Add admin name"}
          label="Admin name"
          initial={settings.admin_name}
          placeholder="e.g. Thom Yorke"
          allowEmpty
          help="Shown in the footer as “Admin: Name”. Leave it empty to remove the name."
          onSave={(value) => saveSettings({ admin_name: value })}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === "color" && (
        <ColorDialog
          initial={settings.accent_color}
          onSave={(value) => saveSettings({ accent_color: value })}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === "import" && (
        <ImportDialog
          onImported={loadData}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------
   SETTINGS DIALOGS (top-bar menu)
-------------------------------------------------- */

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-header">
          <h3>{title}</h3>

          <button
            type="button"
            className="close-button"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {children}
      </div>
    </div>
  );
}

function TextSettingDialog({
  title,
  label,
  initial,
  placeholder,
  help,
  allowEmpty = false,
  onSave,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  placeholder?: string;
  help?: string;
  allowEmpty?: boolean;
  onSave: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    const trimmed = value.trim();

    if (!trimmed && !allowEmpty) {
      setError(`${label} cannot be empty.`);
      return;
    }

    setSaving(true);
    setError("");

    try {
      await onSave(trimmed);
      onClose();
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error ? error.message : "Could not save."
      );
      setSaving(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div className="modal-body">
          <label>
            {label}
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={60}
              placeholder={placeholder}
              autoFocus
            />
          </label>

          {help && <p className="modal-help">{help}</p>}

          {error && <div className="form-error">{error}</div>}
        </div>

        <div className="form-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>

          <button
            type="submit"
            className="primary-button"
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

const ACCENT_PRESETS = [
  { name: "Royal blue", value: "#1f47c8" },
  { name: "Navy", value: "#16306e" },
  { name: "Teal", value: "#0f766e" },
  { name: "Green", value: "#15803d" },
  { name: "Purple", value: "#6d28d9" },
  { name: "Magenta", value: "#be185d" },
  { name: "Orange", value: "#c2410c" },
  { name: "Black", value: "#1b1b1f" },
];

function ColorDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: string;
  onSave: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const [color, setColor] = useState(initial);
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Live preview: the whole app changes colour as you pick
  function pick(next: string) {
    setColor(next);
    setText(next);
    applyAccent(next);
  }

  function cancel() {
    applyAccent(initial);
    onClose();
  }

  async function handleSave() {
    setSaving(true);
    setError("");

    try {
      await onSave(color.toLowerCase());
      onClose();
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error ? error.message : "Could not save."
      );
      setSaving(false);
    }
  }

  return (
    <Modal title="Change accent color" onClose={cancel}>
      <div className="modal-body">
        <div className="swatches">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className={
                preset.value === color.toLowerCase()
                  ? "swatch selected"
                  : "swatch"
              }
              style={{ background: preset.value }}
              title={preset.name}
              aria-label={preset.name}
              aria-pressed={preset.value === color.toLowerCase()}
              onClick={() => pick(preset.value)}
            />
          ))}
        </div>

        <div className="color-custom">
          <label>
            Custom color
            <input
              type="color"
              value={color}
              onChange={(e) => pick(e.target.value)}
              aria-label="Pick a custom color"
            />
          </label>

          <label>
            Hex code
            <input
              value={text}
              maxLength={7}
              onChange={(e) => {
                setText(e.target.value);
                if (HEX_COLOR.test(e.target.value)) {
                  setColor(e.target.value);
                  applyAccent(e.target.value);
                }
              }}
              placeholder="#1f47c8"
            />
          </label>
        </div>

        {brightness(color) > 0.6 && (
          <p className="modal-help">
            This color is quite light, so text and borders may be
            hard to read. A darker color works better.
          </p>
        )}

        {error && <div className="form-error">{error}</div>}
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="secondary-button"
          style={{ marginRight: "auto" }}
          onClick={() => pick(DEFAULT_ACCENT)}
          disabled={saving}
        >
          Reset to default
        </button>

        <button
          type="button"
          className="secondary-button"
          onClick={cancel}
          disabled={saving}
        >
          Cancel
        </button>

        <button
          type="button"
          className="primary-button"
          onClick={handleSave}
          disabled={saving || !HEX_COLOR.test(color)}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </Modal>
  );
}

function ImportDialog({
  onImported,
  onClose,
}: {
  onImported: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");

  async function handleImport() {
    if (!file) return;

    setBusy(true);
    setError("");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const result = await request<{
        imported: Record<string, number>;
      }>("/import", { method: "POST", body: formData });

      const n = result.imported;

      await onImported();

      setSummary(
        `Imported ${countOf(n.inventory_tables ?? 0, "table")}, ` +
          `${countOf(n.materials ?? 0, "item")}, ` +
          `${countOf(n.borrowings ?? 0, "borrowing")}, ` +
          `${countOf(n.material_issues ?? 0, "consumption record")} and ` +
          `${countOf(n.transaction_attachments ?? 0, "proof")}.`
      );
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error ? error.message : "Could not import."
      );
    } finally {
      setBusy(false);
    }
  }

  if (summary) {
    return (
      <Modal title="Import complete" onClose={onClose}>
        <div className="modal-body">
          <p>{summary}</p>
        </div>

        <div className="form-actions">
          <button
            type="button"
            className="primary-button"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Import data" onClose={onClose}>
      <div className="modal-body">
        <div className="form-error">
          Importing replaces ALL current data: tables, items,
          borrowings, consumption records, proofs and settings.
          Export a backup first if you might need what is there now.
        </div>

        <label>
          Backup file (.zip made by “Export data”)
          <input
            type="file"
            accept=".zip,.json,application/zip,application/json"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>

        <label className="confirm-row">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I understand this will replace everything.
        </label>

        {error && <div className="form-error">{error}</div>}
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>

        <button
          type="button"
          className="primary-button"
          onClick={handleImport}
          disabled={busy || !file || !confirmed}
        >
          {busy ? "Importing..." : "Import and replace"}
        </button>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------
   DASHBOARD
-------------------------------------------------- */

function Dashboard({
  tables,
  materials,
  alerts,
  borrowings,
  issues,
  onOpenAlerts,
}: {
  tables: InventoryTable[];
  materials: Material[];
  alerts: WarehouseAlert[];
  borrowings: Borrowing[];
  issues: MaterialIssue[];
  onOpenAlerts: () => void;
}) {
  const materialById = new Map(materials.map((m) => [m.id, m]));

  // Latest borrowings and consumption records, newest first
  const activity = [
    ...borrowings.map((b) => {
      const m = materialById.get(b.material_id);
      return {
        key: `b-${b.id}`,
        when: parseDate(b.borrowed_at),
        label: "Borrowed",
        text: `${b.borrower_name} borrowed ${formatQty(
          b.quantity,
          m?.unit
        )} of ${m?.name ?? "a material"}`,
      };
    }),
    ...issues.map((i) => {
      const m = materialById.get(i.material_id);
      return {
        key: `i-${i.id}`,
        when: parseDate(i.issued_at),
        label: "Consumed",
        text: `${formatQty(i.quantity, m?.unit)} of ${
          m?.name ?? "a material"
        } issued to ${i.issued_to}`,
      };
    }),
  ]
    .sort((a, b) => b.when.getTime() - a.when.getTime())
    .slice(0, 6);

  // Totals per unit (adding bags + meters + pieces together is meaningless)
  const stockByUnit = materials.reduce<Record<string, number>>(
    (totals, m) => {
      totals[m.unit] = (totals[m.unit] || 0) + m.quantity;
      return totals;
    },
    {}
  );

  const unitEntries = Object.entries(stockByUnit);

  const lowStockCount = materials.filter(
    (m) => m.quantity > 0 && m.quantity <= m.minimum_stock
  ).length;

  const outOfStockCount = materials.filter(
    (m) => m.quantity <= 0
  ).length;

  return (
    <>
      <div className="page-heading">
        <div>
          <h2>Dashboard</h2>
          <p>Warehouse overview</p>
        </div>
      </div>

      <div className="stats">
        <div className="stat-card">
          <span>Tables</span>
          <strong>{tables.length}</strong>
        </div>

        <div className="stat-card">
          <span>Total stock</span>
          <strong className="stat-small">
            {unitEntries.length === 0
              ? "0"
              : unitEntries
                  .map(([unit, total]) => formatQty(total, unit))
                  .join(", ")}
          </strong>
        </div>

        <div
          className={
            alerts.length > 0 ? "stat-card warn" : "stat-card"
          }
        >
          <span>Active alerts</span>
          <strong>{alerts.length}</strong>
        </div>

        <div
          className={
            lowStockCount > 0 ? "stat-card warn" : "stat-card"
          }
        >
          <span>Low stock items</span>
          <strong>{lowStockCount}</strong>
        </div>

        <div
          className={
            outOfStockCount > 0 ? "stat-card danger" : "stat-card"
          }
        >
          <span>Out of stock</span>
          <strong>{outOfStockCount}</strong>
        </div>
      </div>

      <div className="dash-grid">
        <section className="section">
          <div className="section-header">
            <h2>Needs attention</h2>

            {alerts.length > 0 && (
              <button
                type="button"
                className="text-link"
                onClick={onOpenAlerts}
              >
                View all {alerts.length}
              </button>
            )}
          </div>

          {alerts.length === 0 ? (
            <div className="empty">Nothing needs attention.</div>
          ) : (
            <ul className="feed">
              {alerts.slice(0, 5).map((alert, index) => (
                <li
                  className={`feed-item ${alert.severity}`}
                  key={`${alert.type}-${alert.material_id ?? ""}-${
                    alert.borrowing_id ?? ""
                  }-${index}`}
                >
                  <span className="feed-dot" aria-hidden="true" />
                  <span>{alert.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="section">
          <div className="section-header">
            <h2>Recent activity</h2>
          </div>

          {activity.length === 0 ? (
            <div className="empty">No activity recorded yet.</div>
          ) : (
            <ul className="feed">
              {activity.map((item) => (
                <li className="feed-item" key={item.key}>
                  <span className="feed-tag">{item.label}</span>
                  <span className="feed-text">{item.text}</span>
                  <time className="feed-time">
                    {item.when.toLocaleDateString()}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

/* --------------------------------------------------
   INVENTORY
-------------------------------------------------- */

const KIND_LABEL: Record<InventoryTable["kind"], string> = {
  consumable: "Consumable",
  reusable: "Borrowable",
};

function NewTableForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] =
    useState<InventoryTable["kind"]>("consumable");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    setSaving(true);
    setError("");

    try {
      await request<InventoryTable>("/tables", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), kind }),
      });

      onCreated();
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not create table."
      );
      setSaving(false);
    }
  }

  return (
    <div className="form-panel">
      <div className="form-header">
        <div>
          <h3>New table</h3>
          <p>
            A table groups similar items, for example "Hand Tools" or
            "Cement and Sand".
          </p>
        </div>

        <button
          type="button"
          className="close-button"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="form-grid">
          <label>
            Table name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Power Tools"
              required
              autoFocus
            />
          </label>

          <label>
            Kind
            <select
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as InventoryTable["kind"])
              }
            >
              <option value="consumable">
                Consumable (used up, recorded under Consumed)
              </option>
              <option value="reusable">
                Borrowable (lent out and returned)
              </option>
            </select>
          </label>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="form-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
          >
            Cancel
          </button>

          <button
            type="submit"
            className="primary-button"
            disabled={saving}
          >
            {saving ? "Creating..." : "Create table"}
          </button>
        </div>
      </form>
    </div>
  );
}

function TableSettings({
  table,
  onClose,
  onChanged,
}: {
  table: InventoryTable;
  onClose: () => void;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [name, setName] = useState(table.name);
  const [kind, setKind] = useState<InventoryTable["kind"]>(table.kind);
  const [draft, setDraft] = useState<ColumnConfig[]>(
    normalizeColumns(table.columns, table.kind)
  );
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<ColumnType>("text");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function update(index: number, patch: Partial<ColumnConfig>) {
    setDraft((previous) =>
      previous.map((col, i) =>
        i === index ? { ...col, ...patch } : col
      )
    );
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= draft.length) return;

    setDraft((previous) => {
      const next = [...previous];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function remove(index: number) {
    const col = draft[index];
    const confirmed = await confirm({
      title: `Remove the "${col.label}" column?`,
      message:
        "Values already entered are kept in the database but will " +
        "no longer be shown.",
      confirmLabel: "Remove column",
    });
    if (!confirmed) return;

    setDraft((previous) => previous.filter((_, i) => i !== index));
  }

  function addColumn() {
    const label = newName.trim();
    if (!label) return;

    if (
      draft.some(
        (c) => c.label.trim().toLowerCase() === label.toLowerCase()
      )
    ) {
      setError("A column with that name already exists.");
      return;
    }

    setDraft((previous) => [
      ...previous,
      {
        key: `custom:${Date.now().toString(36)}`,
        label,
        visible: true,
        custom: true,
        type: newType,
      },
    ]);
    setNewName("");
    setNewType("text");
    setError("");
  }

  function resetBuiltIns() {
    setDraft(
      normalizeColumns(
        [...DEFAULT_COLUMNS, ...draft.filter((c) => c.custom)],
        kind
      )
    );
  }

  async function handleSave() {
    if (!name.trim()) {
      setError("Table name cannot be empty.");
      return;
    }

    if (draft.some((c) => !c.label.trim())) {
      setError("Column names cannot be empty.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      await request<InventoryTable>(`/tables/${table.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          kind,
          columns: normalizeColumns(draft, kind).map((c) => ({
            ...c,
            label: c.label.trim(),
          })),
        }),
      });

      onChanged();
      onClose();
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not save table."
      );
      setSaving(false);
    }
  }

  async function handleDelete() {
    const confirmed = await confirm({
      title: `Delete the table "${table.name}"?`,
      message:
        "All items in it will be deleted too. This cannot be undone.",
      confirmLabel: "Delete table",
    });
    if (!confirmed) return;

    setSaving(true);
    setError("");

    try {
      const deleted = await requestTableDelete(table, confirm);

      if (!deleted) {
        setSaving(false);
        return;
      }

      onChanged();
      onClose();
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not delete table."
      );
      setSaving(false);
    }
  }

  return (
    <div className="form-panel">
      <div className="form-header">
        <div>
          <h3>Customize "{table.name}"</h3>
          <p>
            Rename the table, show or hide columns, rename or reorder
            them, or add your own fields.
          </p>
        </div>

        <button
          type="button"
          className="close-button"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div className="form-grid">
        <label>
          Table name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label>
          Kind
          <select
            value={kind}
            onChange={(e) =>
              setKind(e.target.value as InventoryTable["kind"])
            }
          >
            <option value="consumable">
              Consumable (used up, recorded under Consumed)
            </option>
            <option value="reusable">
              Borrowable (lent out and returned)
            </option>
          </select>
        </label>
      </div>

      {kind !== table.kind && (
        <div className="form-info">
          Changing the kind updates every item in this table. It is
          blocked if any item already has borrowing or consumption
          records.
        </div>
      )}

      <div className="column-list">
        {draft.map((col, index) => (
          <div className="column-row" key={col.key}>
            <input
              type="checkbox"
              checked={col.visible}
              disabled={LOCKED_COLUMNS.has(col.key)}
              title={
                LOCKED_COLUMNS.has(col.key)
                  ? "This column is always shown"
                  : "Show this column"
              }
              aria-label={`Show ${col.label}`}
              onChange={(e) =>
                update(index, { visible: e.target.checked })
              }
            />

            <input
              type="text"
              value={col.label}
              aria-label="Column name"
              onChange={(e) =>
                update(index, { label: e.target.value })
              }
            />

            {col.custom ? (
              <select
                className="type-select"
                aria-label="Field type"
                value={col.type ?? "text"}
                onChange={(e) =>
                  update(index, {
                    type: e.target.value as ColumnType,
                  })
                }
              >
                {COLUMN_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="tag">Built-in</span>
            )}

            <button
              type="button"
              className="icon-button"
              aria-label="Move up"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              ↑
            </button>

            <button
              type="button"
              className="icon-button"
              aria-label="Move down"
              disabled={index === draft.length - 1}
              onClick={() => move(index, 1)}
            >
              ↓
            </button>

            <button
              type="button"
              className="secondary-button"
              style={{
                visibility: col.custom ? "visible" : "hidden",
              }}
              disabled={!col.custom}
              onClick={() => remove(index)}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="column-add">
        <input
          value={newName}
          placeholder="New field name, e.g. Supplier"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addColumn();
            }
          }}
        />

        <select
          className="type-select"
          aria-label="New field type"
          value={newType}
          onChange={(e) => setNewType(e.target.value as ColumnType)}
        >
          {COLUMN_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="secondary-button"
          onClick={addColumn}
        >
          + Add field
        </button>

        <button
          type="button"
          className="secondary-button"
          onClick={resetBuiltIns}
        >
          Reset built-in columns
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="form-actions">
        <button
          type="button"
          className="secondary-button danger"
          style={{ marginRight: "auto" }}
          onClick={handleDelete}
          disabled={saving}
        >
          Delete table
        </button>

        <button
          type="button"
          className="secondary-button"
          onClick={onClose}
        >
          Cancel
        </button>

        <button
          type="button"
          className="primary-button"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

type RowMenu = { material: Material; top: number; left: number } | null;

function Inventory({
  tables,
  materials,
  onRefresh,
}: {
  tables: InventoryTable[];
  materials: Material[];
  onRefresh: () => void;
}) {
  const confirm = useConfirm();
  const [showNewTable, setShowNewTable] = useState(false);
  const [settingsTableId, setSettingsTableId] =
    useState<number | null>(null);
  const [addingToTableId, setAddingToTableId] =
    useState<number | null>(null);
  const [editing, setEditing] = useState<Material | null>(null);
  const [actionError, setActionError] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<RowMenu>(null);
  const [busy, setBusy] = useState(false);

  const settingsTable =
    tables.find((t) => t.id === settingsTableId) ?? null;

  const formTable = editing
    ? tables.find((t) => t.id === editing.table_id) ?? null
    : tables.find((t) => t.id === addingToTableId) ?? null;

  const selectedMaterials = materials.filter((m) =>
    selected.has(m.id)
  );

  // Close the row menu on outside click, scroll or resize
  useEffect(() => {
    if (!menu) return;

    const close = () => setMenu(null);

    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);

    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  function closePanels() {
    setShowNewTable(false);
    setSettingsTableId(null);
    setAddingToTableId(null);
    setEditing(null);
    setActionError("");
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleGroup(list: Material[]) {
    const everySelected =
      list.length > 0 && list.every((m) => selected.has(m.id));

    setSelected((previous) => {
      const next = new Set(previous);
      list.forEach((m) => {
        if (everySelected) {
          next.delete(m.id);
        } else {
          next.add(m.id);
        }
      });
      return next;
    });
  }

  function toggleOne(id: number) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleMenu(
    event: React.MouseEvent<HTMLButtonElement>,
    material: Material
  ) {
    event.stopPropagation();

    if (menu?.material.id === material.id) {
      setMenu(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();

    setMenu({
      material,
      top: rect.bottom + 2,
      left: Math.max(8, rect.right - 150),
    });
  }

  function startEdit(material: Material) {
    setMenu(null);
    closePanels();
    setEditing(material);
    scrollToTop();
  }

  async function deleteMaterials(list: Material[]) {
    if (list.length === 0) return;

    const names = list.slice(0, 5).map((m) => m.name);

    if (list.length > 5) {
      names.push(`…and ${list.length - 5} more`);
    }

    const confirmed = await confirm({
      title:
        list.length === 1
          ? `Delete "${list[0].name}"?`
          : `Delete ${list.length} items?`,
      message:
        list.length === 1
          ? "It will be removed from the inventory. This cannot be undone."
          : "They will be removed from the inventory. This cannot be undone.",
      items: list.length === 1 ? undefined : names,
      confirmLabel: list.length === 1 ? "Delete item" : "Delete items",
    });

    if (!confirmed) return;

    setBusy(true);
    setActionError("");

    const deletedIds: number[] = [];
    const failed: { name: string; reason: string }[] = [];

    for (const material of list) {
      try {
        await request<null>(`/materials/${material.id}`, {
          method: "DELETE",
        });
        deletedIds.push(material.id);
      } catch (error) {
        failed.push({
          name: material.name,
          reason:
            error instanceof Error ? error.message : "Request failed",
        });
      }
    }

    setSelected((previous) => {
      const next = new Set(previous);
      deletedIds.forEach((id) => next.delete(id));
      return next;
    });

    if (editing && deletedIds.includes(editing.id)) {
      setEditing(null);
    }

    if (failed.length > 0) {
      const names = failed.map((f) => f.name).join(", ");
      const deletedNote =
        deletedIds.length > 0 ? `${deletedIds.length} deleted. ` : "";
      setActionError(
        `${deletedNote}Could not delete ${names}: ${failed[0].reason}.`
      );
    }

    setBusy(false);
    onRefresh();
  }

  async function deleteTable(table: InventoryTable) {
    const count = materials.filter(
      (m) => m.table_id === table.id
    ).length;

    const confirmed = await confirm({
      title: `Delete the table "${table.name}"?`,
      message:
        (count > 0
          ? `Its ${countOf(count, "item")} will be deleted too. `
          : "") + "This cannot be undone.",
      confirmLabel: "Delete table",
    });
    if (!confirmed) return;

    setBusy(true);
    setActionError("");

    try {
      const deleted = await requestTableDelete(table, confirm);
      if (!deleted) return;

      if (settingsTableId === table.id) setSettingsTableId(null);
      if (addingToTableId === table.id) setAddingToTableId(null);
      if (editing?.table_id === table.id) setEditing(null);

      setSelected((previous) => {
        const next = new Set(previous);
        materials
          .filter((m) => m.table_id === table.id)
          .forEach((m) => next.delete(m.id));
        return next;
      });

      onRefresh();
    } catch (error) {
      console.error(error);
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not delete table."
      );
      scrollToTop();
    } finally {
      setBusy(false);
    }
  }

  function renderCell(col: ColumnConfig, material: Material) {
    switch (col.key) {
      case "id":
        return (
          <>
            {String(material.id).padStart(3, "0")}
            <button
              className="kebab-button"
              aria-label={`Actions for ${material.name}`}
              aria-haspopup="menu"
              onClick={(e) => toggleMenu(e, material)}
            >
              ⋮
            </button>
          </>
        );
      case "name":
        return <strong>{material.name}</strong>;
      case "category":
        return material.category;
      case "quantity":
        return formatQty(material.quantity, material.unit);
      case "minimum":
        return formatQty(material.minimum_stock, material.unit);
      case "borrowable":
        return material.borrowable ? "Yes" : "No";
      case "location":
        return material.location || "Not specified";
      case "status":
        return <StockBadge material={material} />;
      default:
        return material.custom_data?.[col.key] || "—";
    }
  }

  function renderTable(table: InventoryTable) {
    const list = materials.filter((m) => m.table_id === table.id);
    const cols = normalizeColumns(table.columns, table.kind).filter(
      (c) => c.visible
    );

    const allSelected =
      list.length > 0 && list.every((m) => selected.has(m.id));
    const someSelected =
      !allSelected && list.some((m) => selected.has(m.id));

    return (
      <section className="section" key={table.id}>
        <div className="section-header">
          <div className="table-title">
            <h2>{table.name}</h2>
            <span className="count">{KIND_LABEL[table.kind]}</span>
            <span className="count">{countOf(list.length, "item")}</span>
          </div>

          <div className="heading-actions">
            <button
              className="secondary-button"
              onClick={() => {
                closePanels();
                setSettingsTableId(table.id);
                scrollToTop();
              }}
            >
              Customize
            </button>

            <button
              className="secondary-button danger"
              onClick={() => deleteTable(table)}
              disabled={busy}
            >
              Delete table
            </button>

            <button
              className="primary-button"
              onClick={() => {
                closePanels();
                setAddingToTableId(table.id);
                scrollToTop();
              }}
            >
              + Add item
            </button>
          </div>
        </div>

        {list.length === 0 ? (
          <div className="empty">
            No items yet. Use "Add item" to add the first one.
          </div>
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table inventory-table">
              <thead>
                <tr>
                  <th className="check-cell">
                    <input
                      type="checkbox"
                      aria-label={`Select all in ${table.name}`}
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={() => toggleGroup(list)}
                    />
                  </th>
                  {cols.map((col) => (
                    <th key={col.key}>{col.label}</th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {list.map((material) => (
                  <tr
                    key={material.id}
                    className={
                      selected.has(material.id) ? "row-selected" : ""
                    }
                  >
                    <td className="check-cell">
                      <input
                        type="checkbox"
                        aria-label={`Select ${material.name}`}
                        checked={selected.has(material.id)}
                        onChange={() => toggleOne(material.id)}
                      />
                    </td>
                    {cols.map((col) => (
                      <td
                        key={col.key}
                        className={
                          col.key === "id" ? "id-cell" : undefined
                        }
                      >
                        {renderCell(col, material)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    );
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h2>Inventory</h2>
          <p>Create tables and manage the items in them</p>
        </div>

        <button
          className="primary-button"
          onClick={() => {
            closePanels();
            setShowNewTable(true);
          }}
        >
          + New table
        </button>
      </div>

      {showNewTable && (
        <NewTableForm
          onClose={() => setShowNewTable(false)}
          onCreated={() => {
            setShowNewTable(false);
            onRefresh();
          }}
        />
      )}

      {settingsTable && (
        <TableSettings
          key={settingsTable.id}
          table={settingsTable}
          onClose={() => setSettingsTableId(null)}
          onChanged={onRefresh}
        />
      )}

      {formTable && (
        <MaterialForm
          key={editing ? editing.id : `new-${formTable.id}`}
          table={formTable}
          material={editing ?? undefined}
          onClose={() => {
            setEditing(null);
            setAddingToTableId(null);
          }}
          onSaved={() => {
            setEditing(null);
            setAddingToTableId(null);
            onRefresh();
          }}
        />
      )}

      {actionError && (
        <div className="form-error">{actionError}</div>
      )}

      {selectedMaterials.length > 0 && (
        <div className="bulk-bar">
          <span>
            <strong>{selectedMaterials.length}</strong> selected
          </span>

          <button
            className="secondary-button"
            onClick={() => deleteMaterials(selectedMaterials)}
            disabled={busy}
          >
            {busy ? "Deleting..." : "Delete Selected"}
          </button>

          <button
            className="secondary-button"
            onClick={() => setSelected(new Set())}
            disabled={busy}
          >
            Clear
          </button>
        </div>
      )}

      {tables.length === 0 ? (
        <div className="empty-state">
          <h3>No tables yet</h3>
          <p>
            Create your first table to start tracking materials, for
            example "Hand Tools" or "Cement and Sand".
          </p>
          <button
            className="primary-button"
            onClick={() => {
              closePanels();
              setShowNewTable(true);
            }}
          >
            + New table
          </button>
        </div>
      ) : (
        <div className="inventory-panes">
          {tables.map((table) => renderTable(table))}
        </div>
      )}

      {menu && (
        <div
          className="row-menu"
          role="menu"
          style={{ top: menu.top, left: menu.left }}
        >
          <button role="menuitem" onClick={() => startEdit(menu.material)}>
            Edit
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const target = menu.material;
              setMenu(null);
              deleteMaterials([target]);
            }}
          >
            Delete
          </button>
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------
   ADD MATERIAL FORM
-------------------------------------------------- */

type CatalogItem = {
  name: string;
  unit: string;
  type: "reusable" | "consumable";
};

/** Edit this list to change the dropdown options. */
const CATALOG: Record<string, CatalogItem[]> = {
  "Power Tools": [
    { name: "Power Drill", unit: "piece", type: "reusable" },
    { name: "Circular Saw", unit: "piece", type: "reusable" },
    { name: "Angle Grinder", unit: "piece", type: "reusable" },
    { name: "Jigsaw", unit: "piece", type: "reusable" },
    { name: "Rotary Hammer", unit: "piece", type: "reusable" },
  ],
  "Hand Tools": [
    { name: "Hammer", unit: "piece", type: "reusable" },
    { name: "Screwdriver Set", unit: "set", type: "reusable" },
    { name: "Pliers", unit: "piece", type: "reusable" },
    { name: "Wrench Set", unit: "set", type: "reusable" },
    { name: "Measuring Tape", unit: "piece", type: "reusable" },
  ],
  Concrete: [
    { name: "Cement", unit: "bag", type: "consumable" },
    { name: "Sand", unit: "bag", type: "consumable" },
    { name: "Gravel", unit: "bag", type: "consumable" },
    { name: "Concrete Hollow Block", unit: "piece", type: "consumable" },
  ],
  "Steel & Metal": [
    { name: "Rebar", unit: "piece", type: "consumable" },
    { name: "GI Wire", unit: "kg", type: "consumable" },
    { name: "Steel Plate", unit: "piece", type: "consumable" },
  ],
  Fasteners: [
    { name: "Nails", unit: "kg", type: "consumable" },
    { name: "Screws", unit: "box", type: "consumable" },
    { name: "Bolts and Nuts", unit: "box", type: "consumable" },
    { name: "Anchor Bolts", unit: "box", type: "consumable" },
  ],
  Lumber: [
    { name: "Plywood", unit: "piece", type: "consumable" },
    { name: "Coco Lumber", unit: "piece", type: "consumable" },
    { name: "Lumber 2x2", unit: "piece", type: "consumable" },
  ],
  Electrical: [
    { name: "Electrical Wire", unit: "meter", type: "consumable" },
    { name: "Conduit Pipe", unit: "piece", type: "consumable" },
    { name: "Circuit Breaker", unit: "piece", type: "consumable" },
    { name: "Extension Cord", unit: "piece", type: "reusable" },
  ],
  Plumbing: [
    { name: "PVC Pipe", unit: "piece", type: "consumable" },
    { name: "Pipe Fittings", unit: "box", type: "consumable" },
    { name: "Faucet", unit: "piece", type: "consumable" },
    { name: "Teflon Tape", unit: "piece", type: "consumable" },
  ],
  "Paint & Finishing": [
    { name: "Paint", unit: "liter", type: "consumable" },
    { name: "Paint Brush", unit: "piece", type: "reusable" },
    { name: "Paint Roller", unit: "piece", type: "reusable" },
  ],
  "Safety Equipment": [
    { name: "Hard Hat", unit: "piece", type: "reusable" },
    { name: "Safety Goggles", unit: "piece", type: "reusable" },
    { name: "Safety Harness", unit: "piece", type: "reusable" },
    { name: "Safety Gloves", unit: "set", type: "consumable" },
  ],
  Equipment: [
    { name: "Ladder", unit: "piece", type: "reusable" },
    { name: "Scaffolding", unit: "set", type: "reusable" },
    { name: "Wheelbarrow", unit: "piece", type: "reusable" },
    { name: "Concrete Mixer", unit: "piece", type: "reusable" },
    { name: "Generator", unit: "piece", type: "reusable" },
  ],
};

const OTHER = "__other__";

function MaterialForm({
  table,
  material,
  onClose,
  onSaved,
}: {
  table: InventoryTable;
  material?: Material;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = Boolean(material);

  const allColumns = normalizeColumns(table.columns, table.kind);
  const customColumns = allColumns.filter((c) => c.custom);

  // Built-in fields follow the table layout. Hidden fields get safe
  // defaults (or keep their existing value when editing).
  const isShown = (key: string) =>
    allColumns.find((c) => c.key === key)?.visible !== false;
  const showCategory = isShown("category");
  const showMinimum = isShown("minimum");
  const showLocation = isShown("location");

  const categoryInCatalog = Boolean(
    material && material.category in CATALOG
  );
  const nameInCatalog = Boolean(
    material &&
      categoryInCatalog &&
      CATALOG[material.category].some((i) => i.name === material.name)
  );

  const [categorySelect, setCategorySelect] = useState(
    material ? (categoryInCatalog ? material.category : OTHER) : ""
  );
  const [customCategory, setCustomCategory] = useState(
    material && !categoryInCatalog ? material.category : ""
  );
  const [nameSelect, setNameSelect] = useState(
    material ? (nameInCatalog ? material.name : OTHER) : ""
  );
  const [customName, setCustomName] = useState(
    material && !nameInCatalog ? material.name : ""
  );

  const [quantity, setQuantity] = useState(
    material ? String(material.quantity) : ""
  );
  const [unit, setUnit] = useState(material?.unit ?? "piece");
  const [minimumStock, setMinimumStock] = useState(
    material ? String(material.minimum_stock) : ""
  );
  const [location, setLocation] = useState(material?.location ?? "");
  const [customValues, setCustomValues] = useState<
    Record<string, string>
  >(material?.custom_data ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const categoryIsCustom = categorySelect === OTHER;
  const nameIsCustom = categoryIsCustom || nameSelect === OTHER;

  // With the Category column hidden, the name is typed freely and the
  // category is kept (edit) or set to "General" (new item).
  const category = showCategory
    ? (categoryIsCustom ? customCategory : categorySelect).trim()
    : (material?.category ?? "General");
  const name = (
    !showCategory || nameIsCustom ? customName : nameSelect
  ).trim();

  const catalogItems = CATALOG[categorySelect] ?? [];

  function handleCategoryChange(value: string) {
    setCategorySelect(value);
    setNameSelect("");
    setCustomName("");
  }

  function handleNameChange(value: string) {
    setNameSelect(value);

    // Pre-fill the unit from the catalog (still editable)
    const item = catalogItems.find((i) => i.name === value);
    if (item) {
      setUnit(item.unit);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!category || !name) {
      setError("Choose or enter a category and a material name.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      await request<Material>(
        editing ? `/materials/${material!.id}` : "/materials",
        {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            table_id: table.id,
            name,
            category,
            quantity: Number(quantity),
            unit,
            minimum_stock: showMinimum
              ? Number(minimumStock)
              : (material?.minimum_stock ?? 0),
            location: showLocation
              ? location || null
              : (material?.location ?? null),
            // Keep values of removed fields, update the current ones
            custom_data: {
              ...(material?.custom_data ?? {}),
              ...Object.fromEntries(
                customColumns.map((col) => [
                  col.key,
                  (customValues[col.key] ?? "").trim(),
                ])
              ),
            },
          }),
        }
      );

      onSaved();
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not save item."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form-panel">
      <div className="form-header">
        <div>
          <h3>
            {editing ? "Edit item" : `Add item to ${table.name}`}
          </h3>
          <p>
            {editing
              ? `Change the details of ${material!.name}.`
              : `${KIND_LABEL[table.kind]} table`}
          </p>
        </div>

        <button
          type="button"
          className="close-button"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="form-grid">
          {showCategory && (
          <label>
            Category
            <select
              value={categorySelect}
              onChange={(e) => handleCategoryChange(e.target.value)}
              required
            >
              <option value="" disabled>
                Select category...
              </option>
              {Object.keys(CATALOG).map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
              <option value={OTHER}>Other (type your own)...</option>
            </select>

            {categoryIsCustom && (
              <input
                value={customCategory}
                onChange={(e) => setCustomCategory(e.target.value)}
                placeholder="Enter category"
                required
              />
            )}
          </label>
          )}

          <label>
            Material name
            {!showCategory || categoryIsCustom ? (
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="Enter material name"
                required
              />
            ) : (
              <>
                <select
                  value={nameSelect}
                  onChange={(e) => handleNameChange(e.target.value)}
                  disabled={!categorySelect}
                  required
                >
                  <option value="" disabled>
                    {categorySelect
                      ? "Select material..."
                      : "Select a category first"}
                  </option>
                  {catalogItems.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                  {categorySelect && (
                    <option value={OTHER}>
                      Other (type your own)...
                    </option>
                  )}
                </select>

                {nameSelect === OTHER && (
                  <input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="Enter material name"
                    required
                  />
                )}
              </>
            )}
          </label>

          <label>
            Quantity
            <input
              type="number"
              min="0"
              step="any"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
            />
          </label>

          <label>
            Unit
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            >
              <option value="piece">piece</option>
              <option value="bag">bag</option>
              <option value="box">box</option>
              <option value="meter">meter</option>
              <option value="liter">liter</option>
              <option value="kg">kg</option>
              <option value="set">set</option>
            </select>
          </label>

          {showMinimum && (
            <label>
              Minimum stock
              <input
                type="number"
                min="0"
                step="any"
                value={minimumStock}
                onChange={(e) => setMinimumStock(e.target.value)}
                required
              />
            </label>
          )}

          {showLocation && (
            <label>
              Location
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. Shelf A-03"
              />
            </label>
          )}

          {customColumns.map((col) => (
            <label key={col.key}>
              {col.label}
              <input
                type={col.type ?? "text"}
                step={col.type === "number" ? "any" : undefined}
                value={customValues[col.key] ?? ""}
                onChange={(e) =>
                  setCustomValues((previous) => ({
                    ...previous,
                    [col.key]: e.target.value,
                  }))
                }
              />
            </label>
          ))}
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="form-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
          >
            Cancel
          </button>

          <button
            type="submit"
            className="primary-button"
            disabled={saving}
          >
            {saving
              ? "Saving..."
              : editing
                ? "Save Changes"
                : "Add Item"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* --------------------------------------------------
   ATTACHMENTS (PROOFS)
-------------------------------------------------- */

function Proofs({
  transactionType,
  transactionId,
}: {
  transactionType: TransactionType;
  transactionId: number;
}) {
  const confirm = useConfirm();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [preview, setPreview] = useState<{
    name: string;
    type: string;
    url: string;
    blob: Blob;
  } | null>(null);

  function closePreview() {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  }

  /** Offline mode: pictures and videos open in the app, other files
   *  (PDF, Word, Excel...) are saved so another app can open them. */
  async function openLocal(attachment: Attachment) {
    setError("");

    try {
      const blob = await localGetAttachmentBlob(attachment.id);

      if (!blob) {
        setError("This file is missing from the device.");
        return;
      }

      const type = attachment.content_type;

      if (type.startsWith("image/") || type.startsWith("video/")) {
        setPreview({
          name: attachment.original_filename,
          type,
          url: URL.createObjectURL(blob),
          blob,
        });
      } else {
        await saveBlobAs(blob, attachment.original_filename, type);
      }
    } catch (error) {
      if (isCancelled(error)) return;

      console.error(error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not open the attachment."
      );
    }
  }

  const loadAttachments = useCallback(async () => {
    try {
      const data = await request<Attachment[]>(
        `/attachments/${transactionType}/${transactionId}`
      );
      setAttachments(data);
    } catch (error) {
      console.error(error);
    }
  }, [transactionType, transactionId]);

  useEffect(() => {
    loadAttachments();
  }, [loadAttachments]);

  async function handleFiles(
    event: React.ChangeEvent<HTMLInputElement>
  ) {
    const input = event.target;
    const files = input.files ? Array.from(input.files) : [];

    if (files.length === 0) {
      return;
    }

    setUploading(true);
    setError("");

    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);

        await request<Attachment>(
          `/attachments/${transactionType}/${transactionId}`,
          { method: "POST", body: formData }
        );
      }

      await loadAttachments();
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not upload attachment."
      );
    } finally {
      setUploading(false);
      input.value = "";
    }
  }

  async function deleteAttachment(attachment: Attachment) {
    const confirmed = await confirm({
      title: `Delete "${attachment.original_filename}"?`,
      message: "This attachment will be permanently removed.",
      confirmLabel: "Delete attachment",
    });

    if (!confirmed) {
      return;
    }

    setDeletingId(attachment.id);
    setError("");

    try {
      await request<null>(`/attachment-files/${attachment.id}`, {
        method: "DELETE",
      });

      await loadAttachments();
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not delete attachment."
      );
    } finally {
      setDeletingId(null);
    }
  }

  function getIcon(contentType: string) {
    if (contentType.startsWith("image/")) return "📷";
    if (contentType.startsWith("video/")) return "🎥";
    return "📄";
  }

  return (
    <div>
      <label className="secondary-button add-proof" title="Attach proofs">
        {uploading ? "..." : "+"}

        <input
          type="file"
          multiple
          accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
          onChange={handleFiles}
          disabled={uploading}
          style={{ display: "none" }}
        />
      </label>

      {attachments.length > 0 && (
        <div style={{ marginTop: "6px" }}>
          {attachments.map((attachment) => (
            <div key={attachment.id} className="proof-item">
              <a
                href={
                  LOCAL_MODE
                    ? "#"
                    : `${API}/attachment-files/${attachment.id}`
                }
                target={LOCAL_MODE ? undefined : "_blank"}
                rel="noreferrer"
                onClick={
                  LOCAL_MODE
                    ? (e) => {
                        e.preventDefault();
                        void openLocal(attachment);
                      }
                    : undefined
                }
              >
                {getIcon(attachment.content_type)}{" "}
                {attachment.original_filename}
              </a>

              <button
                type="button"
                className="remove-proof"
                title="Delete attachment"
                aria-label={`Delete ${attachment.original_filename}`}
                onClick={() => deleteAttachment(attachment)}
                disabled={deletingId === attachment.id}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <div className="form-error">{error}</div>}

      {preview && (
        <Modal title={preview.name} onClose={closePreview}>
          <div className="modal-body">
            {preview.type.startsWith("image/") ? (
              <img
                className="preview-media"
                src={preview.url}
                alt={preview.name}
              />
            ) : (
              <video
                className="preview-media"
                src={preview.url}
                controls
              />
            )}
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void saveBlobAs(
                  preview.blob,
                  preview.name,
                  preview.type
                ).catch((error) => {
                  if (!isCancelled(error)) {
                    setError("Could not save the file.");
                  }
                });
              }}
            >
              Save a copy
            </button>

            <button
              type="button"
              className="primary-button"
              onClick={closePreview}
            >
              Close
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* --------------------------------------------------
   BORROWINGS
-------------------------------------------------- */

function Borrowings({
  materials,
  borrowings,
  onRefresh,
}: {
  materials: Material[];
  borrowings: Borrowing[];
  onRefresh: () => void;
}) {
  const [showForm, setShowForm] = useState(false);

  const activeBorrowings = borrowings.filter(
    (b) => b.status === "active" || b.status === "partially_returned"
  );

  return (
    <>
      <div className="page-heading">
        <div>
          <h2>Borrowings</h2>
          <p>Track borrowed reusable materials</p>
        </div>

        <button
          className="primary-button"
          onClick={() => setShowForm(true)}
        >
          + New Borrowing
        </button>
      </div>

      {showForm && (
        <BorrowingForm
          materials={materials}
          onClose={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            onRefresh();
          }}
        />
      )}

      <section className="section">
        <div className="section-header">
          <h2>Active Borrowings</h2>
          <span className="count">
            {activeBorrowings.length} open
          </span>
        </div>

        {activeBorrowings.length === 0 ? (
          <div className="empty">No active borrowings.</div>
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Borrower</th>
                  <th>Quantity</th>
                  <th>Returned</th>
                  <th>Outstanding</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th>Remark</th>
                  <th>Proofs</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                {activeBorrowings.map((borrowing) => (
                  <BorrowingRow
                    key={borrowing.id}
                    borrowing={borrowing}
                    material={materials.find(
                      (item) => item.id === borrowing.material_id
                    )}
                    materials={materials}
                    onReturned={onRefresh}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/* --------------------------------------------------
   BORROWING FORM
-------------------------------------------------- */

function BorrowingForm({
  materials,
  onClose,
  onCreated,
}: {
  materials: Material[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const borrowableMaterials = materials.filter(
    (m) =>
      m.material_type === "reusable" &&
      m.borrowable &&
      m.quantity > 0
  );

  const [materialId, setMaterialId] = useState(
    borrowableMaterials[0]?.id.toString() || ""
  );
  const [borrowerName, setBorrowerName] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedMaterial = materials.find(
    (m) => m.id === Number(materialId)
  );

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    setSaving(true);
    setError("");

    try {
      await request<Borrowing>("/borrowings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          material_id: Number(materialId),
          borrower_name: borrowerName,
          quantity: Number(quantity),
          due_date: new Date(dueDate).toISOString(),
        }),
      });

      onCreated();
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not create borrowing."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form-panel">
      <div className="form-header">
        <div>
          <h3>New Borrowing</h3>
          <p>Record a reusable material being borrowed.</p>
        </div>

        <button
          type="button"
          className="close-button"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {borrowableMaterials.length === 0 ? (
        <div className="empty">
          No reusable materials are currently available for
          borrowing.
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <div className="form-grid">
            <label>
              Material
              <select
                value={materialId}
                onChange={(e) => setMaterialId(e.target.value)}
                required
              >
                {borrowableMaterials.map((material) => (
                  <option key={material.id} value={material.id}>
                    {material.name} — {formatQty(material.quantity, material.unit)} available
                  </option>
                ))}
              </select>
            </label>

            <label>
              Borrower name
              <input
                value={borrowerName}
                onChange={(e) => setBorrowerName(e.target.value)}
                placeholder="e.g. Juan Dela Cruz"
                required
              />
            </label>

            <label>
              Quantity
              <input
                type="number"
                min="0"
                step="any"
                max={selectedMaterial?.quantity || undefined}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
              />
            </label>

            <label>
              Due date
              <input
                type="datetime-local"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                required
              />
            </label>
          </div>

          {selectedMaterial && (
            <div className="form-info">
              Available:{" "}
              <strong>
                {formatQty(selectedMaterial.quantity, selectedMaterial.unit)}
              </strong>
            </div>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="form-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="primary-button"
              disabled={saving}
            >
              {saving ? "Recording..." : "Record Borrowing"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* --------------------------------------------------
   BORROWING ROW
-------------------------------------------------- */

function BorrowingRow({
  borrowing,
  material,
  materials,
  onReturned,
}: {
  borrowing: Borrowing;
  material?: Material;
  materials: Material[];
  onReturned: () => void;
}) {
  const [showReturnForm, setShowReturnForm] = useState(false);
  const [returnQuantity, setReturnQuantity] = useState("1");
  const [returning, setReturning] = useState(false);
  const [returnError, setReturnError] = useState("");

  const unit = material?.unit || "";
  const returnedQuantity = borrowing.returned_quantity || 0;
  const remainingQuantity = borrowing.quantity - returnedQuantity;

  const [returnRemark, setReturnRemark] = useState(
    borrowing.remark ?? ""
  );
  const returnNumber = Number(returnQuantity);
  const isPartialReturn =
    isValidQuantity(returnNumber) && returnNumber < remainingQuantity;

  const dueDate = parseDate(borrowing.due_date);
  const isOverdue = dueDate.getTime() < Date.now();

  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState(borrowing.borrower_name);
  const [editQuantity, setEditQuantity] = useState(
    String(borrowing.quantity)
  );
  const [editDue, setEditDue] = useState(toLocalInput(dueDate));
  const [editRemark, setEditRemark] = useState(
    borrowing.remark ?? ""
  );
  const [editMaterialId, setEditMaterialId] = useState(
    String(borrowing.material_id)
  );
  const [editReturned, setEditReturned] = useState(
    String(borrowing.returned_quantity || 0)
  );
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");

  const editMaterial = materials.find(
    (m) => m.id === Number(editMaterialId)
  );
  const editUnit = editMaterial?.unit || unit;
  const editMaterialOptions = materials.filter(
    (m) =>
      (m.material_type === "reusable" && m.borrowable) ||
      m.id === borrowing.material_id
  );

  function openEdit() {
    setEditName(borrowing.borrower_name);
    setEditQuantity(String(borrowing.quantity));
    setEditDue(toLocalInput(parseDate(borrowing.due_date)));
    setEditMaterialId(String(borrowing.material_id));
    setEditReturned(String(borrowing.returned_quantity || 0));
    setEditRemark(borrowing.remark ?? "");
    setEditError("");
    setShowReturnForm(false);
    setShowEdit(true);
  }

  async function handleSaveEdit() {
    const quantity = Number(editQuantity);
    const due = new Date(editDue);

    if (!editName.trim()) {
      setEditError("Borrower name is required.");
      return;
    }

    if (!isValidQuantity(quantity)) {
      setEditError("Enter a quantity greater than zero.");
      return;
    }

    const returned = Number(editReturned);

    if (!Number.isFinite(returned) || returned < 0) {
      setEditError("Returned quantity cannot be negative.");
      return;
    }

    if (returned > quantity) {
      setEditError(
        "Returned quantity cannot be more than the quantity."
      );
      return;
    }

    if (Number.isNaN(due.getTime())) {
      setEditError("Enter a valid due date.");
      return;
    }

    setSavingEdit(true);
    setEditError("");

    try {
      await request<Borrowing>(`/borrowings/${borrowing.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          material_id: Number(editMaterialId),
          borrower_name: editName.trim(),
          quantity,
          returned_quantity: returned,
          due_date: due.toISOString(),
          remark: editRemark,
        }),
      });

      setShowEdit(false);
      onReturned();
    } catch (error) {
      console.error(error);
      setEditError(
        error instanceof Error
          ? error.message
          : "Could not save changes."
      );
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleReturn() {
    const quantity = Number(returnQuantity);

    if (!isValidQuantity(quantity)) {
      setReturnError("Enter a return quantity greater than zero.");
      return;
    }

    if (quantity > remainingQuantity) {
      setReturnError(
        `Only ${formatQty(remainingQuantity, unit || "item")} outstanding.`
      );
      return;
    }

    setReturning(true);
    setReturnError("");

    try {
      await request<Borrowing>(
        `/borrowings/${borrowing.id}/return`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quantity,
            // Only a partial return needs a note about the rest
            ...(quantity < remainingQuantity
              ? { remark: returnRemark }
              : {}),
          }),
        }
      );

      setShowReturnForm(false);
      setReturnQuantity("1");
      onReturned();
    } catch (error) {
      console.error(error);
      setReturnError(
        error instanceof Error
          ? error.message
          : "Could not return item."
      );
    } finally {
      setReturning(false);
    }
  }

  return (
    <>
      <tr>
        <td>
          <strong>
            {material?.name || `Material #${borrowing.material_id}`}
          </strong>
        </td>

        <td>{borrowing.borrower_name}</td>

        <td>
          {formatQty(borrowing.quantity, unit)}
        </td>

        <td>
          {formatQty(returnedQuantity, unit)}
        </td>

        <td>
          <strong>
            {formatQty(remainingQuantity, unit)}
          </strong>
        </td>

        <td>{dueDate.toLocaleDateString()}</td>

        <td>
          <span
            className={
              isOverdue
                ? "status danger"
                : borrowing.status === "partially_returned"
                  ? "status warning"
                  : "status good"
            }
          >
            {isOverdue
              ? "Overdue"
              : borrowing.status === "partially_returned"
                ? "Partial"
                : "Active"}
          </span>
        </td>

        <td>
          {borrowing.remark ? (
            <span className="remark">{borrowing.remark}</span>
          ) : (
            "—"
          )}
        </td>

        <td>
          <Proofs
            transactionType="borrowing"
            transactionId={borrowing.id}
          />
        </td>

        <td className="table-actions">
          <div className="row-actions">
            <button
              className="secondary-button"
              onClick={openEdit}
              disabled={returning || savingEdit}
            >
              Edit
            </button>

            <button
              className="secondary-button"
              onClick={() => {
                setShowEdit(false);
                setShowReturnForm(true);
                setReturnError("");
                setReturnQuantity("1");
                setReturnRemark(borrowing.remark ?? "");
              }}
              disabled={returning || remainingQuantity <= 0}
            >
              Return
            </button>
          </div>
        </td>
      </tr>

      {showReturnForm && (
        <tr className="return-row">
          <td colSpan={10}>
            <div className="inline-return-form">
              <div>
                <strong>Return {material?.name}</strong>
                <span>
                  {" "}
                  — {formatQty(remainingQuantity, unit || "item")} outstanding
                </span>
              </div>

              <label>
                Quantity
                <input
                  type="number"
                  min="0"
                  step="any"
                  max={remainingQuantity}
                  value={returnQuantity}
                  onChange={(e) =>
                    setReturnQuantity(e.target.value)
                  }
                />
              </label>

              {isPartialReturn && (
                <label className="remark-field">
                  Remark
                  <input
                    value={returnRemark}
                    onChange={(e) => setReturnRemark(e.target.value)}
                    placeholder="e.g. Borrower B will return the rest tomorrow"
                  />
                </label>
              )}

              {returnError && (
                <span className="form-error">{returnError}</span>
              )}

              <button
                className="secondary-button"
                onClick={() => {
                  setShowReturnForm(false);
                  setReturnError("");
                }}
                disabled={returning}
              >
                Cancel
              </button>

              <button
                className="primary-button"
                onClick={handleReturn}
                disabled={returning}
              >
                {returning ? "Returning..." : "Confirm"}
              </button>
            </div>
          </td>
        </tr>
      )}

      {showEdit && (
        <tr className="edit-row">
          <td colSpan={10}>
            <div className="inline-edit-form">
              <strong>
                Edit borrowing of {material?.name || "material"}
              </strong>

              <label>
                Material
                <select
                  value={editMaterialId}
                  onChange={(e) => setEditMaterialId(e.target.value)}
                >
                  {editMaterialOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({formatQty(m.quantity, m.unit)} in stock)
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Borrower name
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </label>

              <label>
                Quantity{editUnit ? ` (${editUnit})` : ""}
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={editQuantity}
                  onChange={(e) => setEditQuantity(e.target.value)}
                />
              </label>

              <label>
                Returned{editUnit ? ` (${editUnit})` : ""}
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={editReturned}
                  onChange={(e) => setEditReturned(e.target.value)}
                />
              </label>

              <label>
                Due date
                <input
                  type="datetime-local"
                  value={editDue}
                  onChange={(e) => setEditDue(e.target.value)}
                />
              </label>

              <label className="wide">
                Remark
                <input
                  value={editRemark}
                  onChange={(e) => setEditRemark(e.target.value)}
                  placeholder="e.g. Borrower B will return the rest tomorrow"
                />
              </label>

              <span className="edit-note">
                Changing the material, quantity or returned amount
                adjusts the warehouse stock automatically.
              </span>

              {editError && (
                <span className="form-error">{editError}</span>
              )}

              <div className="edit-actions">
                <button
                  className="secondary-button"
                  onClick={() => setShowEdit(false)}
                  disabled={savingEdit}
                >
                  Cancel
                </button>

                <button
                  className="primary-button"
                  onClick={handleSaveEdit}
                  disabled={savingEdit}
                >
                  {savingEdit ? "Saving..." : "Save changes"}
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* --------------------------------------------------
   CONSUMED
-------------------------------------------------- */

function Consumed({
  materials,
  issues,
  onRefresh,
}: {
  materials: Material[];
  issues: MaterialIssue[];
  onRefresh: () => void;
}) {
  const [showForm, setShowForm] = useState(false);

  return (
    <>
      <div className="page-heading">
        <div>
          <h2>Consumed</h2>
          <p>Record materials used or issued for consumption</p>
        </div>

        <button
          className="primary-button"
          onClick={() => setShowForm(true)}
        >
          + Record Consumption
        </button>
      </div>

      {showForm && (
        <ConsumptionForm
          materials={materials}
          onClose={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            onRefresh();
          }}
        />
      )}

      <section className="section">
        <div className="section-header">
          <h2>Consumption History</h2>
          <span className="count">{countOf(issues.length, "record")}</span>
        </div>

        {issues.length === 0 ? (
          <div className="empty">No consumption records yet.</div>
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Issued To</th>
                  <th>Quantity</th>
                  <th>Project</th>
                  <th>Purpose</th>
                  <th>Issued</th>
                  <th>Status</th>
                  <th>Proofs</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                {issues.map((issue) => (
                  <ConsumptionRow
                    key={issue.id}
                    issue={issue}
                    material={materials.find(
                      (item) => item.id === issue.material_id
                    )}
                    materials={materials}
                    onSaved={onRefresh}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/* --------------------------------------------------
   CONSUMPTION ROW
-------------------------------------------------- */

function ConsumptionRow({
  issue,
  material,
  materials,
  onSaved,
}: {
  issue: MaterialIssue;
  material?: Material;
  materials: Material[];
  onSaved: () => void;
}) {
  const [showEdit, setShowEdit] = useState(false);
  const [issuedTo, setIssuedTo] = useState(issue.issued_to);
  const [quantity, setQuantity] = useState(String(issue.quantity));
  const [project, setProject] = useState(issue.project ?? "");
  const [purpose, setPurpose] = useState(issue.purpose ?? "");
  const [materialId, setMaterialId] = useState(
    String(issue.material_id)
  );
  const [issuedAt, setIssuedAt] = useState(
    toLocalInput(parseDate(issue.issued_at))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selected = materials.find((m) => m.id === Number(materialId));
  const unit = selected?.unit || material?.unit || "";
  const materialOptions = materials.filter(
    (m) =>
      m.material_type === "consumable" || m.id === issue.material_id
  );

  function openEdit() {
    setIssuedTo(issue.issued_to);
    setQuantity(String(issue.quantity));
    setProject(issue.project ?? "");
    setPurpose(issue.purpose ?? "");
    setMaterialId(String(issue.material_id));
    setIssuedAt(toLocalInput(parseDate(issue.issued_at)));
    setError("");
    setShowEdit(true);
  }

  async function handleSave() {
    const amount = Number(quantity);

    if (!issuedTo.trim()) {
      setError("'Issued to' is required.");
      return;
    }

    if (!isValidQuantity(amount)) {
      setError("Enter a quantity greater than zero.");
      return;
    }

    const issuedDate = new Date(issuedAt);

    if (Number.isNaN(issuedDate.getTime())) {
      setError("Enter a valid issued date.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      await request<MaterialIssue>(`/issues/${issue.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          material_id: Number(materialId),
          issued_to: issuedTo.trim(),
          quantity: amount,
          project,
          purpose,
          issued_at: issuedDate.toISOString(),
        }),
      });

      setShowEdit(false);
      onSaved();
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not save changes."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <tr>
        <td>
          <strong>
            {material?.name || `Material #${issue.material_id}`}
          </strong>
        </td>
        <td>{issue.issued_to}</td>
        <td>
          {formatQty(issue.quantity, unit)}
        </td>
        <td>{issue.project || "—"}</td>
        <td>{issue.purpose || "—"}</td>
        <td>{parseDate(issue.issued_at).toLocaleDateString()}</td>
        <td>
          <span className="status consumed">Consumed</span>
        </td>
        <td>
          <Proofs transactionType="issue" transactionId={issue.id} />
        </td>
        <td className="table-actions">
          <button
            className="secondary-button"
            onClick={openEdit}
            disabled={saving}
          >
            Edit
          </button>
        </td>
      </tr>

      {showEdit && (
        <tr className="edit-row">
          <td colSpan={9}>
            <div className="inline-edit-form">
              <strong>
                Edit consumption of {material?.name || "material"}
              </strong>

              <label>
                Material
                <select
                  value={materialId}
                  onChange={(e) => setMaterialId(e.target.value)}
                >
                  {materialOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({formatQty(m.quantity, m.unit)} in stock)
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Issued to
                <input
                  value={issuedTo}
                  onChange={(e) => setIssuedTo(e.target.value)}
                />
              </label>

              <label>
                Quantity{unit ? ` (${unit})` : ""}
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </label>

              <label>
                Project
                <input
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                />
              </label>

              <label>
                Purpose
                <input
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                />
              </label>

              <label>
                Issued date
                <input
                  type="datetime-local"
                  value={issuedAt}
                  onChange={(e) => setIssuedAt(e.target.value)}
                />
              </label>

              <span className="edit-note">
                Changing the material, quantity or returned amount
                adjusts the warehouse stock automatically.
              </span>

              {error && <span className="form-error">{error}</span>}

              <div className="edit-actions">
                <button
                  className="secondary-button"
                  onClick={() => setShowEdit(false)}
                  disabled={saving}
                >
                  Cancel
                </button>

                <button
                  className="primary-button"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save changes"}
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* --------------------------------------------------
   CONSUMPTION FORM
-------------------------------------------------- */

function ConsumptionForm({
  materials,
  onClose,
  onCreated,
}: {
  materials: Material[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const consumableMaterials = materials.filter(
    (m) => m.material_type === "consumable" && m.quantity > 0
  );

  const [materialId, setMaterialId] = useState(
    consumableMaterials[0]?.id.toString() || ""
  );
  const [issuedTo, setIssuedTo] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [project, setProject] = useState("");
  const [purpose, setPurpose] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedMaterial = materials.find(
    (m) => m.id === Number(materialId)
  );

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    setSaving(true);
    setError("");

    try {
      await request<MaterialIssue>("/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          material_id: Number(materialId),
          issued_to: issuedTo,
          quantity: Number(quantity),
          project: project || null,
          purpose: purpose || null,
        }),
      });

      onCreated();
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not record consumption."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form-panel">
      <div className="form-header">
        <div>
          <h3>Record Consumption</h3>
          <p>
            Record consumable material used or issued from the
            warehouse.
          </p>
        </div>

        <button
          type="button"
          className="close-button"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {consumableMaterials.length === 0 ? (
        <div className="empty">
          No consumable materials are currently available.
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <div className="form-grid">
            <label>
              Material
              <select
                value={materialId}
                onChange={(e) => setMaterialId(e.target.value)}
                required
              >
                {consumableMaterials.map((material) => (
                  <option key={material.id} value={material.id}>
                    {material.name} — {formatQty(material.quantity, material.unit)} available
                  </option>
                ))}
              </select>
            </label>

            <label>
              Issued to
              <input
                value={issuedTo}
                onChange={(e) => setIssuedTo(e.target.value)}
                placeholder="e.g. Juan Dela Cruz"
                required
              />
            </label>

            <label>
              Quantity
              <input
                type="number"
                min="0"
                step="any"
                max={selectedMaterial?.quantity || undefined}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
              />
            </label>

            <label>
              Project
              <input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder="e.g. Building A"
              />
            </label>

            <label>
              Purpose
              <input
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="e.g. Foundation work"
              />
            </label>
          </div>

          {selectedMaterial && (
            <div className="form-info">
              Available:{" "}
              <strong>
                {formatQty(selectedMaterial.quantity, selectedMaterial.unit)}
              </strong>
            </div>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="form-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="primary-button"
              disabled={saving}
            >
              {saving ? "Recording..." : "Record Consumption"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* --------------------------------------------------
   ALERTS
-------------------------------------------------- */

function Alerts({ alerts }: { alerts: WarehouseAlert[] }) {
  return (
    <>
      <div className="page-heading">
        <div>
          <h2>Alerts</h2>
          <p>Items that require attention</p>
        </div>
      </div>

      {alerts.length === 0 ? (
        <div className="empty">No active alerts.</div>
      ) : (
        <div className="alerts">
          {alerts.map((alert, index) => (
            <div
              className={`alert ${alert.severity}`}
              key={`${alert.type}-${alert.borrowing_id ?? ""}-${alert.material_id ?? ""}-${index}`}
            >
              <span className="alert-icon" aria-hidden="true" />

              <div>
                <strong>
                  {alert.type.replace(/_/g, " ").toUpperCase()}
                </strong>

                <p>{alert.message}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function App() {
  return (
    <FeedbackProvider>
      <AppInner />
    </FeedbackProvider>
  );
}

export default App;