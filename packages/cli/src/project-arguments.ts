import { type CommandOutput, writeError } from "./protocol";

export function parseProjectArguments(
  args: string[],
  usage: string,
  output: CommandOutput,
  booleanOptions: readonly string[] = [],
): { selector: string; json: boolean; flags: ReadonlySet<string> } | number {
  if (args.includes("--help") || args.includes("-h")) {
    output.stdout(`${usage}\n`);
    return 0;
  }
  const json = args.includes("--json");
  const flags = new Set(args.filter((arg) => booleanOptions.includes(arg)));
  const positional = args.filter((arg) => arg !== "--json" && !flags.has(arg));
  const option = positional.find((arg) => arg.startsWith("-"));
  const selector = positional[0];
  const error = option
    ? `Unknown option: ${option}`
    : positional.length > 1
      ? `Unexpected argument: ${positional[1]}`
      : undefined;
  if (error || !selector) {
    writeError(output, error ?? "Project is required", json);
    if (!json) output.stderr(`${usage}\n`);
    return 1;
  }
  return { selector, json, flags };
}
