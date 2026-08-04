"use client";

/**
 * The cart-details panel: a modal for a cart's marketplace presentation — its
 * title, description and tags — the fields that decide how it reads in Browse.
 *
 * It edits the workbench's `details` state directly (title and description flow
 * through on each keystroke, capped to their stored limits); tags are typed as a
 * free comma-separated string and normalised to the clean, bounded list the
 * server stores, with the normalised result shown back as chips so the author
 * sees exactly what will be saved. The panel only edits state — Save/Publish in
 * the toolbar is what persists it, so the copy says as much.
 */

import { useEffect, useRef, useState } from "react";

import {
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeTags,
  type CartMeta,
} from "@/lib/cartMeta";
import styles from "./editor.module.css";

interface DetailsPanelProps {
  details: CartMeta;
  onChange: (details: CartMeta) => void;
  onClose: () => void;
}

export function DetailsPanel({ details, onChange, onClose }: DetailsPanelProps) {
  // Tags are held as raw text while editing so a trailing comma or space doesn't
  // fight the typist; the normalised list (what gets saved) is derived from it.
  const [tagText, setTagText] = useState(() => details.tags.join(", "));
  const titleRef = useRef<HTMLInputElement>(null);

  // Open focused on the title, and close on Escape — a modal a keyboard user can
  // both reach and dismiss without the mouse.
  useEffect(() => {
    titleRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const setTitle = (title: string) => onChange({ ...details, title: title.slice(0, MAX_TITLE_LENGTH) });
  const setDescription = (description: string) =>
    onChange({ ...details, description: description.slice(0, MAX_DESCRIPTION_LENGTH) });
  const setTags = (text: string) => {
    setTagText(text);
    onChange({ ...details, tags: normalizeTags(text) });
  };

  return (
    <div
      className={styles.detailsOverlay}
      role="dialog"
      aria-modal="true"
      aria-label="Cartridge details"
      onPointerDown={(event) => {
        // A click on the backdrop (not the card) dismisses.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.detailsCard}>
        <div className={styles.detailsHeader}>
          <span className={styles.detailsTitle}>Cartridge details</span>
          <button type="button" className="cbx-btn" onClick={onClose} aria-label="Close details">
            Done
          </button>
        </div>

        <label className={styles.detailsField}>
          <span className={styles.detailsLabel}>Title</span>
          <input
            ref={titleRef}
            className={styles.detailsInput}
            type="text"
            value={details.title}
            maxLength={MAX_TITLE_LENGTH}
            placeholder="Untitled cartridge"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className={styles.detailsField}>
          <span className={styles.detailsLabel}>Description</span>
          <textarea
            className={styles.detailsTextarea}
            value={details.description}
            maxLength={MAX_DESCRIPTION_LENGTH}
            rows={4}
            placeholder="What is this cartridge? How do you play it?"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <label className={styles.detailsField}>
          <span className={styles.detailsLabel}>Tags</span>
          <input
            className={styles.detailsInput}
            type="text"
            value={tagText}
            placeholder="platformer, retro, two-player"
            onChange={(event) => setTags(event.target.value)}
          />
          <span className={styles.detailsHint}>Comma-separated. These become the facets players browse by.</span>
          {details.tags.length > 0 && (
            <div className={styles.detailsTagChips}>
              {details.tags.map((tag) => (
                <span key={tag} className={styles.detailsTagChip}>
                  {tag}
                </span>
              ))}
            </div>
          )}
        </label>

        <p className={styles.detailsFooter}>Details are saved when you Save or Publish.</p>
      </div>
    </div>
  );
}
