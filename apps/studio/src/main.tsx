import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContextMenuProvider } from "@briarflow/editor-react";
import { App } from "./App";
// Self-hosted fonts (OPEN_QUESTIONS Q-DS-2): weights used by the design-system tokens.
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/800.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@briarflow/editor-react/theme.css";
import "./styles/base.css";
import "./styles/layout.css";

const root = document.getElementById("root");
if (!root) throw new Error('Briarflow Studio: missing <div id="root"> in index.html.');
createRoot(root).render(
  <StrictMode>
    <ContextMenuProvider>
      <App />
    </ContextMenuProvider>
  </StrictMode>,
);
