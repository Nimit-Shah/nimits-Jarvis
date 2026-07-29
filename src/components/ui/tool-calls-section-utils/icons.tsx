"use client";

import {
  Brain,
  Search,
  Mail,
  Calendar,
  MessageSquare,
  Github,
  FileText,
  Database,
  Globe,
  Wrench,
  Terminal,
  Code,
  Shield,
  Zap,
  Clock,
  Send,
  type LucideIcon,
} from "lucide-react";

const CATEGORY_LUCIDE_MAP: Record<string, LucideIcon> = {
  memory: Brain,
  search: Search,
  gmail: Mail,
  google_calendar: Calendar,
  slack: MessageSquare,
  github: Github,
  google_docs: FileText,
  google_drive: FileText,
  google_sheets: FileText,
  postgresql: Database,
  web: Globe,
  executor: Terminal,
  code: Code,
  security: Shield,
  handoff: Zap,
  schedule: Clock,
  send: Send,
};

function getIconForCategory(category: string): LucideIcon {
  return CATEGORY_LUCIDE_MAP[category] ?? Wrench;
}

export interface ToolIconProps {
  category: string;
  size?: number;
  className?: string;
}

export function ToolIcon({ category, size = 20, className }: ToolIconProps) {
  const LucideIcon = getIconForCategory(category);
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-md bg-muted/50 ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      <LucideIcon className="text-muted-foreground/70" style={{ width: size * 0.6, height: size * 0.6 }} />
    </div>
  );
}
