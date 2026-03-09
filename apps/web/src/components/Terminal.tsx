import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

type Props = {
  projectId: number;
  running: boolean;
};

type Entry = {
  id: number;
  command: string;
  output: string;
};

let nextId = 0;

export function Terminal({ projectId, running }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [executing, setExecuting] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const command = input.trim();
    if (!command || !running) return;

    setInput("");
    setExecuting(true);

    try {
      const result = await api.projects.exec(projectId, command);
      const output = (result.stdout + result.stderr).trim();
      setEntries((prev) => [...prev, { id: ++nextId, command, output }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Command failed";
      setEntries((prev) => [...prev, { id: ++nextId, command, output: message }]);
    } finally {
      setExecuting(false);
    }
  };

  // Auto-scroll to bottom
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when entries change
  useEffect(() => {
    if (boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [entries]);

  // Focus input when tab becomes active
  useEffect(() => {
    if (running) inputRef.current?.focus();
  }, [running]);

  if (!running) {
    return <div className="log-empty">Container is not running.</div>;
  }

  return (
    <div>
      <div className="terminal-box" ref={boxRef}>
        {entries.map((entry) => (
          <div key={entry.id}>
            <span className="prompt">$ </span>
            <span className="output">{entry.command}</span>
            {entry.output && (
              <>
                {"\n"}
                <span className="output">{entry.output}</span>
              </>
            )}
            {"\n"}
          </div>
        ))}
        {executing && (
          <span className="prompt" style={{ opacity: 0.5 }}>
            running...
          </span>
        )}
      </div>
      <form className="terminal-input" onSubmit={handleSubmit}>
        <span className="prompt-char">$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={executing}
          placeholder="Type a command..."
          autoComplete="off"
          spellCheck={false}
        />
      </form>
    </div>
  );
}
