"use client";

import { Badge } from "~/components/ui/badge";

export function McpStatusBadge({ status, needsSync }: { status: string; needsSync?: boolean }) {
  if (needsSync) {
    return <Badge variant="outline" className="border-amber-500 text-amber-600 text-[10px]">Sync needed</Badge>;
  }
  switch (status) {
    case "ok":
      return <Badge className="bg-green-600 text-white text-[10px]">Connected</Badge>;
    case "failed":
      return <Badge variant="destructive" className="text-[10px]">Failed</Badge>;
    case "unreachable":
      return <Badge variant="outline" className="text-[10px]">Unreachable</Badge>;
    default:
      return <Badge variant="outline" className="text-[10px]">Not tested</Badge>;
  }
}
