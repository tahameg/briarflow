/**
 * Frontend debug nodes: no-ops on the server; the studio acts when the node completes in a run.
 * `debug.print` prints text to the console, `debug.image` shows an image on the node and in the
 * console.
 */
import { defineNode, t } from "@briarflow/core";

/**
 * `debug.print`: prints its text to the studio's console (and, with `browserConsole`, to the
 * browser devtools console). Runs in the viewer; on the server it does nothing.
 */
export const debugPrint = defineNode({
  type: "debug.print",
  title: "Print",
  category: "Debug",
  icon: "terminal",
  description: "Prints the text to the studio console. Turn on Browser console to also see it in the browser's devtools. Runs in the studio, not on the server.",
  frontend: true,
  inputs: {
    text: { type: t.text({ multiline: true }), widget: "textarea" },
    browserConsole: { type: t.boolean(), default: false, title: "Browser console", description: "Also write the text to the browser's devtools console." },
  },
  run: () => ({}),
});

/**
 * `debug.image` (View image): shows the image large on the node and as a thumbnail in the
 * studio console. On the execution line, so the image nodes before it run.
 */
export const debugImage = defineNode({
  type: "debug.image",
  title: "View image",
  category: "Debug",
  icon: "image",
  description: "Shows the image on the node (double-click it for the large viewer) and in the studio console, with its size. Runs in the studio, not on the server.",
  frontend: true,
  inputs: {
    image: { type: t.image(), description: "The image to look at." },
    label: { type: t.optional(t.text()), default: null, description: "Written next to the image in the console." },
  },
  run: () => ({}),
});
