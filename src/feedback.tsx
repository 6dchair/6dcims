import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/* --------------------------------------------------
   TYPES
-------------------------------------------------- */

export type ConfirmOptions = {
  title: string;
  message?: string;
  /** Short bullet list shown under the message (e.g. item names) */
  items?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button. Defaults to true because most confirms delete. */
  danger?: boolean;
};

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

type ToastKind = "success" | "error" | "info";

type Toast = { id: number; kind: ToastKind; message: string };

export type ToastApi = {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
};

type Pending = {
  options: ConfirmOptions;
  resolve: (confirmed: boolean) => void;
};

const ConfirmContext = createContext<ConfirmFn | null>(null);
const ToastContext = createContext<ToastApi | null>(null);

/* --------------------------------------------------
   HOOKS
-------------------------------------------------- */

/** const ok = await confirm({ title: "Delete item?", confirmLabel: "Delete" }) */
export function useConfirm(): ConfirmFn {
  const context = useContext(ConfirmContext);

  if (!context) {
    throw new Error("useConfirm must be used inside <FeedbackProvider>");
  }

  return context;
}

/** toast.success("Saved") / toast.error("Could not save") */
export function useToast(): ToastApi {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error("useToast must be used inside <FeedbackProvider>");
  }

  return context;
}

/* --------------------------------------------------
   PROVIDER (renders the dialog and the toasts)
-------------------------------------------------- */

const TOAST_MS: Record<ToastKind, number> = {
  success: 3500,
  info: 3500,
  error: 6000,
};

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  /* ---------- confirm ---------- */

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setPending((previous) => {
        // A second confirm replaces the first one, which counts as "no"
        previous?.resolve(false);
        return { options, resolve };
      });
    });
  }, []);

  const settle = useCallback(
    (confirmed: boolean) => {
      setPending((current) => {
        current?.resolve(confirmed);
        return null;
      });
    },
    []
  );

  useEffect(() => {
    if (!pending) return;

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") settle(false);
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, settle]);

  /* ---------- toasts ---------- */

  const dismiss = useCallback((id: number) => {
    setToasts((previous) => previous.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;

      setToasts((previous) => [...previous, { id, kind, message }]);
      window.setTimeout(() => dismiss(id), TOAST_MS[kind]);
    },
    [dismiss]
  );

  const toast = useMemo<ToastApi>(
    () => ({
      success: (message) => push("success", message),
      error: (message) => push("error", message),
      info: (message) => push("info", message),
    }),
    [push]
  );

  /* ---------- render ---------- */

  const options = pending?.options;
  const danger = options?.danger !== false;

  return (
    <ConfirmContext.Provider value={confirm}>
      <ToastContext.Provider value={toast}>
        {children}

        {options && (
          <div className="modal-backdrop" onClick={() => settle(false)}>
            <div
              className="modal confirm-modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
              aria-describedby={
                options.message ? "confirm-message" : undefined
              }
              onClick={(e) => e.stopPropagation()}
            >
              <div className="confirm-body">
                <span
                  className={
                    danger ? "confirm-icon danger" : "confirm-icon"
                  }
                  aria-hidden="true"
                >
                  !
                </span>

                <div>
                  <h3 id="confirm-title">{options.title}</h3>

                  {options.message && (
                    <p id="confirm-message">{options.message}</p>
                  )}

                  {options.items && options.items.length > 0 && (
                    <ul className="confirm-list">
                      {options.items.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="form-actions">
                {/* Focus starts on Cancel so Enter never deletes by accident */}
                <button
                  type="button"
                  className="secondary-button"
                  autoFocus
                  onClick={() => settle(false)}
                >
                  {options.cancelLabel ?? "Cancel"}
                </button>

                <button
                  type="button"
                  className={
                    danger
                      ? "primary-button danger-button"
                      : "primary-button"
                  }
                  onClick={() => settle(true)}
                >
                  {options.confirmLabel ?? "Confirm"}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              <span className="toast-dot" aria-hidden="true" />
              <span className="toast-text">{t.message}</span>
              <button
                type="button"
                className="toast-close"
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </ToastContext.Provider>
    </ConfirmContext.Provider>
  );
}