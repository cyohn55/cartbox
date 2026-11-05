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
 *
 * Highlighting is incremental (AAA_PRODUCTION_ROADMAP.md K3): the tokenizer
 * carries a line-start state (inside a block comment or long string, or not),
 * so a keystroke re-tokenises its own line, and an opened or closed block
 * comment the lines it reaches, not the document (`LineTokenCache`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CodeDocument, LANGUAGES, LineTokenCache, addLuaModule, languageById, luaCompletions, luaDefinition, luaDiagnostics, luaFiles, readLuaFile, removeLuaModule, writeLuaFile, type TokenType } from "@cartbox/editor";

import styles from "./editor.module.css";
import { SdkPanel } from "./SdkPanel";
import { SDK_REFERENCE } from "./sdkReference";
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

/** The SDK reference's calls, for the language service (completion, arity). */
const SDK_ENTRIES = SDK_REFERENCE.flatMap((group) => group.entries);

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
  /**
   * Called once the jump has been made. Without it the line would be a standing
   * instruction: every later visit to this tab would re-fire the jump, stealing
   * focus and scrolling to a stale error for the rest of the session.
   */
  onErrorLineHandled?: () => void;
  /** Lines with a breakpoint (the playtest's debugger stops there), marked in the gutter. */
  breakpoints?: readonly number[];
  /** Clicking a line number sets or clears its breakpoint. */
  onToggleBreakpoint?: (line: number) => void;
}

export function CodeEditor({ doc, revision, errorLine, onErrorLineHandled, breakpoints, onToggleBreakpoint }: CodeEditorProps) {
  // The whole code, and the file shown (K1): null for all of it, else one Lua module's source.
  const [full, setFull] = useState(() => doc.getText());
  const [file, setFile] = useState<string | null>(null);
  const modules = useMemo(() => luaFiles(full).slice(1), [full]);
  const shown = file !== null && modules.includes(file) ? file : null;
  const text = useMemo(() => (shown === null ? full : readLuaFile(full, shown)), [full, shown]);
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

  // Line by line through a cache that carries each line's start state (see the note at the top of this file).
  const tokenCache = useMemo(() => new LineTokenCache(config), [config]);
  const lineTokens = useMemo(() => tokenCache.update(text), [tokenCache, text]);

  const matches = useMemo(
    () => (findOpen ? findMatches(text, query, { caseSensitive }) : []),
    [caseSensitive, findOpen, query, text],
  );

  const syncCursor = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    if (shown === null) setCursor(doc.positionAt(element.selectionStart));
    else {
      const before = element.value.slice(0, element.selectionStart).split("\n");
      setCursor({ line: before.length, column: before[before.length - 1]!.length + 1 });
    }
  }, [doc, shown]);

  /** Store the shown file's new text: the whole code, or one module's section of it. */
  const commit = useCallback(
    (next: string) => {
      const nextFull = shown === null ? next : writeLuaFile(full, shown, next);
      setFull(nextFull);
      doc.setText(nextFull);
    },
    [doc, full, shown],
  );

  // The language service (K2): problems, completion and go to definition, over the whole code.
  const isLua = language === "lua";
  const problems = useMemo(() => (isLua ? luaDiagnostics(full, SDK_ENTRIES) : []), [full, isLua]);
  const [suggest, setSuggest] = useState<{ from: number; to: number; items: { label: string; detail?: string }[] } | null>(null);
  /** The caret's offset in the whole code (the shown file may be one module). */
  const fullOffset = useCallback(
    (local: number) => {
      if (shown === null) return local;
      const marker = full.search(new RegExp(`^--#module[ \\t]+${shown.replace(/\./g, "\\.")}[ \\t]*$`, "m"));
      const start = marker < 0 ? 0 : full.indexOf("\n", marker) + 1;
      return start + local;
    },
    [full, shown],
  );
  const pendingJump = useRef<number | null>(null);
  const jumpToLine = useCallback((line: number) => {
    pendingJump.current = line;
    setFile(null);
  }, []);

  const addModule = () => {
    const name = window.prompt("New module name (letters, digits, _ and dots, like ai.patrol)")?.trim();
    if (!name) return;
    const next = addLuaModule(full, name);
    if (next === full) return;
    setFull(next);
    doc.setText(next);
    setFile(name);
  };

  const removeModule = (name: string) => {
    if (!window.confirm(`Remove module ${name} and its code?`)) return;
    const next = removeLuaModule(full, name);
    setFull(next);
    doc.setText(next);
    setFile(null);
  };

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
    setFull((current) => (current === fresh ? current : fresh));
    setLanguage(doc.language);
  }, [doc, revision]);

  // A runtime error names a line; select it so the cause is under the caret.
  // The gutter keeps marking it after the jump — the mark is the useful part —
  // but the jump itself happens once.
  const jumpedToRef = useRef<number | null>(null);
  useEffect(() => {
    if (!errorLine || jumpedToRef.current === errorLine) return;
    // A cart line: shown in the whole code.
    if (shown !== null) {
      setFile(null);
      return;
    }
    jumpedToRef.current = errorLine;
    const start = offsetOfLine(doc.getText(), errorLine);
    const range = lineRangeAt(doc.getText(), start);
    select(range.start, range.end);
    onErrorLineHandled?.();
  }, [doc, errorLine, onErrorLineHandled, select, shown]);

  // A definition or a problem picked: shown in the whole code, its line selected.
  useEffect(() => {
    const line = pendingJump.current;
    if (line === null || shown !== null) return;
    pendingJump.current = null;
    const range = lineRangeAt(full, offsetOfLine(full, line));
    select(range.start, range.end);
  });

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

    // Completion (Ctrl+Space) and go to definition (F12), for Lua.
    if (isLua && mod && event.key === " ") {
      event.preventDefault();
      const caret = element.selectionStart;
      const { from, items } = luaCompletions(full, fullOffset(caret), SDK_ENTRIES);
      setSuggest(items.length > 0 ? { from: caret - (fullOffset(caret) - from), to: caret, items: items.slice(0, 12) } : null);
      return;
    }
    if (isLua && event.key === "F12") {
      event.preventDefault();
      const line = luaDefinition(full, fullOffset(element.selectionStart));
      if (line !== null) jumpToLine(line);
      return;
    }
    if (event.key === "Escape" && suggest) {
      setSuggest(null);
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
        {language === "lua" && (
          <div>
            <div className={styles.groupLabel}>Files</div>
            <div style={{ display: "grid", gap: 4 }}>
              <button type="button" className={styles.toolBtn} aria-pressed={shown === null} onClick={() => setFile(null)} title="The cart's whole code (its line numbers are the ones errors and breakpoints use)">
                All code
              </button>
              {modules.map((name) => (
                <span key={name} style={{ display: "flex", gap: 4 }}>
                  <button type="button" className={styles.toolBtn} aria-pressed={shown === name} onClick={() => setFile(name)} style={{ flex: 1 }} title={`Edit module ${name}; load it with require("${name}")`}>
                    {name}
                  </button>
                  {shown === name && (
                    <button type="button" className={styles.toolBtn} onClick={() => removeModule(name)} aria-label={`Remove module ${name}`}>
                      ×
                    </button>
                  )}
                </span>
              ))}
              <button type="button" className={styles.toolBtn} onClick={addModule} title="A new Lua module: a file of the cart that require loads">
                + Module
              </button>
            </div>
          </div>
        )}
        {isLua && problems.length > 0 && (
          <div>
            <div className={styles.groupLabel}>Problems ({problems.length})</div>
            <div style={{ display: "grid", gap: 2, maxHeight: 160, overflowY: "auto", fontSize: 11 }}>
              {problems.slice(0, 50).map((p, i) => (
                <button
                  key={i}
                  type="button"
                  className={styles.toolBtn}
                  onClick={() => jumpToLine(p.line)}
                  style={{ textAlign: "left", color: p.severity === "error" ? "#ff6b6b" : "#e0b050" }}
                  title={p.message}
                >
                  {p.line}: {p.message}
                </button>
              ))}
            </div>
          </div>
        )}
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
        {suggest && (
          <div className={styles.findBar} role="listbox" aria-label="Suggestions">
            {suggest.items.map((item) => (
              <button
                key={item.label}
                type="button"
                className="cbx-btn"
                title={item.detail}
                onClick={() => {
                  const next = text.slice(0, suggest.from) + item.label + text.slice(suggest.to);
                  commit(next);
                  const caret = suggest.from + item.label.length;
                  setSuggest(null);
                  requestAnimationFrame(() => select(caret, caret));
                }}
              >
                {item.label}
              </button>
            ))}
            <button type="button" className={styles.bannerDismiss} onClick={() => setSuggest(null)}>
              Close
            </button>
          </div>
        )}
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
            {lines.map((_line, index) => {
              const line = index + 1;
              const marked = shown === null && (breakpoints?.includes(line) ?? false);
              return (
                <div
                  key={index}
                  data-line={line}
                  className={[shown === null && line === errorLine ? styles.gutterError : "", marked ? styles.gutterBreakpoint : ""].filter(Boolean).join(" ") || undefined}
                  onClick={onToggleBreakpoint && shown === null ? () => onToggleBreakpoint(line) : undefined}
                  title={onToggleBreakpoint && shown === null ? (marked ? "Remove breakpoint" : "Set a breakpoint: the playtest stops here") : undefined}
                  style={onToggleBreakpoint && shown === null ? { cursor: "pointer" } : undefined}
                >
                  {line}
                </div>
              );
            })}
          </div>
          <div className={styles.codeScroll}>
            <pre ref={highlightRef} className={`${styles.codeLayer} ${styles.highlight} ${styles.codeMetrics}`} aria-hidden>
              <code>
                {lineTokens.map((line, row) => (
                  <span key={row}>
                    {line.tokens.map((token, index) => (
                      <span key={index} className={TOKEN_CLASS[token.type]}>
                        {token.value}
                      </span>
                    ))}
                    {row < lineTokens.length - 1 ? "\n" : null}
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
