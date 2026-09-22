import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { desktop } from "../lib/desktop";
import { updatedSinceLastLaunch } from "../lib/changelog";
import { toast } from "../lib/toast";

/**
 * Says so, once, when the app starts on a new version.
 *
 * An update installs itself on quit, so the only sign it happened used to be
 * a number in Settings. This points at What's new instead; a fresh install
 * says nothing.
 */
export function UpdateNotice() {
  const navigate = useNavigate();
  useEffect(() => {
    let live = true;
    void desktop.version().then((v) => {
      if (!live || !v?.version || !updatedSinceLastLaunch(v.version)) return;
      toast(`Updated to ${v.version}`, { label: "See what's new", run: () => navigate("/changelog") });
    });
    return () => {
      live = false;
    };
  }, [navigate]);
  return null;
}
