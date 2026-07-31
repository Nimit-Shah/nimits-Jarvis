"use client";

import { useState, useCallback } from "react";
import {
  Plus,
  Search,
  MoreHorizontal,
  Pencil,
  Trash2,
  MessageSquare,
  Puzzle,
  Settings,
  Sun,
  Moon,
  LogOut,
  ChevronDown,
  ChevronRight,
  Check,
  User,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { trpc } from "~/clients/trpc";
import { useInstanceId } from "~/hooks/use-instance-id";
import { useChatId } from "~/hooks/use-chat-id";
import { ErrorDisplay } from "~/components/core/error-display";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle } from "~/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "~/components/ui/alert-dialog";
import { authClient } from "~/clients/auth/react";
import { cn } from "~/lib/utils";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { SearchOverlay } from "./search-overlay";

export function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [instanceId] = useInstanceId();
  const [chatId, setChatId] = useChatId();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [profileExpanded, setProfileExpanded] = useState(false);

  const utils = trpc.useUtils();
  const { resolvedTheme, setTheme } = useTheme();

  const { data: chats, isLoading, error, refetch } = trpc.chats.list.useQuery(
    { instanceId },
    { staleTime: 30_000 },
  );

  const { data: instanceData } = trpc.nimitsJarvis.getInstance.useQuery(
    { instanceId },
    { enabled: true },
  );

  const instances = instanceData?.instances ?? [];
  const activeInstanceId = instanceId ?? instanceData?.instance?.id;
  const activeInstanceName =
    instances.find((i) => i.id === activeInstanceId)?.name ??
    instanceData?.instance?.name ??
    "Project";

  const createChat = trpc.chats.create.useMutation({
    onSuccess: (newChat) => {
      void utils.chats.list.invalidate();
      navigateToChat(newChat.id);
    },
  });

  const renameChat = trpc.chats.rename.useMutation({
    onSuccess: () => {
      void utils.chats.list.invalidate();
      setRenameTarget(null);
    },
  });

  const deleteChatMut = trpc.chats.delete.useMutation({
    onSuccess: () => {
      void utils.chats.list.invalidate();
      setDeleteTarget(null);
      if (chats && chats.length > 1) {
        const remaining = chats.filter((c) => c.id !== deleteTarget);
        if (remaining[0]) navigateToChat(remaining[0].id);
      }
    },
  });

  const navigateToChat = useCallback(
    (targetChatId: string) => {
      const qs = instanceId
        ? `?instance=${instanceId}&chat=${targetChatId}`
        : `?chat=${targetChatId}`;
      if (pathname !== "/dashboard") {
        router.push(`/dashboard${qs}`);
      } else {
        setChatId(targetChatId);
      }
    },
    [pathname, router, instanceId, setChatId],
  );

  const handleNewChat = useCallback(() => {
    void createChat.mutateAsync({ instanceId });
  }, [createChat, instanceId]);

  const handleRename = useCallback(
    (newName: string) => {
      if (renameTarget && newName.trim()) {
        void renameChat.mutateAsync({ chatId: renameTarget.id, name: newName.trim() });
      }
    },
    [renameTarget, renameChat],
  );

  const handleDelete = useCallback(() => {
    if (deleteTarget) {
      void deleteChatMut.mutateAsync({ chatId: deleteTarget });
    }
  }, [deleteTarget, deleteChatMut]);

  const handleProjectSwitch = async (id: string) => {
    if (id === activeInstanceId) {
      setProjectOpen(false);
      return;
    }
    
    // Update instance ID in URL and localStorage
    const params = new URLSearchParams(searchParams.toString());
    params.set("instance", id);
    params.delete("chat");
    
    try { localStorage.setItem("nimits-jarvis-active-instance", id); } catch {}
    
    // Invalidate and refetch data for new instance
    void utils.nimitsJarvis.getInstance.invalidate();
    void utils.chats.list.invalidate();
    
    // Fetch chats for the new project
    const newChats = await utils.chats.list.fetch({ instanceId: id });
    
    // Navigate to the most recent chat if available
    if (newChats && newChats.length > 0) {
      const mostRecentChat = newChats[0];
      if (mostRecentChat) {
        params.set("chat", mostRecentChat.id);
        try { localStorage.setItem("nimits-jarvis-active-chat", mostRecentChat.id); } catch {}
      }
    }
    
    router.push(`/dashboard?${params.toString()}`, { scroll: false });
    setProjectOpen(false);
  };

  const handleLogout = async () => {
    await authClient.signOut();
    router.push("/login");
  };

  const instanceQs = instanceId ? `?instance=${instanceId}` : "";

  return (
    <>
      <div className={cn(
        "flex flex-col h-full bg-card/50 border-r border-border/50 p-3 font-sans transition-all duration-300",
        isCollapsed ? "w-[64px]" : "w-[260px]",
      )}>
        {/* Header: Toggle + Project Selector */}
        <div className="shrink-0 flex items-center gap-2 mb-4">
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="p-1.5 rounded-md text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground transition-colors shrink-0"
          >
            {isCollapsed ? (
              <PanelLeftOpen className="w-[18px] h-[18px]" strokeWidth={1.5} />
            ) : (
              <PanelLeftClose className="w-[18px] h-[18px]" strokeWidth={1.5} />
            )}
          </button>

          {!isCollapsed && (
            <Popover open={projectOpen} onOpenChange={setProjectOpen}>
              <PopoverTrigger asChild>
                <button className="flex items-center justify-between flex-1 px-2 py-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors select-none group min-w-0">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-7 h-7 rounded-[6px] bg-primary text-primary-foreground flex items-center justify-center font-semibold text-[12px] shadow-sm shrink-0">
                      {activeInstanceName.charAt(0)}
                    </div>
                    <div className="flex flex-col overflow-hidden min-w-0">
                      <span className="text-[13px] font-medium leading-none mb-1 text-foreground truncate">
                        {activeInstanceName}
                      </span>
                    </div>
                  </div>
                  <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/50 group-hover:text-foreground/70 transition-colors shrink-0" strokeWidth={1.5} />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-1" align="start" side="bottom">
                <div className="space-y-0.5">
                  {instances.map((inst) => (
                    <button
                      key={inst.id}
                      onClick={() => handleProjectSwitch(inst.id)}
                      className={cn(
                        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground",
                        inst.id === activeInstanceId && "bg-accent text-accent-foreground font-medium",
                      )}
                    >
                      <span className="truncate">{inst.name}</span>
                      {inst.id === activeInstanceId && <Check className="size-3 shrink-0" />}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {/* New Chat Button */}
        <div className="shrink-0 mb-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleNewChat}
            disabled={createChat.isPending}
            className={cn(
              "w-full h-8 justify-start gap-2 text-xs",
              isCollapsed && "justify-center px-0",
            )}
          >
            <Plus className="size-3.5" />
            {!isCollapsed && <span>New Chat</span>}
          </Button>
        </div>

        {/* Navigation */}
        <div className="shrink-0 space-y-0.5 mb-2">
          <button
            onClick={() => setIsSearchOpen(true)}
            className={cn(
              "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground transition-colors cursor-pointer",
              isCollapsed && "justify-center px-0",
            )}
          >
            <Search className="size-3.5" />
            {!isCollapsed && <span>Search</span>}
            {!isCollapsed && (
              <kbd className="ml-auto hidden group-hover:inline-flex items-center justify-center h-5 px-1.5 text-[10px] font-medium font-mono text-muted-foreground/60 bg-background/50 border border-border/50 rounded-[4px] shadow-xs">
                ⌘K
              </kbd>
            )}
          </button>

          <Link href={`/dashboard/toolkits${instanceQs}`} className="block">
            <Button
              variant={pathname.startsWith("/dashboard/toolkits") ? "secondary" : "ghost"}
              size="sm"
              className={cn(
                "w-full h-8 justify-start gap-2 text-xs text-muted-foreground",
                isCollapsed && "justify-center px-0",
              )}
            >
              <Puzzle className="size-3.5" />
              {!isCollapsed && <span>Toolkits</span>}
            </Button>
          </Link>

          <Link href={`/dashboard/settings${instanceQs}`} className="block">
            <Button
              variant={pathname.startsWith("/dashboard/settings") ? "secondary" : "ghost"}
              size="sm"
              className={cn(
                "w-full h-8 justify-start gap-2 text-xs text-muted-foreground",
                isCollapsed && "justify-center px-0",
              )}
            >
              <Settings className="size-3.5" />
              {!isCollapsed && <span>Settings</span>}
            </Button>
          </Link>
        </div>

        {/* Separator */}
        <div className="h-px bg-border/50 my-2" />

        {/* Recent Chats - only when expanded */}
        {!isCollapsed && (
          <div className="min-h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            <p className="px-2 py-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground/50 uppercase">
              Recent
            </p>

            {isLoading && !chats ? (
              <div className="space-y-1 p-1">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-8 rounded-md bg-muted/50 animate-pulse" />
                ))}
              </div>
            ) : error ? (
              <div className="p-3">
                <ErrorDisplay message="Failed to load chats" retryText="Retry" onRetry={() => void refetch()} />
              </div>
            ) : !chats || chats.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1.5 p-6 text-center">
                <MessageSquare className="size-6 text-muted-foreground/30" />
                <p className="text-[12px] text-muted-foreground">No chats yet</p>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {chats.map((chat) => {
                  const isActive = chat.id === chatId;
                  return (
                    <div
                      key={chat.id}
                      onClick={() => navigateToChat(chat.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigateToChat(chat.id);
                        }
                      }}
                      className={cn(
                        "group flex w-full items-center gap-2 px-2 py-1.5 text-left transition-all duration-150 cursor-pointer rounded-md",
                        isActive
                          ? "bg-black/5 dark:bg-white/10 text-foreground font-medium"
                          : "hover:bg-black/5 dark:hover:bg-white/5 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <MessageSquare className="size-3 shrink-0 opacity-60" />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{chat.name}</span>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="size-3" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-32 p-1" align="end" side="right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start gap-2 h-7 text-[11px]"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenameTarget({ id: chat.id, name: chat.name });
                            }}
                          >
                            <Pencil className="size-3" /> Rename
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start gap-2 h-7 text-[11px] text-destructive hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget(chat.id);
                            }}
                          >
                            <Trash2 className="size-3" /> Delete
                          </Button>
                        </PopoverContent>
                      </Popover>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Collapsed chat icons */}
        {isCollapsed && (
          <div className="min-h-0 flex-1 overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] flex flex-col items-center gap-1 py-2">
            {chats?.slice(0, 8).map((chat) => {
              const isActive = chat.id === chatId;
              return (
                <button
                  key={chat.id}
                  onClick={() => navigateToChat(chat.id)}
                  className={cn(
                    "w-8 h-8 rounded-md flex items-center justify-center transition-colors",
                    isActive
                      ? "bg-black/5 dark:bg-white/10 text-foreground"
                      : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground",
                  )}
                  title={chat.name}
                >
                  <MessageSquare className="size-4" />
                </button>
              );
            })}
          </div>
        )}

        {/* Separator */}
        <div className="h-px bg-border/50 my-2" />

        {/* Profile Section */}
        <div className="shrink-0">
          <Popover open={profileExpanded} onOpenChange={setProfileExpanded}>
            <PopoverTrigger asChild>
              <button className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5",
                isCollapsed && "justify-center px-0",
              )}>
                <div className="size-7 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <User className="size-3.5 text-muted-foreground" />
                </div>
                {!isCollapsed && (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-foreground">{activeInstanceName}</p>
                    </div>
                    <ChevronDown
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
                        profileExpanded && "rotate-180",
                      )}
                    />
                  </>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1" align="start" side="top">
              <button
                onClick={() => {
                  setTheme(resolvedTheme === "dark" ? "light" : "dark");
                  setProfileExpanded(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                {resolvedTheme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
                {resolvedTheme === "dark" ? "Light Mode" : "Dark Mode"}
              </button>
              <button
                onClick={() => {
                  void handleLogout();
                  setProfileExpanded(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-destructive transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <LogOut className="size-3.5" /> Logout
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Search Overlay */}
      <SearchOverlay
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        instanceId={instanceId ?? ""}
        onSelectChat={navigateToChat}
      />

      {/* Rename Dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Rename Chat</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).querySelector("input");
              if (input) handleRename(input.value);
            }}
          >
            <Input
              defaultValue={renameTarget?.name}
              autoFocus
              placeholder="Chat name"
              className="mt-2 text-sm"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" size="sm" onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={renameChat.isPending}>
                {renameChat.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="sm:max-w-xs">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete Chat</AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]">
              This will permanently delete this chat and all its messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-[12px]">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteChatMut.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 text-[12px]"
            >
              {deleteChatMut.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
