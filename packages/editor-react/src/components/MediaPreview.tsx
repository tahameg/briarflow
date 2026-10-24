/**
 * The preview window on nodes with image / video outputs (the last run's result) and the large
 * viewer it opens on double-click.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import type { MediaRef } from "@briarflow/core";
import { useMedia } from "../context.js";
import type { MediaPreview } from "../graph.js";
import { mediaHref } from "../values.js";
import { Modal } from "./ui.js";

function MediaElement({ kind, href, alt, large }: { kind: "image" | "video"; href: string; alt: string; large?: boolean }) {
  if (kind === "video") {
    return large ? <video src={href} controls autoPlay loop className="bf-viewer__media" /> : <video src={href} muted loop autoPlay playsInline preload="metadata" className="bf-node__media-el" />;
  }
  return <img src={href} alt={alt} className={large ? "bf-viewer__media" : "bf-node__media-el"} draggable={false} />;
}

const kindOf = (ref: MediaRef, fallback: "image" | "video") => (ref.mime.startsWith("video/") ? "video" : ref.mime.startsWith("image/") ? "image" : fallback);

/** Preview windows of a node's image / video outputs. Double-click one to open the viewer. */
export function MediaWindow({ media, nodeTitle, running }: { media: readonly MediaPreview[]; nodeTitle: string; running: boolean }) {
  const { mediaUrl } = useMedia();
  const [open, setOpen] = useState<{ port: string; index: number } | undefined>(undefined);
  const viewing = open ? media.find((m) => m.port === open.port) : undefined;
  return (
    <div className={media.length > 1 ? "bf-node__media-group bf-node__media-group--many" : "bf-node__media-group"}>
      {media.map((m) => {
        const first = m.refs[0];
        const href = first ? mediaHref(first, mediaUrl) : undefined;
        return (
          <figure
            key={m.port}
            className={href ? "bf-node__media" : "bf-node__media bf-node__media--empty"}
            title={href ? "Double-click to open" : undefined}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (first) setOpen({ port: m.port, index: 0 });
            }}
          >
            {first && href ? (
              <MediaElement kind={kindOf(first, m.kind)} href={href} alt={`${nodeTitle} ${m.title}`} />
            ) : (
              <span className="bf-node__media-hint">{running ? `Making the ${m.kind}…` : first ? "No media URL" : `Run the flow to see the ${m.kind}`}</span>
            )}
            {media.length > 1 || m.refs.length > 1 ? (
              <figcaption className="bf-node__media-cap">
                {media.length > 1 ? m.title : null}
                {m.refs.length > 1 ? ` · ${m.refs.length}` : null}
              </figcaption>
            ) : null}
          </figure>
        );
      })}
      {viewing && open
        ? createPortal(<MediaViewer preview={viewing} nodeTitle={nodeTitle} index={open.index} onIndex={(index) => setOpen({ ...open, index })} onClose={() => setOpen(undefined)} />, document.body)
        : null}
    </div>
  );
}

function describe(ref: MediaRef): string {
  const parts = [ref.mime];
  const { width, height, durationSec, filename } = ref.meta ?? {};
  if (typeof width === "number" && typeof height === "number") parts.push(`${width}×${height}`);
  if (typeof durationSec === "number") parts.push(`${durationSec.toFixed(1)} s`);
  if (typeof ref.bytes === "number") parts.push(ref.bytes >= 1024 * 1024 ? `${(ref.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(ref.bytes / 1024))} KB`);
  if (typeof filename === "string") parts.push(filename);
  return parts.join(" · ");
}

/** The large viewer: one item with its details, thumbnails to switch between several. */
export function MediaViewer({ preview, nodeTitle, index, onIndex, onClose }: { preview: MediaPreview; nodeTitle: string; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const { mediaUrl } = useMedia();
  const ref = preview.refs[Math.min(index, preview.refs.length - 1)];
  const href = ref ? mediaHref(ref, mediaUrl) : undefined;
  return (
    <Modal
      open
      title={`${nodeTitle} · ${preview.title}`}
      onClose={onClose}
      className="bf-viewer"
      actions={
        href ? (
          <a className="bf-button bf-button--ghost bf-button--sm" href={href} target="_blank" rel="noreferrer">
            Open in new tab
          </a>
        ) : null
      }
    >
      <div className="bf-viewer__stage">{ref && href ? <MediaElement kind={kindOf(ref, preview.kind)} href={href} alt={`${nodeTitle} ${preview.title}`} large /> : <span className="bf-muted">No media URL.</span>}</div>
      {ref ? <p className="bf-viewer__info bf-code">{describe(ref)}</p> : null}
      {preview.refs.length > 1 ? (
        <div className="bf-viewer__strip" role="listbox" aria-label="Items">
          {preview.refs.map((r, i) => {
            const h = mediaHref(r, mediaUrl);
            return (
              <button key={i} type="button" role="option" aria-selected={i === index} className={i === index ? "bf-viewer__thumb bf-viewer__thumb--on" : "bf-viewer__thumb"} onClick={() => onIndex(i)}>
                {h ? <MediaElement kind={kindOf(r, preview.kind)} href={h} alt={`Item ${i + 1}`} /> : i + 1}
              </button>
            );
          })}
        </div>
      ) : null}
    </Modal>
  );
}
