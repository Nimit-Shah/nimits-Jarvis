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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
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
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [profileExpanded, setProfileExpanded] = useState(false);

  const utils = trpc.useUtils();
  const { resolvedTheme, setTheme } = useTheme();

  const {
    data: chats,
    isLoading,
    error,
    refetch,
  } = trpc.chats.list.useQuery({ instanceId }, { staleTime: 30_000 });

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
    // Pass the resolved instance id (URL param OR server-resolved default) so
    // the new chat is created under the project the user is actually viewing —
    // this is what picks up that project's default model.
    void createChat.mutateAsync({ instanceId: activeInstanceId });
  }, [createChat, activeInstanceId]);

  const handleRename = useCallback(
    (newName: string) => {
      if (renameTarget && newName.trim()) {
        void renameChat.mutateAsync({
          chatId: renameTarget.id,
          name: newName.trim(),
        });
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

    try {
      localStorage.setItem("nimits-jarvis-active-instance", id);
    } catch {}

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
        try {
          localStorage.setItem("nimits-jarvis-active-chat", mostRecentChat.id);
        } catch {}
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
      <div
        className={cn(
          "bg-card/50 border-border/50 flex h-full flex-col border-r p-3 font-sans transition-all duration-300",
          isCollapsed ? "w-[64px]" : "w-[260px]",
        )}
      >
        {/* Header: Toggle + Project Selector */}
        <div className="mb-4 flex shrink-0 items-center gap-2">
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="text-muted-foreground hover:text-foreground shrink-0 rounded-md p-1.5 transition-colors hover:bg-black/5 dark:hover:bg-white/5"
          >
            {isCollapsed ? (
              <PanelLeftOpen className="h-[18px] w-[18px]" strokeWidth={1.5} />
            ) : (
              <PanelLeftClose className="h-[18px] w-[18px]" strokeWidth={1.5} />
            )}
          </button>

          {!isCollapsed && (
            <Popover open={projectOpen} onOpenChange={setProjectOpen}>
              <PopoverTrigger asChild>
                <button className="group flex min-w-0 flex-1 cursor-pointer items-center justify-between rounded-lg px-2 py-1.5 transition-colors select-none hover:bg-black/5 dark:hover:bg-white/5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="bg-primary text-primary-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-[12px] font-semibold shadow-sm">
                      {activeInstanceName.charAt(0)}
                    </div>
                    <div className="flex min-w-0 flex-col overflow-hidden">
                      <span className="text-foreground mb-1 truncate text-[13px] leading-none font-medium">
                        {activeInstanceName}
                      </span>
                    </div>
                  </div>
                  <ChevronDown
                    className="text-muted-foreground/50 group-hover:text-foreground/70 h-3.5 w-3.5 shrink-0 transition-colors"
                    strokeWidth={1.5}
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-1" align="start" side="bottom">
                <div className="space-y-0.5">
                  {instances.map((inst) => (
                    <button
                      key={inst.id}
                      onClick={() => handleProjectSwitch(inst.id)}
                      className={cn(
                        "hover:bg-accent hover:text-accent-foreground flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors",
                        inst.id === activeInstanceId &&
                          "bg-accent text-accent-foreground font-medium",
                      )}
                    >
                      <span className="truncate">{inst.name}</span>
                      {inst.id === activeInstanceId && (
                        <Check className="size-3 shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {/* New Chat Button */}
        <div className="mb-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={handleNewChat}
            disabled={createChat.isPending}
            className={cn(
              "h-8 w-full justify-start gap-2 text-xs",
              isCollapsed && "justify-center px-0",
            )}
          >
            <Plus className="size-3.5" />
            {!isCollapsed && <span>New Chat</span>}
          </Button>
        </div>

        {/* Navigation */}
        <div className="mb-2 shrink-0 space-y-0.5">
          <button
            onClick={() => setIsSearchOpen(true)}
            className={cn(
              "text-muted-foreground hover:text-foreground flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/5",
              isCollapsed && "justify-center px-0",
            )}
          >
            <Search className="size-3.5" />
            {!isCollapsed && <span>Search</span>}
            {!isCollapsed && (
              <kbd className="text-muted-foreground/60 bg-background/50 border-border/50 ml-auto hidden h-5 items-center justify-center rounded-[4px] border px-1.5 font-mono text-[10px] font-medium shadow-xs group-hover:inline-flex">
                ⌘K
              </kbd>
            )}
          </button>

          <Link href={`/dashboard/toolkits${instanceQs}`} className="block">
            <Button
              variant={
                pathname.startsWith("/dashboard/toolkits")
                  ? "secondary"
                  : "ghost"
              }
              size="sm"
              className={cn(
                "text-muted-foreground h-8 w-full justify-start gap-2 text-xs",
                isCollapsed && "justify-center px-0",
              )}
            >
              <Puzzle className="size-3.5" />
              {!isCollapsed && <span>Toolkits</span>}
            </Button>
          </Link>

          <Link href={`/dashboard/settings${instanceQs}`} className="block">
            <Button
              variant={
                pathname.startsWith("/dashboard/settings")
                  ? "secondary"
                  : "ghost"
              }
              size="sm"
              className={cn(
                "text-muted-foreground h-8 w-full justify-start gap-2 text-xs",
                isCollapsed && "justify-center px-0",
              )}
            >
              <Settings className="size-3.5" />
              {!isCollapsed && <span>Settings</span>}
            </Button>
          </Link>
        </div>

        {/* Separator */}
        <div className="bg-border/50 my-2 h-px" />

        {/* Recent Chats - only when expanded */}
        {!isCollapsed && (
          <div className="min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            <p className="text-muted-foreground/50 px-2 py-1.5 text-[10px] font-semibold tracking-wider uppercase">
              Recent
            </p>

            {isLoading && !chats ? (
              <div className="space-y-1 p-1">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="bg-muted/50 h-8 animate-pulse rounded-md"
                  />
                ))}
              </div>
            ) : error ? (
              <div className="p-3">
                <ErrorDisplay
                  message="Failed to load chats"
                  retryText="Retry"
                  onRetry={() => void refetch()}
                />
              </div>
            ) : !chats || chats.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1.5 p-6 text-center">
                <MessageSquare className="text-muted-foreground/30 size-6" />
                <p className="text-muted-foreground text-[12px]">
                  No chats yet
                </p>
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
                        "group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-all duration-150",
                        isActive
                          ? "text-foreground bg-black/5 font-medium dark:bg-white/10"
                          : "text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5",
                      )}
                    >
                      <MessageSquare className="size-3 shrink-0 opacity-60" />
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        {chat.name}
                      </span>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="size-3" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-32 p-1"
                          align="end"
                          side="right"
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-full justify-start gap-2 text-[11px]"
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
                            className="text-destructive hover:text-destructive h-7 w-full justify-start gap-2 text-[11px]"
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
          <div className="flex min-h-0 flex-1 [scrollbar-width:none] flex-col items-center gap-1 overflow-y-auto py-2 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            {chats?.slice(0, 8).map((chat) => {
              const isActive = chat.id === chatId;
              return (
                <button
                  key={chat.id}
                  onClick={() => navigateToChat(chat.id)}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
                    isActive
                      ? "text-foreground bg-black/5 dark:bg-white/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5",
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
        <div className="bg-border/50 my-2 h-px" />

        {/* Profile Section */}
        <div className="shrink-0">
          <Popover open={profileExpanded} onOpenChange={setProfileExpanded}>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5",
                  isCollapsed && "justify-center px-0",
                )}
              >
                <div className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-full">
                  <User className="text-muted-foreground size-3.5" />
                </div>
                {!isCollapsed && (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="text-foreground truncate text-[12px] font-medium">
                        {activeInstanceName}
                      </p>
                    </div>
                    <ChevronDown
                      className={cn(
                        "text-muted-foreground size-3.5 shrink-0 transition-transform duration-200",
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
                className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors"
              >
                {resolvedTheme === "dark" ? (
                  <Sun className="size-3.5" />
                ) : (
                  <Moon className="size-3.5" />
                )}
                {resolvedTheme === "dark" ? "Light Mode" : "Dark Mode"}
              </button>
              <button
                onClick={() => {
                  void handleLogout();
                  setProfileExpanded(false);
                }}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors"
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
      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => !open && setRenameTarget(null)}
      >
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Rename Chat</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).querySelector(
                "input",
              );
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRenameTarget(null)}
              >
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
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent className="sm:max-w-xs">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete Chat</AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]">
              This will permanently delete this chat and all its messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-[12px]">
              Cancel
            </AlertDialogCancel>
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
