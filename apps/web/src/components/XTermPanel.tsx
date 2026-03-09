import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
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
  background: "#1a1a2e",
  foreground: "#e0e0e0",
  cursor: "#e0e0e0",
  selectionBackground: "#3a3a5e",
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

  return (
    <div
      ref={containerRef}
      style={{
        height: 400,
        padding: 4,
        background: THEME.background,
        borderRadius: 6,
      }}
    />
  );
}
