import { useEffect } from "react";
import { useToast } from "../lib/toast";

/** How long a confirmation stays, which is long enough to read and no more. */
const VISIBLE_MS = 2600;

export function Toast() {
  const { message, seq, hide } = useToast();

  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(hide, VISIBLE_MS);
    return () => window.clearTimeout(t);
  }, [message, seq, hide]);

  if (!message) return null;
  return (
    // polite: announced without interrupting whatever is being read.
    <div className="toast" role="status" aria-live="polite" key={seq}>
      {message}
    </div>
  );
}
