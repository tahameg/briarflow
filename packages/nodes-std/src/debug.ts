/**
 * Frontend debug nodes. `debug.print` is a frontend node: a no-op on the server; the studio
 * prints its text to the console when the node completes in a run.
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
