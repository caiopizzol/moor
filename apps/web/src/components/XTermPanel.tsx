import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

export type XTermHandle = {
  write: (data: string | Uint8Array) => void;
  clear: () => void;
  focus: () => void;
  terminal: Terminal | null;
};

type Props = {
  handle?: Ref<XTermHandle>;
  interactive?: boolean;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
};

const THEME = {
  background: "#0a0a0a",
  foreground: "#e0e0e0",
  cursor: "#e0e0e0",
  selectionBackground: "#252525",
};

export function XTermPanel({ handle, interactive, onData, onResize }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  onDataRef.current = onData;
  onResizeRef.current = onResize;

  useImperativeHandle(handle, () => ({
    write: (data: string | Uint8Array) => termRef.current?.write(data),
    clear: () => termRef.current?.clear(),
    focus: () => termRef.current?.focus(),
    terminal: termRef.current,
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: !!interactive,
      disableStdin: !interactive,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: THEME,
      scrollback: 10000,
      convertEol: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => onDataRef.current?.(data));

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      onResizeRef.current?.(term.cols, term.rows);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [interactive]);

  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    // Get all lines from the buffer
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  return (
    <div style={{ position: "relative" }}>
      <button type="button" className="copy-btn" onClick={handleCopy} title="Copy to clipboard">
        {copied ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>
      <div
        ref={containerRef}
        style={{
          height: 400,
          padding: 4,
          background: "#0a0a0a",
          borderRadius: 6,
          border: "1px solid #252525",
        }}
      />
    </div>
  );
}
