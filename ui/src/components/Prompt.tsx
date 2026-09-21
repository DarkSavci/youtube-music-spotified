import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * Asking for one line of text, or for confirmation.
 *
 * `window.prompt` and `window.confirm` block the renderer and, in a frameless
 * Electron window, take the whole interface with them until dismissed — the
 * extension cannot receive anything while one is open. So they are rebuilt,
 * and asking becomes a promise rather than a blocking call.
 */

interface AskText {
  kind: "text";
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
}

interface AskConfirm {
  kind: "confirm";
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
}

type Ask = (AskText | AskConfirm) & { resolve: (value: string | null) => void };

interface PromptApi {
  /** Resolves with the text, or null if dismissed. */
  text(opts: { title: string; label: string; initial?: string; confirmLabel?: string }): Promise<string | null>;
  /** Resolves true when confirmed. */
  confirm(opts: { title: string; body: string; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
}

const Ctx = createContext<PromptApi>({
  text: async () => null,
  confirm: async () => false,
});

export function usePrompt(): PromptApi {
  return useContext(Ctx);
}

export function PromptProvider({ children }: { children: React.ReactNode }) {
  const [ask, setAsk] = useState<Ask | null>(null);

  const api: PromptApi = {
    text: useCallback(
      (o) =>
        new Promise<string | null>((resolve) =>
          setAsk({
            kind: "text",
            title: o.title,
            label: o.label,
            initial: o.initial ?? "",
            confirmLabel: o.confirmLabel ?? "Create",
            resolve,
          }),
        ),
      [],
    ),
    confirm: useCallback(
      (o) =>
        new Promise<string | null>((resolve) =>
          setAsk({
            kind: "confirm",
            title: o.title,
            body: o.body,
            confirmLabel: o.confirmLabel ?? "Confirm",
            danger: o.danger ?? false,
            resolve,
          }),
        ).then((v) => v !== null),
      [],
    ),
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      {ask ? (
        <Dialog
          ask={ask}
          onDone={(value) => {
            ask.resolve(value);
            setAsk(null);
          }}
        />
      ) : null}
    </Ctx.Provider>
  );
}

function Dialog({ ask, onDone }: { ask: Ask; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(ask.kind === "text" ? ask.initial : "");
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus lands on the thing being asked about, so the keyboard alone is
    // enough to answer.
    (inputRef.current ?? confirmRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDone(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDone]);

  const submit = () => {
    if (ask.kind === "text") {
      const trimmed = value.trim();
      onDone(trimmed === "" ? null : trimmed);
    } else {
      onDone("confirmed");
    }
  };

  return (
    <div className="promptback" onMouseDown={() => onDone(null)}>
      <div
        className="prompt"
        role="dialog"
        aria-modal="true"
        aria-label={ask.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="prompt__title">{ask.title}</h2>

        {ask.kind === "text" ? (
          <label className="prompt__field">
            <span>{ask.label}</span>
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </label>
        ) : (
          <p className="prompt__body">{ask.body}</p>
        )}

        <div className="prompt__actions">
          <button className="chip" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            className="chip chip--primary"
            data-danger={(ask.kind === "confirm" && ask.danger) || undefined}
            disabled={ask.kind === "text" && value.trim() === ""}
            onClick={submit}
          >
            {ask.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
