/**
 * Offline data layer.
 *
 * Does what the FastAPI backend does (same rules, same messages, same
 * data shapes), but stores everything on the device in IndexedDB.
 * App.tsx calls it through request() whenever the app runs in local mode.
 */

import JSZip from "jszip";

import { idbClear, idbDelete, idbGet, idbPut } from "./localdb";
import { formatQty, plural } from "./format";

/* --------------------------------------------------
   TYPES  (same field names as the server's database,
   so backups can be moved between phone and server)
-------------------------------------------------- */

type Kind = "consumable" | "reusable";
type StoreName =
  | "tables"
  | "materials"
  | "borrowings"
  | "issues"
  | "attachments";

type TableRow = {
  id: number;
  name: string;
  kind: Kind;
  columns: Record<string, unknown>[] | null;
  created_at: string;
};

type MaterialRow = {
  id: number;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  minimum_stock: number;
  borrowable: boolean;
  location: string | null;
  created_at: string;
  material_type: Kind;
  custom_data: Record<string, string> | null;
  table_id: number | null;
};

type BorrowingRow = {
  id: number;
  material_id: number;
  borrower_name: string;
  quantity: number;
  returned_quantity: number;
  borrowed_at: string;
  due_date: string;
  returned_at: string | null;
  status: string;
  remark: string | null;
};

type IssueRow = {
  id: number;
  material_id: number;
  issued_to: string;
  quantity: number;
  project: string | null;
  purpose: string | null;
  issued_at: string;
};

type AttachmentRow = {
  id: number;
  transaction_type: "borrowing" | "issue";
  transaction_id: number;
  original_filename: string;
  stored_filename: string;
  content_type: string;
  file_path: string;
  uploaded_at: string;
};

type State = {
  nextId: Record<StoreName, number>;
  tables: TableRow[];
  materials: MaterialRow[];
  borrowings: BorrowingRow[];
  issues: IssueRow[];
  attachments: AttachmentRow[];
  settings: Record<string, string>;
};

type Body = Record<string, unknown>;
type RequestBody = Body | FormData | null;

type Context = {
  /** async work that must finish BEFORE the data is saved (writing files) */
  pre: (() => Promise<void>)[];
  /** async work done AFTER the data is saved (removing files) */
  post: (() => Promise<void>)[];
};

/* --------------------------------------------------
   CONSTANTS
-------------------------------------------------- */

const EXPORT_APP = "construction-warehouse";
const EXPORT_VERSION = 1;
const DATA_FILE = "warehouse-data.json";

const MAX_NAME_LENGTH = 60;
const VALID_KINDS = new Set<string>(["consumable", "reusable"]);

const SETTING_DEFAULTS: Record<string, string> = {
  system_name: "6dchair's CIMS (Hi! This is ur system name, u can change it in MENU ->)",
  admin_name: "",
  accent_color: "#1f47c8",
};

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

/** Some phones give files an empty type, so fall back to the extension. */
const EXTENSION_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/* --------------------------------------------------
   SMALL HELPERS
-------------------------------------------------- */

function fail(detail: string): never {
  throw new Error(detail);
}

function isObject(value: unknown): value is Body {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Avoid 0.1 + 0.2 = 0.30000000000000004 in stock figures. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function numberOf(value: unknown, label: string): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;

  if (!Number.isFinite(n)) fail(`${label} must be a number`);

  return n;
}

function stringOf(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} is required`);

  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function nowIso(): string {
  // Naive UTC, like the server stores it
  return new Date().toISOString().replace("Z", "");
}

/** Accept any ISO date and store it as naive UTC. */
function toNaiveUtc(value: unknown): string {
  if (typeof value !== "string") fail("A valid date is required");

  const hasTimezone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  const date = new Date(hasTimezone ? value : `${value}Z`);

  if (Number.isNaN(date.getTime())) fail("A valid date is required");

  return hasTimezone ? date.toISOString().replace("Z", "") : value;
}

function randomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);

  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sortById<T extends { id: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.id - b.id);
}

function json(body: RequestBody): Body {
  if (!isObject(body)) fail("A request body is required");

  return body;
}

/* --------------------------------------------------
   STATE (kept in memory, saved to IndexedDB after every change)
-------------------------------------------------- */

function emptyState(): State {
  return {
    nextId: {
      tables: 1,
      materials: 1,
      borrowings: 1,
      issues: 1,
      attachments: 1,
    },
    tables: [],
    materials: [],
    borrowings: [],
    issues: [],
    attachments: [],
    settings: {},
  };
}

let state: State | null = null;
let loading: Promise<State> | null = null;

async function getState(): Promise<State> {
  if (state) return state;

  if (!loading) {
    loading = (async () => {
      const saved = await idbGet<State>("kv", "state");

      state = saved ? { ...emptyState(), ...saved } : emptyState();

      // Ask the browser not to clear our data when storage runs low
      try {
        await navigator.storage?.persist?.();
      } catch {
        // not supported: ignore
      }

      return state;
    })();
  }

  return loading;
}

function persist(): Promise<void> {
  return idbPut("kv", "state", state);
}

/* --------------------------------------------------
   ENTRY POINT  (mirrors request(path, options))
-------------------------------------------------- */

export async function localRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const s = await getState();

  const method = (options.method ?? "GET").toUpperCase();
  const url = new URL(path, "http://local");
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);

  if (method === "POST" && segments[0] === "import") {
    const body = options.body;
    const file = body instanceof FormData ? body.get("file") : null;

    if (!(file instanceof File)) fail("No file was uploaded");

    return (await importBackup(file)) as T;
  }

  let body: RequestBody = null;

  if (typeof options.body === "string") {
    try {
      const parsed: unknown = JSON.parse(options.body);
      body = isObject(parsed) ? parsed : null;
    } catch {
      fail("The request was not valid");
    }
  } else if (options.body instanceof FormData) {
    body = options.body;
  }

  const context: Context = { pre: [], post: [] };

  if (method === "GET") {
    return toResult<T>(route(s, context, method, segments, url, body));
  }

  // Take a copy first so a failed request leaves nothing half-changed
  const snapshot = clone(s);

  try {
    const result = route(s, context, method, segments, url, body);

    for (const task of context.pre) await task();
    await persist();

    for (const task of context.post) {
      try {
        await task();
      } catch (error) {
        console.error(error);
      }
    }

    return toResult<T>(result);
  } catch (error) {
    state = snapshot;
    loading = Promise.resolve(snapshot);

    throw error instanceof Error ? error : new Error("Something went wrong");
  }
}

function toResult<T>(value: unknown): T {
  return (value === undefined ? null : clone(value)) as T;
}

/** The stored file of a proof, for viewing or saving. */
export async function localGetAttachmentBlob(
  attachmentId: number
): Promise<Blob | null> {
  return (await idbGet<Blob>("blobs", attachmentId)) ?? null;
}

/* --------------------------------------------------
   ROUTER
-------------------------------------------------- */

function route(
  s: State,
  ctx: Context,
  method: string,
  segments: string[],
  url: URL,
  body: RequestBody
): unknown {
  const [root, second, third] = segments;
  const id = second !== undefined ? Number(second) : NaN;
  const hasId = second !== undefined;

  if (root === "materials") {
    if (method === "GET" && !hasId) return sortById(s.materials);
    if (method === "POST" && !hasId) return createMaterial(s, json(body));
    if (method === "PUT" && hasId) return updateMaterial(s, id, json(body));
    if (method === "DELETE" && hasId) return deleteMaterial(s, id);
  }

  if (root === "issues") {
    if (method === "GET" && !hasId) {
      return [...s.issues].sort(
        (a, b) =>
          b.issued_at.localeCompare(a.issued_at) || b.id - a.id
      );
    }
    if (method === "POST" && !hasId) return createIssue(s, json(body));
    if (method === "PUT" && hasId) return updateIssue(s, id, json(body));
  }

  if (root === "borrowings") {
    if (method === "GET" && !hasId) {
      return [...s.borrowings].sort((a, b) => b.id - a.id);
    }
    if (method === "POST" && !hasId) return createBorrowing(s, json(body));
    if (method === "POST" && hasId && third === "return") {
      return returnBorrowing(s, id, json(body));
    }
    if (method === "PUT" && hasId && !third) {
      return updateBorrowing(s, id, json(body));
    }
  }

  if (root === "alerts" && method === "GET") return buildAlerts(s);

  if (root === "attachments" && hasId === true && third !== undefined) {
    const type = second;
    const transactionId = Number(third);

    if (method === "POST") {
      return uploadAttachment(s, ctx, type, transactionId, body);
    }
    if (method === "GET") return listAttachments(s, type, transactionId);
  }

  if (root === "attachment-files" && method === "DELETE" && hasId) {
    return deleteAttachment(s, ctx, id);
  }

  if (root === "settings") {
    if (method === "GET") return readSettings(s);
    if (method === "PUT") return updateSettings(s, json(body));
  }

  if (root === "tables") {
    if (method === "GET" && !hasId) return sortById(s.tables);
    if (method === "POST" && !hasId) return createTable(s, json(body));
    if (method === "PUT" && hasId) return updateTable(s, id, json(body));
    if (method === "DELETE" && hasId) {
      return deleteTable(s, ctx, id, url.searchParams.get("force") === "true");
    }
  }

  return fail(`Not found: ${method} ${url.pathname}`);
}

/* --------------------------------------------------
   MATERIALS
-------------------------------------------------- */

function materialHasHistory(s: State, materialId: number): boolean {
  return (
    s.borrowings.some((b) => b.material_id === materialId) ||
    s.issues.some((i) => i.material_id === materialId)
  );
}

function customDataOf(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};

  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, String(v ?? "")])
  );
}

function createMaterial(s: State, b: Body): MaterialRow {
  const table = s.tables.find((t) => t.id === b.table_id);

  if (!table) fail("Choose a table for this item");

  const name = stringOf(b.name, "Material name").trim();
  const category = stringOf(b.category, "Category").trim();
  const unit = stringOf(b.unit, "Unit").trim();

  if (!name) fail("Material name is required");
  if (!category) fail("Category is required");
  if (!unit) fail("Unit is required");

  const quantity =
    b.quantity == null ? 0 : numberOf(b.quantity, "Quantity");
  const minimum =
    b.minimum_stock == null
      ? 0
      : numberOf(b.minimum_stock, "Minimum stock");

  if (quantity < 0 || minimum < 0) {
    fail("Quantity and minimum stock cannot be negative");
  }

  const material: MaterialRow = {
    id: s.nextId.materials++,
    name,
    category,
    quantity,
    unit,
    minimum_stock: minimum,
    borrowable: table.kind === "reusable",
    location: typeof b.location === "string" ? b.location : null,
    created_at: nowIso(),
    material_type: table.kind,
    custom_data: customDataOf(b.custom_data),
    table_id: table.id,
  };

  s.materials.push(material);

  return material;
}

function updateMaterial(s: State, id: number, b: Body): MaterialRow {
  const material = s.materials.find((m) => m.id === id);

  if (!material) fail("Material not found");

  const quantity = numberOf(b.quantity ?? 0, "Quantity");
  const minimum = numberOf(b.minimum_stock ?? 0, "Minimum stock");

  if (quantity < 0 || minimum < 0) {
    fail("Quantity and minimum stock cannot be negative");
  }

  material.name = stringOf(b.name, "Material name");
  material.category = stringOf(b.category, "Category");
  material.quantity = quantity;
  material.unit = stringOf(b.unit, "Unit");
  material.minimum_stock = minimum;
  material.location = typeof b.location === "string" ? b.location : null;
  material.custom_data = customDataOf(b.custom_data);

  return material;
}

function deleteMaterial(s: State, id: number): undefined {
  const material = s.materials.find((m) => m.id === id);

  if (!material) fail("Material not found");

  if (materialHasHistory(s, id)) {
    fail(
      "Cannot delete this material because it has borrowing or consumption records"
    );
  }

  s.materials = s.materials.filter((m) => m.id !== id);

  return undefined;
}

/* --------------------------------------------------
   BORROWINGS
-------------------------------------------------- */

function createBorrowing(s: State, b: Body): BorrowingRow {
  const material = s.materials.find((m) => m.id === b.material_id);

  if (!material) fail("Material not found");
  if (!material.borrowable) fail("This material cannot be borrowed");

  const quantity = numberOf(b.quantity, "Quantity");
  const borrower = stringOf(b.borrower_name, "Borrower name").trim();

  if (quantity <= 0) fail("Quantity must be greater than zero");
  if (!borrower) fail("Borrower name is required");
  if (quantity > material.quantity) fail("Not enough stock available");

  const due = toNaiveUtc(b.due_date);

  material.quantity = round(material.quantity - quantity);

  const borrowing: BorrowingRow = {
    id: s.nextId.borrowings++,
    material_id: material.id,
    borrower_name: borrower,
    quantity,
    returned_quantity: 0,
    borrowed_at: nowIso(),
    due_date: due,
    returned_at: null,
    status: "active",
    remark: null,
  };

  s.borrowings.push(borrowing);

  return borrowing;
}

function returnBorrowing(s: State, id: number, b: Body): BorrowingRow {
  const borrowing = s.borrowings.find((x) => x.id === id);

  if (!borrowing) fail("Borrowing record not found");

  if (borrowing.status === "returned") {
    fail("This borrowing has already been fully returned");
  }

  const quantity = numberOf(b.quantity, "Return quantity");

  if (quantity <= 0) fail("Return quantity must be greater than zero");

  const remaining = round(borrowing.quantity - borrowing.returned_quantity);

  if (quantity > remaining) {
    fail(
      `Cannot return ${formatQty(quantity)}. ` +
        `Only ${formatQty(remaining, "item")} ` +
        `${remaining === 1 ? "is" : "are"} still outstanding.`
    );
  }

  const material = s.materials.find((m) => m.id === borrowing.material_id);

  if (!material) fail("Material not found");

  // Restore only the quantity actually returned
  material.quantity = round(material.quantity + quantity);
  borrowing.returned_quantity = round(borrowing.returned_quantity + quantity);

  // Optional admin note (blank clears it)
  if (typeof b.remark === "string") {
    borrowing.remark = b.remark.trim() || null;
  }

  if (borrowing.returned_quantity >= borrowing.quantity) {
    borrowing.returned_at = nowIso();
    borrowing.status = "returned";
  } else {
    borrowing.status = "partially_returned";
  }

  return borrowing;
}

function updateBorrowing(s: State, id: number, b: Body): BorrowingRow {
  const borrowing = s.borrowings.find((x) => x.id === id);

  if (!borrowing) fail("Borrowing record not found");

  let newName = borrowing.borrower_name;

  if (typeof b.borrower_name === "string") {
    newName = b.borrower_name.trim();

    if (!newName) fail("Borrower name is required");
  }

  const newMaterialId =
    b.material_id == null
      ? borrowing.material_id
      : numberOf(b.material_id, "Material");
  const newQuantity =
    b.quantity == null ? borrowing.quantity : numberOf(b.quantity, "Quantity");
  const newReturned =
    b.returned_quantity == null
      ? borrowing.returned_quantity
      : numberOf(b.returned_quantity, "Returned quantity");

  if (newQuantity <= 0) fail("Quantity must be greater than zero");
  if (newReturned < 0) fail("Returned quantity cannot be negative");
  if (newReturned > newQuantity) {
    fail("Returned quantity cannot be more than the quantity");
  }

  const oldMaterial = s.materials.find((m) => m.id === borrowing.material_id);
  const newMaterial = s.materials.find((m) => m.id === newMaterialId);

  if (!newMaterial) fail("Material not found");

  const materialChanged = newMaterialId !== borrowing.material_id;

  if (materialChanged && !newMaterial.borrowable) {
    fail("This material cannot be borrowed");
  }

  // Stock taken out of the warehouse = borrowed - returned
  const oldOut = round(borrowing.quantity - borrowing.returned_quantity);
  const newOut = round(newQuantity - newReturned);

  const available = newMaterial.quantity + (materialChanged ? 0 : oldOut);

  if (newOut > available) {
    fail("Not enough stock available for those changes");
  }

  const dueDate =
    b.due_date == null ? borrowing.due_date : toNaiveUtc(b.due_date);

  if (oldMaterial) oldMaterial.quantity = round(oldMaterial.quantity + oldOut);
  newMaterial.quantity = round(newMaterial.quantity - newOut);

  borrowing.material_id = newMaterialId;
  borrowing.borrower_name = newName;
  borrowing.quantity = newQuantity;
  borrowing.returned_quantity = newReturned;
  borrowing.due_date = dueDate;

  if (typeof b.remark === "string") {
    borrowing.remark = b.remark.trim() || null;
  }

  if (newReturned >= newQuantity) {
    borrowing.status = "returned";

    if (borrowing.returned_at === null) borrowing.returned_at = nowIso();
  } else {
    borrowing.returned_at = null;
    borrowing.status = newReturned > 0 ? "partially_returned" : "active";
  }

  return borrowing;
}

/* --------------------------------------------------
   CONSUMPTION ("issues")
-------------------------------------------------- */

function createIssue(s: State, b: Body): IssueRow {
  const material = s.materials.find((m) => m.id === b.material_id);

  if (!material) fail("Material not found");

  if (material.material_type !== "consumable") {
    fail("Only consumable materials can be issued");
  }

  const quantity = numberOf(b.quantity, "Quantity");
  const issuedTo = stringOf(b.issued_to, "Issued to").trim();

  if (quantity <= 0) fail("Quantity must be greater than zero");
  if (!issuedTo) fail("'Issued to' is required");
  if (quantity > material.quantity) fail("Not enough stock available");

  material.quantity = round(material.quantity - quantity);

  const issue: IssueRow = {
    id: s.nextId.issues++,
    material_id: material.id,
    issued_to: issuedTo,
    quantity,
    project: optionalText(b.project),
    purpose: optionalText(b.purpose),
    issued_at: nowIso(),
  };

  s.issues.push(issue);

  return issue;
}

function updateIssue(s: State, id: number, b: Body): IssueRow {
  const issue = s.issues.find((x) => x.id === id);

  if (!issue) fail("Consumption record not found");

  let newIssuedTo = issue.issued_to;

  if (typeof b.issued_to === "string") {
    newIssuedTo = b.issued_to.trim();

    if (!newIssuedTo) fail("'Issued to' is required");
  }

  const newMaterialId =
    b.material_id == null
      ? issue.material_id
      : numberOf(b.material_id, "Material");
  const newQuantity =
    b.quantity == null ? issue.quantity : numberOf(b.quantity, "Quantity");

  if (newQuantity <= 0) fail("Quantity must be greater than zero");

  const oldMaterial = s.materials.find((m) => m.id === issue.material_id);
  const newMaterial = s.materials.find((m) => m.id === newMaterialId);

  if (!newMaterial) fail("Material not found");

  const materialChanged = newMaterialId !== issue.material_id;

  if (materialChanged && newMaterial.material_type !== "consumable") {
    fail("Only consumable materials can be issued");
  }

  const available =
    newMaterial.quantity + (materialChanged ? 0 : issue.quantity);

  if (newQuantity > available) {
    fail("Not enough stock available for those changes");
  }

  const issuedAt =
    b.issued_at == null ? issue.issued_at : toNaiveUtc(b.issued_at);

  if (oldMaterial) {
    oldMaterial.quantity = round(oldMaterial.quantity + issue.quantity);
  }
  newMaterial.quantity = round(newMaterial.quantity - newQuantity);

  issue.material_id = newMaterialId;
  issue.issued_to = newIssuedTo;
  issue.quantity = newQuantity;
  issue.issued_at = issuedAt;

  if (typeof b.project === "string") issue.project = b.project.trim() || null;
  if (typeof b.purpose === "string") issue.purpose = b.purpose.trim() || null;

  return issue;
}

/* --------------------------------------------------
   ALERTS  (dates are compared in the phone's own time zone)
-------------------------------------------------- */

function buildAlerts(s: State): Record<string, unknown>[] {
  const alerts: Record<string, unknown>[] = [];

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (const borrowing of s.borrowings) {
    if (borrowing.status !== "active") continue;

    const material = s.materials.find((m) => m.id === borrowing.material_id);

    if (!material) continue;

    const due = new Date(`${borrowing.due_date}Z`);
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    const daysLate = Math.round(
      (today.getTime() - dueDay.getTime()) / 86400000
    );

    const base = `${material.name} borrowed by ${borrowing.borrower_name} is`;

    if (daysLate > 0) {
      alerts.push({
        type: "overdue",
        severity: "critical",
        message: `${base} ${daysLate} ${plural(daysLate, "day")} overdue`,
        borrowing_id: borrowing.id,
        material_id: material.id,
      });
    } else if (daysLate === 0) {
      alerts.push({
        type: "due_today",
        severity: "warning",
        message: `${base} due today`,
        borrowing_id: borrowing.id,
        material_id: material.id,
      });
    } else if (daysLate === -1) {
      alerts.push({
        type: "due_soon",
        severity: "info",
        message: `${base} due tomorrow`,
        borrowing_id: borrowing.id,
        material_id: material.id,
      });
    }
  }

  for (const material of sortById(s.materials)) {
    if (material.quantity <= 0) {
      alerts.push({
        type: "out_of_stock",
        severity: "critical",
        message: `${material.name} is out of stock`,
        material_id: material.id,
      });
    } else if (material.quantity <= material.minimum_stock) {
      alerts.push({
        type: "low_stock",
        severity: "warning",
        message:
          `${material.name} is low on stock ` +
          `(${formatQty(material.quantity, material.unit)} remaining)`,
        material_id: material.id,
      });
    }
  }

  return alerts;
}

/* --------------------------------------------------
   PROOFS (attachments)
-------------------------------------------------- */

function checkTransaction(s: State, type: string, transactionId: number) {
  if (type !== "borrowing" && type !== "issue") {
    fail("Invalid transaction type");
  }

  if (type === "borrowing") {
    if (!s.borrowings.some((b) => b.id === transactionId)) {
      fail("Borrowing record not found");
    }
  } else if (!s.issues.some((i) => i.id === transactionId)) {
    fail("Consumption record not found");
  }

  return type;
}

function uploadAttachment(
  s: State,
  ctx: Context,
  type: string,
  transactionId: number,
  body: RequestBody
): AttachmentRow {
  const kind = checkTransaction(s, type, transactionId);
  const file = body instanceof FormData ? body.get("file") : null;

  if (!(file instanceof File)) fail("No file was uploaded");

  const originalName = file.name || "attachment";
  const dot = originalName.lastIndexOf(".");
  const extension = dot >= 0 ? originalName.slice(dot).toLowerCase() : "";

  const contentType = file.type || EXTENSION_TYPES[extension] || "";

  if (!ALLOWED_TYPES.has(contentType)) fail("Unsupported attachment type");

  const id = s.nextId.attachments++;
  const storedName = `${kind}_${transactionId}_${randomHex(16)}${extension}`;

  const attachment: AttachmentRow = {
    id,
    transaction_type: kind,
    transaction_id: transactionId,
    original_filename: originalName,
    stored_filename: storedName,
    content_type: contentType,
    file_path: `uploads/${storedName}`,
    uploaded_at: nowIso(),
  };

  s.attachments.push(attachment);

  ctx.pre.push(() =>
    idbPut("blobs", id, new Blob([file], { type: contentType }))
  );

  return attachment;
}

function listAttachments(
  s: State,
  type: string,
  transactionId: number
): AttachmentRow[] {
  if (type !== "borrowing" && type !== "issue") {
    fail("Invalid transaction type");
  }

  return s.attachments
    .filter(
      (a) =>
        a.transaction_type === type && a.transaction_id === transactionId
    )
    .sort(
      (a, b) => b.uploaded_at.localeCompare(a.uploaded_at) || b.id - a.id
    );
}

function deleteAttachment(s: State, ctx: Context, id: number): undefined {
  const attachment = s.attachments.find((a) => a.id === id);

  if (!attachment) fail("Attachment not found");

  s.attachments = s.attachments.filter((a) => a.id !== id);
  ctx.post.push(() => idbDelete("blobs", id));

  return undefined;
}

/* --------------------------------------------------
   SETTINGS
-------------------------------------------------- */

function readSettings(s: State): Record<string, string> {
  return { ...SETTING_DEFAULTS, ...s.settings };
}

function tidy(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function updateSettings(s: State, b: Body): Record<string, string> {
  const next: Record<string, string> = {};

  if (typeof b.system_name === "string") {
    const name = tidy(b.system_name);

    if (!name) fail("System name is required");
    if (name.length > MAX_NAME_LENGTH) {
      fail(`System name must be at most ${MAX_NAME_LENGTH} characters`);
    }

    next.system_name = name;
  }

  if (typeof b.admin_name === "string") {
    const admin = tidy(b.admin_name);

    if (admin.length > MAX_NAME_LENGTH) {
      fail(`Admin name must be at most ${MAX_NAME_LENGTH} characters`);
    }

    next.admin_name = admin;
  }

  if (typeof b.accent_color === "string") {
    const color = b.accent_color.trim().toLowerCase();

    if (!/^#[0-9a-f]{6}$/.test(color)) {
      fail("Accent color must look like #1f47c8");
    }

    next.accent_color = color;
  }

  s.settings = { ...s.settings, ...next };

  return readSettings(s);
}

/* --------------------------------------------------
   TABLES
-------------------------------------------------- */

function createTable(s: State, b: Body): TableRow {
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const kind = typeof b.kind === "string" ? b.kind : "consumable";

  if (!name) fail("Table name is required");
  if (!VALID_KINDS.has(kind)) {
    fail("Table kind must be consumable or reusable");
  }

  const table: TableRow = {
    id: s.nextId.tables++,
    name,
    kind: kind as Kind,
    columns: null,
    created_at: nowIso(),
  };

  s.tables.push(table);

  return table;
}

function updateTable(s: State, id: number, b: Body): TableRow {
  const table = s.tables.find((t) => t.id === id);

  if (!table) fail("Table not found");

  if (typeof b.name === "string") {
    const name = b.name.trim();

    if (!name) fail("Table name is required");

    table.name = name;
  }

  const items = s.materials.filter((m) => m.table_id === id);

  // Change the table kind (consumable <-> reusable)
  if (typeof b.kind === "string" && b.kind !== table.kind) {
    if (!VALID_KINDS.has(b.kind)) {
      fail("Table kind must be consumable or reusable");
    }

    if (items.some((item) => materialHasHistory(s, item.id))) {
      fail(
        "Cannot change the kind because some items already have borrowing or consumption records"
      );
    }

    table.kind = b.kind as Kind;

    for (const item of items) {
      item.material_type = table.kind;
      item.borrowable = table.kind === "reusable";
    }
  }

  if (Array.isArray(b.columns)) {
    // Keep only well-formed columns with a string key
    const columns = b.columns.filter(
      (c): c is Record<string, unknown> =>
        isObject(c) && typeof c.key === "string"
    );

    table.columns = columns;

    // Remove values of deleted custom columns from every item
    const validKeys = new Set(columns.map((c) => String(c.key)));

    for (const item of items) {
      if (!item.custom_data) continue;

      item.custom_data = Object.fromEntries(
        Object.entries(item.custom_data).filter(
          ([key]) => !key.startsWith("custom:") || validKeys.has(key)
        )
      );
    }
  }

  return table;
}

function deleteTable(
  s: State,
  ctx: Context,
  id: number,
  force: boolean
): undefined {
  const table = s.tables.find((t) => t.id === id);

  if (!table) fail("Table not found");

  const items = s.materials.filter((m) => m.table_id === id);

  if (!force && items.some((item) => materialHasHistory(s, item.id))) {
    fail(
      "Cannot delete this table because some of its items have borrowing or consumption records"
    );
  }

  if (force) {
    // Also remove the history (and proof files) of every item
    const itemIds = new Set(items.map((item) => item.id));

    const borrowingIds = new Set(
      s.borrowings.filter((b) => itemIds.has(b.material_id)).map((b) => b.id)
    );
    const issueIds = new Set(
      s.issues.filter((i) => itemIds.has(i.material_id)).map((i) => i.id)
    );

    const doomed = s.attachments.filter(
      (a) =>
        (a.transaction_type === "borrowing" &&
          borrowingIds.has(a.transaction_id)) ||
        (a.transaction_type === "issue" && issueIds.has(a.transaction_id))
    );

    for (const attachment of doomed) {
      ctx.post.push(() => idbDelete("blobs", attachment.id));
    }

    const doomedIds = new Set(doomed.map((a) => a.id));

    s.attachments = s.attachments.filter((a) => !doomedIds.has(a.id));
    s.borrowings = s.borrowings.filter((b) => !borrowingIds.has(b.id));
    s.issues = s.issues.filter((i) => !issueIds.has(i.id));
  }

  s.materials = s.materials.filter((m) => m.table_id !== id);
  s.tables = s.tables.filter((t) => t.id !== id);

  return undefined;
}

/* --------------------------------------------------
   EXPORT / IMPORT  (same zip format as the server)
-------------------------------------------------- */

export async function localExport(): Promise<Blob> {
  const s = await getState();

  const payload = {
    app: EXPORT_APP,
    version: EXPORT_VERSION,
    exported_at: nowIso(),
    data: {
      inventory_tables: s.tables,
      materials: s.materials,
      borrowings: s.borrowings,
      material_issues: s.issues,
      transaction_attachments: s.attachments,
      app_settings: Object.entries(s.settings).map(([key, value]) => ({
        key,
        value,
      })),
    },
  };

  const zip = new JSZip();

  zip.file(DATA_FILE, JSON.stringify(payload, null, 2));

  for (const attachment of s.attachments) {
    const blob = await idbGet<Blob>("blobs", attachment.id);

    if (blob) zip.file(`uploads/${attachment.stored_filename}`, blob);
  }

  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

function reqNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("bad number");
  }

  return value;
}

function reqString(value: unknown): string {
  if (typeof value !== "string") throw new Error("bad text");

  return value;
}

function optString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function reqDate(value: unknown): string {
  return toNaiveUtc(value);
}

function optDate(value: unknown): string | null {
  return value == null ? null : toNaiveUtc(value);
}

function baseName(value: string): string {
  return value.split(/[\\/]/).pop() ?? "";
}

async function importBackup(
  file: File
): Promise<{ imported: Record<string, number> }> {
  const invalid = () =>
    new Error("This is not a valid warehouse backup file");

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let payload: unknown;
  let zip: JSZip | null = null;

  try {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      zip = await JSZip.loadAsync(buffer);

      const entry = zip.file(DATA_FILE);

      if (!entry) throw invalid();

      payload = JSON.parse(await entry.async("string"));
    } else {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    }
  } catch {
    throw invalid();
  }

  if (
    !isObject(payload) ||
    payload.app !== EXPORT_APP ||
    !isObject(payload.data)
  ) {
    throw invalid();
  }

  if (typeof payload.version === "number" && payload.version > EXPORT_VERSION) {
    throw new Error("This backup was made by a newer version of the app");
  }

  const data = payload.data;

  const list = (key: string): Body[] => {
    const value = data[key] ?? [];

    if (!Array.isArray(value) || !value.every(isObject)) throw invalid();

    return value;
  };

  const next = emptyState();

  try {
    next.tables = list("inventory_tables").map((r) => ({
      id: reqNumber(r.id),
      name: reqString(r.name),
      kind: r.kind === "reusable" ? "reusable" : "consumable",
      columns: Array.isArray(r.columns)
        ? r.columns.filter(isObject)
        : null,
      created_at: r.created_at == null ? nowIso() : reqDate(r.created_at),
    }));

    next.materials = list("materials").map((r) => ({
      id: reqNumber(r.id),
      name: reqString(r.name),
      category: reqString(r.category),
      quantity: reqNumber(r.quantity ?? 0),
      unit: reqString(r.unit),
      minimum_stock: reqNumber(r.minimum_stock ?? 0),
      borrowable: r.borrowable === undefined ? true : Boolean(r.borrowable),
      location: optString(r.location),
      created_at: r.created_at == null ? nowIso() : reqDate(r.created_at),
      material_type: r.material_type === "consumable" ? "consumable" : "reusable",
      custom_data: isObject(r.custom_data) ? customDataOf(r.custom_data) : null,
      table_id: r.table_id == null ? null : reqNumber(r.table_id),
    }));

    next.borrowings = list("borrowings").map((r) => ({
      id: reqNumber(r.id),
      material_id: reqNumber(r.material_id),
      borrower_name: reqString(r.borrower_name),
      quantity: reqNumber(r.quantity),
      returned_quantity: reqNumber(r.returned_quantity ?? 0),
      borrowed_at: r.borrowed_at == null ? nowIso() : reqDate(r.borrowed_at),
      due_date: reqDate(r.due_date),
      returned_at: optDate(r.returned_at),
      status: typeof r.status === "string" ? r.status : "active",
      remark: optString(r.remark),
    }));

    next.issues = list("material_issues").map((r) => ({
      id: reqNumber(r.id),
      material_id: reqNumber(r.material_id),
      issued_to: reqString(r.issued_to),
      quantity: reqNumber(r.quantity),
      project: optString(r.project),
      purpose: optString(r.purpose),
      issued_at: r.issued_at == null ? nowIso() : reqDate(r.issued_at),
    }));

    next.attachments = list("transaction_attachments").map((r) => {
      const stored = baseName(reqString(r.stored_filename));

      return {
        id: reqNumber(r.id),
        transaction_type: r.transaction_type === "issue" ? "issue" : "borrowing",
        transaction_id: reqNumber(r.transaction_id),
        original_filename: reqString(r.original_filename),
        stored_filename: stored,
        content_type: reqString(r.content_type),
        file_path: `uploads/${stored}`,
        uploaded_at: r.uploaded_at == null ? nowIso() : reqDate(r.uploaded_at),
      };
    });

    for (const row of list("app_settings")) {
      const key = reqString(row.key);

      if (key in SETTING_DEFAULTS) next.settings[key] = reqString(row.value);
    }
  } catch {
    throw invalid();
  }

  const nextId = (rows: { id: number }[]) =>
    rows.reduce((max, r) => Math.max(max, r.id), 0) + 1;

  next.nextId = {
    tables: nextId(next.tables),
    materials: nextId(next.materials),
    borrowings: nextId(next.borrowings),
    issues: nextId(next.issues),
    attachments: nextId(next.attachments),
  };

  // Proof files first, then the data itself
  await idbClear("blobs");

  if (zip) {
    for (const attachment of next.attachments) {
      const entry = zip.file(`uploads/${attachment.stored_filename}`);

      if (!entry) continue;

      const content = await entry.async("blob");

      await idbPut(
        "blobs",
        attachment.id,
        new Blob([content], { type: attachment.content_type })
      );
    }
  }

  state = next;
  loading = Promise.resolve(next);
  await persist();

  return {
    imported: {
      inventory_tables: next.tables.length,
      materials: next.materials.length,
      borrowings: next.borrowings.length,
      material_issues: next.issues.length,
      transaction_attachments: next.attachments.length,
      app_settings: Object.keys(next.settings).length,
    },
  };
}