import { projectListCommand } from "./project";

export async function statusCommand(): Promise<number> {
  return projectListCommand([]);
}
