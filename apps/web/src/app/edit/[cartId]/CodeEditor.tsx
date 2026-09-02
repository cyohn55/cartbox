"use client";

/**
 * Code editor: a textarea layered over a syntax-highlighted view, with a line
 * gutter and a cursor readout. The textarea holds the editable text and the
 * caret; the highlight layer below it shows tokenised, coloured code and is
 * kept scroll-synced. Both share exact text metrics (see .codeMetrics) so the
 * caret always sits on its glyph. State flows through the shared CodeDocument.
 *
 * Four things it could not do, in rough order of how often they were missed:
 *
 * - **Land on the line that crashed.** The playtest overlay already knew the
 *   Lua error; now clicking it opens this tab with that line selected, which
 *   closes the edit → run → fix loop the whole editor exists to serve.
 * - **Find and replace**, over a cart's whole source.
 * - **Auto-indent**, so a `function` opens a level and an `end` closes one.
 * - **Stay fast.** Every keystroke re-tokenised the entire document and
 *   re-rendered one span per token. Tokenising is memoised per line now, so
 *   typing costs one line's work rather than the file's.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeDocument, LANGUAGES, languageById, tokenize, type TokenType } from "@cartbox/editor";

import styles from "./editor.module.css";
import { SdkPanel } from "./SdkPanel";
import {
  errorLineFrom,
  findMatches,
  lineRangeAt,
  newlineIndent,
  nextMatchIndex,
  offsetOfLine,
  reindentClosing,
  replaceAll,
  replaceMatch,
} from "./codeTools";

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
  /** Changes when the cart underneath is replaced (bank switch, undo). */
  revision: number;
  /** A line to jump to and highlight, from a runtime error. */
  errorLine?: number | null;
}

export function CodeEditor({ doc, revision, errorLine }: CodeEditorProps) {
  const [text, setText] = useState(() => doc.getText());
  const [language, setLanguage] = useState(() => doc.language);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);

  const config = useMemo(() => languageById(language), [language]);
  const lines = useMemo(() => text.split("\n"), [text]);

  /**
   * Tokenise per line and cache by line text.
   *
   * A cart's source is highlighted on every keystroke. Tokenising the whole
   * document each time is O(file) per character typed, and rendering one span
   * per token re-creates thousands of DOM nodes for a one-character change.
   * Because the tokenizer is stateless within a line for everything the editor
   * colours, a plain content-keyed cache turns that into O(line): the edited
   * line is re-tokenised and every other line is reused.
   */
  const cacheRef = useRef(new Map<string, ReturnType<typeof tokenize>>());
  useEffect(() => {
    // The cache is keyed by line text, so a language switch invalidates it all.
    cacheRef.current = new Map();
  }, [language]);

  const tokenLines = useMemo(() => {
    const cache = cacheRef.current;
    const next = new Map<string, ReturnType<typeof tokenize>>();
    const rendered = lines.map((line) => {
      const hit = cache.get(line) ?? tokenize(line, config);
      next.set(line, hit);
      return hit;
    });
    // Keep only what is still on screen, so the cache cannot grow unbounded
    // across a long editing session.
    cacheRef.current = next;
    return rendered;
  }, [lines, config]);

  const matches = useMemo(
    () => (findOpen ? findMatches(text, query, { caseSensitive }) : []),
    [caseSensitive, findOpen, query, text],
  );

  const syncCursor = useCallback(() => {
    const element = textareaRef.current;
    if (element) setCursor(doc.positionAt(element.selectionStart));
  }, [doc]);

  const commit = useCallback(
    (next: string) => {
      setText(next);
      doc.setText(next);
    },
    [doc],
  );

  /** Put the caret at `start`..`end` and scroll it into view. */
  const select = useCallback(
    (start: number, end: number) => {
      const element = textareaRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(start, end);
      // Approximate the target line's offset so a jump lands mid-viewport
      // rather than at the very bottom edge.
      const line = element.value.slice(0, start).split("\n").length;
      const lineHeight = element.scrollHeight / Math.max(1, element.value.split("\n").length);
      element.scrollTop = Math.max(0, (line - 6) * lineHeight);
      syncCursor();
    },
    [syncCursor],
  );

  // The cart underneath was replaced — an undo, or a bank switch — so the text
  // held here is stale. Re-reading beats being remounted: the caret, the scroll
  // position and an open find panel all survive.
  useEffect(() => {
    const fresh = doc.getText();
    setText((current) => (current === fresh ? current : fresh));
    setLanguage(doc.language);
  }, [doc, revision]);

  // A runtime error names a line; select it so the cause is under the caret.
  useEffect(() => {
    if (!errorLine) return;
    const start = offsetOfLine(doc.getText(), errorLine);
    const range = lineRangeAt(doc.getText(), start);
    select(range.start, range.end);
  }, [doc, errorLine, select]);

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

  /** Replace the selection with `insert` and put the caret after it. */
  const insert = useCallback(
    (insertText: string, caretOffset = insertText.length) => {
      const element = textareaRef.current;
      if (!element) return;
      const { selectionStart, selectionEnd } = element;
      const next = text.slice(0, selectionStart) + insertText + text.slice(selectionEnd);
      commit(next);
      const caret = selectionStart + caretOffset;
      requestAnimationFrame(() => {
        element.focus();
        element.setSelectionRange(caret, caret);
        syncCursor();
      });
    },
    [commit, syncCursor, text],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    const mod = event.ctrlKey || event.metaKey;

    if (mod && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setFindOpen(true);
      requestAnimationFrame(() => findRef.current?.select());
      return;
    }
    if (mod && event.key.toLowerCase() === "g") {
      event.preventDefault();
      const answer = window.prompt(`Go to line (1–${lines.length})`);
      const line = Number(answer);
      if (Number.isInteger(line) && line > 0) {
        const start = offsetOfLine(text, line);
        const range = lineRangeAt(text, start);
        select(range.start, range.end);
      }
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      insert("  ");
      return;
    }

    if (event.key === "Enter") {
      // Auto-indent: carry the current line's indent, one level deeper after a
      // line that opened a block.
      event.preventDefault();
      insert(newlineIndent(text, element.selectionStart, language));
      return;
    }

    if (event.key === "Escape" && findOpen) {
      setFindOpen(false);
      return;
    }
  };

  /**
   * After a keystroke settles, snap a line that now closes a block back out one
   * level — typing `end` under an `if` should not leave it indented with the
   * body it closes. Done on keyup so the character is already in the text.
   */
  const handleKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    syncCursor();
    if (event.key.length !== 1) return;
    const element = event.currentTarget;
    const result = reindentClosing(text, element.selectionStart, language);
    if (!result) return;
    const caret = Math.max(0, element.selectionStart + result.shift);
    commit(result.text);
    requestAnimationFrame(() => {
      element.setSelectionRange(caret, caret);
      syncCursor();
    });
  };

  const changeLanguage = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setLanguage(event.target.value);
    doc.setLanguage(event.target.value);
  };

  // ---- find & replace -----------------------------------------------------

  const goToMatch = useCallback(
    (index: number) => {
      const match = matches[((index % matches.length) + matches.length) % matches.length];
      if (!match) return;
      setMatchIndex(((index % matches.length) + matches.length) % matches.length);
      select(match.start, match.end);
    },
    [matches, select],
  );

  const findNext = (backwards = false) => {
    if (matches.length === 0) return;
    const from = textareaRef.current?.selectionEnd ?? 0;
    goToMatch(matchIndex === 0 && from === 0 ? 0 : nextMatchIndex(matches, from, backwards));
  };

  const replaceCurrent = () => {
    const match = matches[matchIndex];
    if (!match) return;
    const result = replaceMatch(text, match, replacement);
    commit(result.text);
    requestAnimationFrame(() => select(result.caret, result.caret));
  };

  const replaceEvery = () => {
    if (matches.length === 0) return;
    commit(replaceAll(text, matches, replacement));
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
        <div>
          <div className={styles.groupLabel}>Search</div>
          <button type="button" className="cbx-btn" onClick={() => setFindOpen((open) => !open)}>
            {findOpen ? "Hide find" : "Find…"}
          </button>
          <p className={styles.pickerHint}>Ctrl+F finds · Ctrl+G goes to a line</p>
        </div>
      </aside>

      <section className={styles.codeStage}>
        {findOpen && (
          <div className={styles.findBar} role="search">
            <input
              ref={findRef}
              className={styles.findInput}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setMatchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  findNext(event.shiftKey);
                } else if (event.key === "Escape") {
                  setFindOpen(false);
                }
              }}
              placeholder="Find"
              aria-label="Find in code"
            />
            <input
              className={styles.findInput}
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
              placeholder="Replace with"
              aria-label="Replace with"
            />
            <span className={`${styles.findCount} data`}>
              {matches.length === 0 ? "no matches" : `${matchIndex + 1}/${matches.length}`}
            </span>
            <button type="button" className="cbx-btn" onClick={() => findNext(true)} aria-label="Previous match">
              ↑
            </button>
            <button type="button" className="cbx-btn" onClick={() => findNext(false)} aria-label="Next match">
              ↓
            </button>
            <button type="button" className="cbx-btn" onClick={replaceCurrent} disabled={matches.length === 0}>
              Replace
            </button>
            <button type="button" className="cbx-btn" onClick={replaceEvery} disabled={matches.length === 0}>
              All
            </button>
            <label className={styles.findToggle}>
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(event) => setCaseSensitive(event.target.checked)}
              />
              Aa
            </label>
            <button type="button" className={styles.bannerDismiss} onClick={() => setFindOpen(false)}>
              Close
            </button>
          </div>
        )}

        <div className={styles.codePane}>
          <div ref={gutterRef} className={`${styles.gutter} ${styles.codeMetrics}`} aria-hidden>
            {lines.map((_line, index) => (
              <div key={index} className={index + 1 === errorLine ? styles.gutterError : undefined}>
                {index + 1}
              </div>
            ))}
          </div>
          <div className={styles.codeScroll}>
            <pre ref={highlightRef} className={`${styles.codeLayer} ${styles.highlight} ${styles.codeMetrics}`} aria-hidden>
              <code>
                {tokenLines.map((tokens, line) => (
                  <span key={line}>
                    {tokens.map((token, index) => (
                      <span key={index} className={TOKEN_CLASS[token.type]}>
                        {token.value}
                      </span>
                    ))}
                    {line < tokenLines.length - 1 ? "\n" : ""}
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
              onKeyUp={handleKeyUp}
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
            <span className={styles.hudValue}>{config.label}</span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Lines</span>
            <span className={`${styles.hudValue} data`}>{lines.length}</span>
          </span>
          <span className={styles.hudItem}>
            <span className={styles.hudLabel}>Chars</span>
            <span className={`${styles.hudValue} data`}>{text.length}</span>
          </span>
          {errorLine ? (
            <span className={styles.hudItem}>
              <span className={styles.hudLabel}>Error</span>
              <span className={`${styles.hudValue} data`}>line {errorLine}</span>
            </span>
          ) : null}
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

        <SdkPanel onInsert={(snippet) => insert(snippet)} />
      </aside>
    </div>
  );
}

/** The legend dot borrows the token colour via currentColor from its class. */
function legendDotStyle(type: TokenType): React.CSSProperties {
  return type === "text" ? {} : { backgroundColor: "currentColor" };
}

export { errorLineFrom };
