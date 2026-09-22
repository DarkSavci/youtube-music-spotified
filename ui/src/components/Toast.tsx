import { useEffect } from "react";
import { useToast } from "../lib/toast";

/** How long a confirmation stays, which is long enough to read and no more. */
const VISIBLE_MS = 2600;
/** A toast with a button stays long enough to reach for it. */
const WITH_ACTION_MS = 9000;

export function Toast() {
  const { message, action, seq, hide } = useToast();

  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(hide, action ? WITH_ACTION_MS : VISIBLE_MS);
    return () => window.clearTimeout(t);
  }, [message, action, seq, hide]);

  if (!message) return null;
  return (
    // polite: announced without interrupting whatever is being read.
    <div className="toast" role="status" aria-live="polite" key={seq}>
      {message}
      {action ? (
        <button
          className="toast__action"
          onClick={() => {
            action.run();
            hide();
          }}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
