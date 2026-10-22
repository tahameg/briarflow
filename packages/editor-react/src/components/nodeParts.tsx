/**
 * Woodshop node parts: port LEDs, the brass category medal, the pilot lamp and the VU
 * progress strip. Styles: `styles/editor.css` ("Woodshop nodes").
 */
import type { ReactNode } from "react";
import type { LedFamily } from "../theme.js";
import type { DotState } from "./ui.js";

/** How lit a port LED is: off, dim (typed-in value), on (wired), pulse (data flowing). */
export type LedState = "off" | "dim" | "on" | "pulse";

/** A port LED in its type family's color; `bar` for lists. */
export function Led({ family, state, bar = false }: { family: LedFamily; state: LedState; bar?: boolean }) {
  return <span className={`bf-led bf-led--${family} bf-led--${state}${bar ? " bf-led--bar" : ""}`} aria-hidden="true" />;
}

/** LED of an input row: wired → on (pulsing while the node runs), typed value → dim. */
export function inputLed(port: { links: number; hasValue: boolean }, running: boolean): LedState {
  if (port.links > 0) return running ? "pulse" : "on";
  return port.hasValue ? "dim" : "off";
}

/** LED of an output row: on while something is plugged in. */
export function outputLed(port: { links: number }): LedState {
  return port.links > 0 ? "on" : "off";
}

/** Header lamp of a run state. */
export function PilotLamp({ state }: { state: DotState | undefined }) {
  const tone = state === "running" ? "run" : state === "queued" ? "wait" : state === "done" || state === "cached" ? "ok" : state === "error" ? "err" : "off";
  return <span className={`bf-pilot bf-pilot--${tone}`} role="img" aria-label={`run status: ${state ?? "idle"}`} title={state ?? "idle"} />;
}

const VU_SEGMENTS = 12;

/** Segmented progress strip: green, then amber and red at the top end. */
export function VuMeter({ progress }: { progress: number }) {
  const lit = Math.round(Math.min(1, Math.max(0, progress)) * VU_SEGMENTS);
  const cells: ReactNode[] = [];
  for (let i = 0; i < VU_SEGMENTS; i++) {
    const tone = i < lit ? (i >= VU_SEGMENTS - 1 ? "r" : i >= VU_SEGMENTS - 3 ? "a" : "g") : "";
    cells.push(<i key={i} className={tone ? `bf-vu__seg bf-vu__seg--${tone}` : "bf-vu__seg"} />);
  }
  return (
    <div className="bf-vu" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      {cells}
    </div>
  );
}

const ICONS: Record<string, ReactNode> = {
  text: <path d="M3 4h10M3 8h10M3 12h6" />,
  ai: <path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12" />,
  image: (
    <>
      <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
      <path d="M3 11l3.5-3.5 3 3 2-2 2 2" />
    </>
  ),
  list: <path d="M6 4h7M6 8h7M6 12h7M3 4h0M3 8h0M3 12h0" />,
  data: <path d="M5.5 2.5c-1.5 0-2 .8-2 2v1.5c0 1-.5 2-1.5 2 1 0 1.5 1 1.5 2v1.5c0 1.2.5 2 2 2M10.5 2.5c1.5 0 2 .8 2 2v1.5c0 1 .5 2 1.5 2-1 0-1.5 1-1.5 2v1.5c0 1.2-.5 2-2 2" />,
  convert: <path d="M3 5.5h9.5L10 3M13 10.5H3.5L6 13" />,
  variable: <path d="M3 3.5h10v9H3zM6.5 3.5v9" />,
  input: <path d="M2 8h8M7 5l3 3-3 3M13.5 3v10" />,
  output: <path d="M2.5 3v10M6 8h8M11 5l3 3-3 3" />,
  node: <circle cx="8" cy="8" r="3.5" />,
};

/** Icon key for a node: built-in direction, variable, or the category's first word. */
export function medalIcon(kind: { builtin: "input" | "output" | undefined; variable: boolean; category: string | undefined }): string {
  if (kind.builtin) return kind.builtin;
  if (kind.variable) return "variable";
  const key = (kind.category ?? "").toLowerCase().split(/[\s(]/)[0] ?? "";
  if (key === "variables" || key === "globals") return "variable";
  return key in ICONS ? key : "node";
}

/** Brass disc with a category icon. */
export function NodeMedal({ icon }: { icon: string }) {
  return (
    <span className="bf-medal" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {ICONS[icon] ?? ICONS.node}
      </svg>
    </span>
  );
}
