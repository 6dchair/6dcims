import { useCallback, useEffect, useState } from "react";
import "./App.css";

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

/** Fetch JSON and throw a readable error on failure. */
async function request<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
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
};

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
   APP
-------------------------------------------------- */

function App() {
  const [page, setPage] = useState<Page>("dashboard");

  const [materials, setMaterials] = useState<Material[]>([]);
  const [alerts, setAlerts] = useState<WarehouseAlert[]>([]);
  const [borrowings, setBorrowings] = useState<Borrowing[]>([]);
  const [issues, setIssues] = useState<MaterialIssue[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [showAddMaterial, setShowAddMaterial] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [
        materialsData,
        alertsData,
        borrowingsData,
        issuesData,
      ] = await Promise.all([
        request<Material[]>("/materials"),
        request<WarehouseAlert[]>("/alerts"),
        request<Borrowing[]>("/borrowings"),
        request<MaterialIssue[]>("/issues"),
      ]);

      setMaterials(materialsData);
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
          <h1>CONSTRUCTION WAREHOUSE</h1>
          <p>Inventory Control System v1.0</p>
        </div>

        <button
          className="notification-button"
          onClick={() => setPage("alerts")}
        >
          Alerts: {alerts.length}
        </button>
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

        <main className="content">
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
            <Dashboard materials={materials} alerts={alerts} />
          )}

          {page === "inventory" && (
            <Inventory
              materials={materials}
              onRefresh={loadData}
              showAddMaterial={showAddMaterial}
              setShowAddMaterial={setShowAddMaterial}
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

      <footer className="statusbar">
        <span>Ready</span>
        <span>Items: {materials.length}</span>
        <span>Alerts: {alerts.length}</span>
      </footer>
    </div>
  );
}

/* --------------------------------------------------
   DASHBOARD
-------------------------------------------------- */

function Dashboard({
  materials,
  alerts,
}: {
  materials: Material[];
  alerts: WarehouseAlert[];
}) {
  const consumables = materials.filter(
    (m) => m.material_type === "consumable"
  );
  const borrowables = materials.filter(
    (m) => m.material_type === "reusable"
  );

  // Totals per unit (summing bags + meters + pieces is meaningless)
  const stockByUnit = materials.reduce<Record<string, number>>(
    (totals, m) => {
      totals[m.unit] = (totals[m.unit] || 0) + m.quantity;
      return totals;
    },
    {}
  );

  const lowStockCount = materials.filter(
    (m) => m.quantity > 0 && m.quantity <= m.minimum_stock
  ).length;

  const outOfStockCount = materials.filter(
    (m) => m.quantity <= 0
  ).length;

  const unitEntries = Object.entries(stockByUnit);

  return (
    <>
      <div className="page-heading">
        <div>
          <h2>Dashboard</h2>
          <p>Warehouse overview</p>
        </div>
      </div>

      <section className="section">
        <div className="section-header">
          <h2>System Summary</h2>
        </div>

        <table className="data-table summary-table">
          <tbody>
            <tr>
              <td>Material Types</td>
              <td>
                <strong>{materials.length}</strong>
              </td>
            </tr>

            <tr>
              <td>Available Stock</td>
              <td>
                <strong>
                  {unitEntries.length === 0
                    ? "0"
                    : unitEntries
                        .map(([unit, total]) => `${total} ${unit}`)
                        .join(", ")}
                </strong>
              </td>
            </tr>

            <tr>
              <td>Active Alerts</td>
              <td>
                <strong
                  className={
                    alerts.length > 0 ? "summary-warning" : ""
                  }
                >
                  {alerts.length}
                </strong>
              </td>
            </tr>

            <tr>
              <td>Low Stock Items</td>
              <td>
                <strong
                  className={
                    lowStockCount > 0 ? "summary-warning" : ""
                  }
                >
                  {lowStockCount}
                </strong>
              </td>
            </tr>

            <tr>
              <td>Out of Stock</td>
              <td>
                <strong
                  className={
                    outOfStockCount > 0 ? "summary-danger" : ""
                  }
                >
                  {outOfStockCount}
                </strong>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Consumable Materials</h2>
        </div>

        {consumables.length === 0 ? (
          <div className="empty">No consumable materials.</div>
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table inventory-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Category</th>
                  <th>Quantity</th>
                  <th>Unit</th>
                  <th>Minimum Stock</th>
                  <th>Location</th>
                  <th>Status</th>
                </tr>
              </thead>

              <tbody>
                {consumables.map((material) => (
                  <tr key={material.id}>
                    <td>
                      <strong>{material.name}</strong>
                    </td>
                    <td>{material.category}</td>
                    <td>{material.quantity}</td>
                    <td>{material.unit}</td>
                    <td>{material.minimum_stock}</td>
                    <td>{material.location || "—"}</td>
                    <td>
                      <StockBadge material={material} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-header">
          <h2>Borrowable Materials</h2>
        </div>

        {borrowables.length === 0 ? (
          <div className="empty">No borrowable materials.</div>
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table inventory-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Category</th>
                  <th>Quantity</th>
                  <th>Unit</th>
                  <th>Minimum Stock</th>
                  <th>Location</th>
                  <th>Borrowable</th>
                  <th>Status</th>
                </tr>
              </thead>

              <tbody>
                {borrowables.map((material) => (
                  <tr key={material.id}>
                    <td>
                      <strong>{material.name}</strong>
                    </td>
                    <td>{material.category}</td>
                    <td>{material.quantity}</td>
                    <td>{material.unit}</td>
                    <td>{material.minimum_stock}</td>
                    <td>{material.location || "—"}</td>
                    <td>{material.borrowable ? "Yes" : "No"}</td>
                    <td>
                      <StockBadge material={material} />
                    </td>
                  </tr>
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
   INVENTORY
-------------------------------------------------- */

function Inventory({
  materials,
  onRefresh,
  showAddMaterial,
  setShowAddMaterial,
}: {
  materials: Material[];
  onRefresh: () => void;
  showAddMaterial: boolean;
  setShowAddMaterial: (value: boolean) => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <h2>Inventory</h2>
          <p>Manage warehouse materials</p>
        </div>

        <button
          className="primary-button"
          onClick={() => setShowAddMaterial(true)}
        >
          + Add Material
        </button>
      </div>

      {showAddMaterial && (
        <AddMaterialForm
          onClose={() => setShowAddMaterial(false)}
          onCreated={() => {
            setShowAddMaterial(false);
            onRefresh();
          }}
        />
      )}

      <section className="section">
        <div className="section-header">
          <h2>Materials</h2>
        </div>

        {materials.length === 0 ? (
          <div className="empty">
            No materials yet. Use "Add Material" to create one.
          </div>
        ) : (
          <div className="data-table-wrapper">
            <table className="data-table inventory-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Material</th>
                  <th>Category</th>
                  <th>Quantity</th>
                  <th>Minimum</th>
                  <th>Type</th>
                  <th>Borrowable</th>
                  <th>Location</th>
                  <th>Status</th>
                </tr>
              </thead>

              <tbody>
                {materials.map((material) => (
                  <tr key={material.id}>
                    <td>{String(material.id).padStart(3, "0")}</td>
                    <td>
                      <strong>{material.name}</strong>
                    </td>
                    <td>{material.category}</td>
                    <td>
                      {material.quantity} {material.unit}
                    </td>
                    <td>
                      {material.minimum_stock} {material.unit}
                    </td>
                    <td>
                      {material.material_type === "consumable"
                        ? "Consumable"
                        : "Reusable"}
                    </td>
                    <td>{material.borrowable ? "Yes" : "No"}</td>
                    <td>{material.location || "Not specified"}</td>
                    <td>
                      <StockBadge material={material} />
                    </td>
                  </tr>
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
   ADD MATERIAL FORM
-------------------------------------------------- */

function AddMaterialForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("piece");
  const [minimumStock, setMinimumStock] = useState("");
  const [materialType, setMaterialType] = useState<
    "reusable" | "consumable"
  >("reusable");
  const [borrowable, setBorrowable] = useState(true);
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    setSaving(true);
    setError("");

    try {
      await request<Material>("/materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          category,
          quantity: Number(quantity),
          unit,
          minimum_stock: Number(minimumStock),
          material_type: materialType,
          borrowable:
            materialType === "consumable" ? false : borrowable,
          location: location || null,
        }),
      });

      onCreated();
    } catch (error) {
      console.error(error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not create material."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form-panel">
      <div className="form-header">
        <div>
          <h3>Add Material</h3>
          <p>Add a new item to the warehouse inventory.</p>
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
            Material name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Power Drill"
              required
            />
          </label>

          <label>
            Category
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. Equipment"
              required
            />
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

          <label>
            Location
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Shelf A-03"
            />
          </label>

          <label>
            Material type
            <select
              value={materialType}
              onChange={(e) => {
                const type = e.target.value as
                  | "reusable"
                  | "consumable";

                setMaterialType(type);
                setBorrowable(type !== "consumable");
              }}
            >
              <option value="reusable">Reusable</option>
              <option value="consumable">Consumable</option>
            </select>
          </label>

          <label className="checkbox-label">
            <input
              type="checkbox"
              style={{ width: "auto", minHeight: "auto" }}
              checked={borrowable}
              disabled={materialType === "consumable"}
              onChange={(e) => setBorrowable(e.target.checked)}
            />
            This material can be borrowed
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
            {saving ? "Adding..." : "Add Material"}
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

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

  function getIcon(contentType: string) {
    if (contentType.startsWith("image/")) return "[IMG]";
    if (contentType.startsWith("video/")) return "[VID]";
    return "[DOC]";
  }

  return (
    <div>
      <label className="secondary-button">
        {uploading ? "Uploading..." : "Attach Proofs"}

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
            <div key={attachment.id}>
              <a
                href={`${API}/attachment-files/${attachment.id}`}
                target="_blank"
                rel="noreferrer"
              >
                {getIcon(attachment.content_type)}{" "}
                {attachment.original_filename}
              </a>
            </div>
          ))}
        </div>
      )}

      {error && <div className="form-error">{error}</div>}
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
                    {material.name} — {material.quantity}{" "}
                    {material.unit} available
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
                {selectedMaterial.quantity} {selectedMaterial.unit}
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
  onReturned,
}: {
  borrowing: Borrowing;
  material?: Material;
  onReturned: () => void;
}) {
  const [showReturnForm, setShowReturnForm] = useState(false);
  const [returnQuantity, setReturnQuantity] = useState("1");
  const [returning, setReturning] = useState(false);
  const [returnError, setReturnError] = useState("");

  const unit = material?.unit || "";
  const returnedQuantity = borrowing.returned_quantity || 0;
  const remainingQuantity = borrowing.quantity - returnedQuantity;

  const dueDate = parseDate(borrowing.due_date);
  const isOverdue = dueDate.getTime() < Date.now();

  async function handleReturn() {
    const quantity = Number(returnQuantity);

    if (!isValidQuantity(quantity)) {
      setReturnError("Enter a return quantity greater than zero.");
      return;
    }

    if (quantity > remainingQuantity) {
      setReturnError(
        `Only ${remainingQuantity} ${unit || "item"} outstanding.`
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
          body: JSON.stringify({ quantity }),
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
          {borrowing.quantity} {unit}
        </td>

        <td>
          {returnedQuantity} {unit}
        </td>

        <td>
          <strong>
            {remainingQuantity} {unit}
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
          <Proofs
            transactionType="borrowing"
            transactionId={borrowing.id}
          />
        </td>

        <td className="table-actions">
          <button
            className="secondary-button"
            onClick={() => {
              setShowReturnForm(true);
              setReturnError("");
              setReturnQuantity("1");
            }}
            disabled={returning || remainingQuantity <= 0}
          >
            Return
          </button>
        </td>
      </tr>

      {showReturnForm && (
        <tr className="return-row">
          <td colSpan={9}>
            <div className="inline-return-form">
              <div>
                <strong>Return {material?.name}</strong>
                <span>
                  {" "}
                  — {remainingQuantity} {unit || "item"} outstanding
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
                </tr>
              </thead>

              <tbody>
                {issues.map((issue) => {
                  const material = materials.find(
                    (item) => item.id === issue.material_id
                  );

                  return (
                    <tr key={issue.id}>
                      <td>
                        <strong>
                          {material?.name ||
                            `Material #${issue.material_id}`}
                        </strong>
                      </td>
                      <td>{issue.issued_to}</td>
                      <td>
                        {issue.quantity} {material?.unit || ""}
                      </td>
                      <td>{issue.project || "—"}</td>
                      <td>{issue.purpose || "—"}</td>
                      <td>
                        {parseDate(
                          issue.issued_at
                        ).toLocaleDateString()}
                      </td>
                      <td>
                        <span className="status consumed">
                          Consumed
                        </span>
                      </td>
                      <td>
                        <Proofs
                          transactionType="issue"
                          transactionId={issue.id}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
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
                    {material.name} — {material.quantity}{" "}
                    {material.unit} available
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
                {selectedMaterial.quantity} {selectedMaterial.unit}
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
              <span className="alert-icon">
                [{alert.severity === "critical"
                  ? "!!!"
                  : alert.severity === "warning"
                    ? "!!"
                    : "!"}]
              </span>

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

export default App;