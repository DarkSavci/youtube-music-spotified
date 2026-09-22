// The tray flyout: a second page of the bundle, loaded by the desktop shell
// into its own small window. It shares the app's tokens, type and controls,
// and none of its playback — it draws a snapshot and sends actions back.
import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/global.css";
import "../styles/shell.css";
import "./flyout.css";
import { Flyout } from "./Flyout";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Flyout />
  </StrictMode>,
);
