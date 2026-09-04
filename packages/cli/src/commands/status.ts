import { projectListCommand } from "./project";

export async function statusCommand(args: string[] = []): Promise<number> {
  return projectListCommand(args);
}
