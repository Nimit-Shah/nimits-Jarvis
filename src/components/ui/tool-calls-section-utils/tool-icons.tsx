import { ToolIcon } from "./icons";

const PREFIXES = ["COMPOSIO_", "RUBE_"];

export function formatToolName(name: string): string {
  let display = name;
  for (const prefix of PREFIXES) {
    if (display.startsWith(prefix)) {
      display = display.slice(prefix.length);
      break;
    }
  }
  return display
    .replace(/_/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function getToolCategory(toolName: string): string {
  let name = toolName;
  for (const prefix of PREFIXES) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  const parts = name.split("_");
  return parts[0]?.toLowerCase() ?? "general";
}

export function getToolCategoryIcon(
  category: string,
  size?: number,
) {
  return <ToolIcon category={category} size={size ?? 20} />;
}
