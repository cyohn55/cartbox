"use client";

/**
 * Code editor: a textarea layered over a syntax-highlighted view, with a line
 * gutter and a cursor readout. The textarea holds the editable text and the
 * caret; the highlight layer below it shows tokenised, coloured code and is
 * kept scroll-synced. Both share exact text metrics (see .codeMetrics) so the
 * caret always sits on its glyph. State flows through the shared CodeDocument.
 */

import { useMemo, useRef, useState } from "react";
import { CodeDocument, LANGUAGES, languageById, tokenize, type TokenType } from "@cartbox/editor";

import styles from "./editor.module.css";

const TOKEN_CLASS: Record<TokenType, string> = {
  keyword: styles.tokKeyword ?? "",
  api: styles.tokApi ?? "",
  string: styles.tokString ?? "",
  comment: styles.tokComment ?? "",
  number: styles.tokNumber ?? "",
  text: "",
};

const LEGEND: Array<{ type: TokenType; label: string }> = [
  { type: "keyword", label: "Keyword" },
  { type: "api", label: "TIC-80 API" },
  { type: "string", label: "String" },
  { type: "number", label: "Number" },
  { type: "comment", label: "Comment" },
];

interface CodeEditorProps {
  doc: CodeDocument;
}

export function CodeEditor({ doc }: CodeEditorProps) {
  const [text, setText] = useState(() => doc.getText());
  const [language, setLanguage] = useState(() => doc.language);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const tokens = useMemo(() => tokenize(text, languageById(language)), [text, language]);
  const lines = useMemo(() => text.split("\n"), [text]);
  const gutterText = useMemo(
    () => lines.map((_line, index) => index + 1).join("\n"),
    [lines],
  );

  const syncCursor = () => {
    const element = textareaRef.current;
    if (element) setCursor(doc.positionAt(element.selectionStart));
  };

  const commit = (next: string) => {
    setText(next);
    doc.setText(next);
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    commit(event.target.value);
    syncCursor();
  };

  const handleScroll = (event: React.UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = scrollTop;
      highlightRef.current.scrollLeft = scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = scrollTop;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const element = event.currentTarget;
    const { selectionStart, selectionEnd } = element;
    const next = text.slice(0, selectionStart) + "  " + text.slice(selectionEnd);
    commit(next);
    requestAnimationFrame(() => {
      element.selectionStart = element.selectionEnd = selectionStart + 2;
      syncCursor();
    });
  };

  const changeLanguage = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setLanguage(event.target.value);
    doc.setLanguage(event.target.value);
  };

  return (
    <div className={styles.body}>
      <aside className={styles.rail}>
        <div>
          <div className={styles.groupLabel}>Language</div>
          <select className={styles.langSelect} value={language} onChange={changeLanguage} aria-label="Language">
            {LANGUAGES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </aside>

      <section className={styles.codeStage}>
        <div className={styles.codePane}>
          <div ref={gutterRef} className={`${styles.gutter} ${styles.codeMetrics}`} aria-hidden>
            {gutterText}
          </div>
          <div className={styles.codeScroll}>
            <pre ref={highlightRef} className={`${styles.codeLayer} ${styles.highlight} ${styles.codeMetrics}`} aria-hidden>
              <code>
                {tokens.map((token, index) => (
                  <span key={index} className={TOKEN_CLASS[token.type]}>
                    {token.value}
                  </span>
                ))}
              </code>
            </pre>
            <textarea
              ref={textareaRef}
              className={`${styles.codeLayer} ${styles.codeInput} ${styles.codeMetrics}`}
              value={text}
              onChange={handleChange}
              onScroll={handleScroll}
              onKeyDown={handleKeyDown}
              onKeyUp={syncCursor}
              onClick={syncCursor}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="Cartridge code"
            />
          </div>
        </div>

        <div className={styles.hud}>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Ln, Col</span>
            <span className={`${styles.hudValue} data`}>
              {cursor.line}, {cursor.column}
            </span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Lang</span>
            <span className={styles.hudValue}>{languageById(language).label}</span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Lines</span>
            <span className={`${styles.hudValue} data`}>{lines.length}</span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Chars</span>
            <span className={`${styles.hudValue} data`}>{text.length}</span>
          </span>
        </div>
      </section>

      <aside className={styles.inspector}>
        <div>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>Syntax</span>
          </div>
          <div className={styles.legend}>
            {LEGEND.map((entry) => (
              <span key={entry.type} className={styles.legendRow}>
                <span className={`${styles.legendDot} ${TOKEN_CLASS[entry.type]}`} style={legendDotStyle(entry.type)} />
                {entry.label}
              </span>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

/** The legend dot borrows the token colour via currentColor from its class. */
function legendDotStyle(type: TokenType): React.CSSProperties {
  return type === "text" ? {} : { backgroundColor: "currentColor" };
}
