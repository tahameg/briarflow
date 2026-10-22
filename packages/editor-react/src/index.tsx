/**
 * @briarflow/editor-react — React 19 views over `@briarflow/editor` (docs/ARCHITECTURE.md §7.3):
 * a React Flow canvas, node palette, types / variables / run panels, inspector and diagnostics,
 * styled with the Briar Brutal design system. All editing goes through store commands.
 * Right-click menus are extensible: wrap the app in `<ContextMenuProvider>` and add entries
 * per target with `contributors` or `useContextMenuContributor`.
 *
 * Import the styles once: `import "@briarflow/editor-react/theme.css";`
 *
 * @example
 * ```tsx
 * import { createBriarClient } from "@briarflow/client";
 * import { clientBackend, createEditorStore } from "@briarflow/editor";
 * import { EditorProvider, FlowCanvas, Inspector, NodePalette } from "@briarflow/editor-react";
 * import "@briarflow/editor-react/theme.css";
 *
 * const client = createBriarClient({ baseUrl: "/api/v1" });
 * const store = createEditorStore({ backend: clientBackend(client), contextId: "ctx_1" });
 * <EditorProvider store={store} mediaUrl={(id) => client.media.url(id)}>
 *   <NodePalette /> <FlowCanvas /> <Inspector />
 * </EditorProvider>;
 * ```
 */
export const PACKAGE_NAME = "@briarflow/editor-react";

export {
  EditorProvider,
  useDispatch,
  useEditorState,
  useEditorStore,
  useFlow,
  useFlowId,
  useFlowView,
  useLocalToasts,
  useMedia,
} from "./context.js";
export type { CanvasHandle, DispatchFn, EditorProviderProps, LocalToast } from "./context.js";

export { FlowCanvas } from "./components/FlowCanvas.js";
export type { FlowCanvasProps } from "./components/FlowCanvas.js";
export { NodePalette } from "./components/NodePalette.js";
export type { NodePaletteProps } from "./components/NodePalette.js";
export { TypesPanel } from "./components/TypesPanel.js";
export type { TypesPanelProps } from "./components/TypesPanel.js";
export { GlobalsPanel, SignatureEditor, VariablesPanel } from "./components/VariablesPanel.js";
export type { SignatureEditorProps, VariablesPanelProps } from "./components/VariablesPanel.js";
export { Inspector } from "./components/Inspector.js";
export type { InspectorProps } from "./components/Inspector.js";
export { RunPanel, rejectionDiagnostics, runBlockedHint, useFlowErrorCount } from "./components/RunPanel.js";
export type { RunPanelProps } from "./components/RunPanel.js";
export { DiagnosticsList, filterDiagnostics } from "./components/DiagnosticsList.js";
export type { DiagnosticsListProps } from "./components/DiagnosticsList.js";
export { EditorToasts, SyncStatus } from "./components/Toasts.js";
export { ValueEditor } from "./components/ValueEditor.js";
export type { ValueEditorProps } from "./components/ValueEditor.js";
export { TypeInput } from "./components/TypeInput.js";
export type { TypeInputProps } from "./components/TypeInput.js";
export { TypePicker } from "./components/TypePicker.js";
export type { TypePickerProps } from "./components/TypePicker.js";
export { FieldRow } from "./components/FieldRow.js";
export type { FieldRowProps } from "./components/FieldRow.js";
export { deleteSelection, deleteSelectionCommands, isTypingTarget } from "./components/selection.js";
export { duplicateCommands } from "./duplicate.js";
export { ContextMenuProvider, useContextMenu, useContextMenuContributor, useHasContextMenu } from "./components/ContextMenu.js";
export type { ContextMenuAnchor, ContextMenuApi, ContextMenuProviderProps } from "./components/ContextMenu.js";
export { collectItems, mergeItems, searchItems } from "./menu.js";
export type { ContextMenuContributor, ContextMenuItem, ContextMenuTarget, ContextMenuTargets, ContextMenuTransform, MenuSearchHit } from "./menu.js";
export {
  AddRow,
  Badge,
  Button,
  CheckboxField,
  ConfirmDialog,
  EditableName,
  EmptyState,
  InlineText,
  Modal,
  Panel,
  PortMarker,
  SectionHead,
  SelectField,
  StatusDot,
  Tabs,
  TextAreaField,
  TextField,
  Toggle,
  TypeChip,
  portClasses,
  tabId,
  tabPanelId,
} from "./components/ui.js";
export type { ButtonProps, ConfirmDialogProps, DotState, ModalProps, PanelProps, TabItem, Tone } from "./components/ui.js";

export { BRIAR_TOKENS, briarTheme, nodeAccent, tokenVar, typeColor, typeStyle } from "./theme.js";
export type { BriarToken, NamedKindLookup, TypeStyle } from "./theme.js";
export { buildFlowView, canConnect, emptyCatalog, kindLookup, nodeTitle } from "./graph.js";
export type { EdgeView, FlowView, NodeView, PortView } from "./graph.js";
export { NODE_CONFIG_MIME, NODE_TYPE_MIME, initialConfig, paletteGroups, snap } from "./palette.js";
export { nextName, shapeShorthand, toggleArray, typeShape } from "./fields.js";
export type { TypeShape } from "./fields.js";
export type { PaletteGroup } from "./palette.js";
export { formatBytes, formatDuration, initialValue, isMediaRef, mediaHref, previewValue, widgetKind } from "./values.js";
export type { WidgetKind } from "./values.js";
