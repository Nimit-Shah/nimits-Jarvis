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
  Check,
  User,
} from "lucide-react";
import { trpc } from "~/clients/trpc";
import { useInstanceId } from "~/hooks/use-instance-id";
import { useChatId } from "~/hooks/use-chat-id";
import { ErrorDisplay } from "~/components/core/error-display";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
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

export function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [instanceId] = useInstanceId();
  const [chatId, setChatId] = useChatId();
  const [searchQuery, setSearchQuery] = useState("");
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

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

  // Navigate to chat — handles both in-chat and non-chat pages
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

  const handleProjectSwitch = (id: string) => {
    if (id === activeInstanceId) {
      setProjectOpen(false);
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set("instance", id);
    params.delete("chat");
    router.push(`/dashboard?${params.toString()}`, { scroll: false });
    try { localStorage.setItem("nimits-jarvis-active-instance", id); } catch {}
    void utils.nimitsJarvis.getInstance.invalidate();
    void utils.chats.list.invalidate();
    setProjectOpen(false);
  };

  const handleLogout = async () => {
    await authClient.signOut();
    router.push("/login");
  };

  const instanceQs = instanceId ? `?instance=${instanceId}` : "";

  const filteredChats = chats?.filter((chat) =>
    chat.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div className="flex h-full flex-col bg-card overflow-hidden">
      {/* ── Fixed Top: Project Selector ── */}
      <div className="shrink-0 p-3 pb-2">
        <Popover open={projectOpen} onOpenChange={setProjectOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className="w-full h-8 justify-between text-xs font-normal text-muted-foreground hover:text-foreground px-2"
            >
              <span className="truncate font-medium">{activeInstanceName}</span>
              <ChevronDown className="size-3 shrink-0 opacity-50" />
            </Button>
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
      </div>

      {/* ── Fixed Top: New Chat Button ── */}
      <div className="shrink-0 px-3 pb-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleNewChat}
          disabled={createChat.isPending}
          className="w-full h-8 justify-start gap-2 text-xs"
        >
          <Plus className="size-3.5" />
          <span>New Chat</span>
        </Button>
      </div>

      {/* ── Fixed Top: Navigation — Full-width stacked ── */}
      <div className="shrink-0 px-3 pb-2 space-y-1">
        <Link href={`/dashboard/toolkits${instanceQs}`} className="block">
          <Button
            variant={pathname.startsWith("/dashboard/toolkits") ? "secondary" : "ghost"}
            size="sm"
            className="w-full h-8 justify-start gap-2 text-xs text-muted-foreground"
          >
            <Puzzle className="size-3.5" />
            Toolkits
          </Button>
        </Link>
        <Link href={`/dashboard/settings${instanceQs}`} className="block">
          <Button
            variant={pathname.startsWith("/dashboard/settings") ? "secondary" : "ghost"}
            size="sm"
            className="w-full h-8 justify-start gap-2 text-xs text-muted-foreground"
          >
            <Settings className="size-3.5" />
            Settings
          </Button>
        </Link>
      </div>

      <Separator className="mx-3 w-auto" />

      {/* ── Search ── */}
      <div className="shrink-0 px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search chats..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-7 pl-7 text-[12px]"
          />
        </div>
      </div>

      {/* ── Scrollable Chat List ── */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
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
        ) : !filteredChats || filteredChats.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1.5 p-6 text-center">
            <MessageSquare className="size-6 text-muted-foreground/30" />
            <p className="text-[12px] text-muted-foreground">
              {searchQuery ? "No matching chats" : "No chats yet"}
            </p>
            {!searchQuery && (
              <Button variant="ghost" size="sm" onClick={handleNewChat} className="text-[11px] h-6">
                Create your first chat
              </Button>
            )}
          </div>
        ) : (
          <>
            {!searchQuery && (
              <p className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">
                Recent
              </p>
            )}
            {filteredChats.map((chat) => {
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
                      ? "bg-accent/60 text-foreground"
                      : "hover:bg-accent/30 text-muted-foreground hover:text-foreground",
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
                        <Pencil className="size-3" />
                        Rename
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
                        <Trash2 className="size-3" />
                        Delete
                      </Button>
                    </PopoverContent>
                  </Popover>
                </div>
              );
            })}
          </>
        )}
      </div>

      <Separator className="mx-3 w-auto" />

      {/* ── Fixed Bottom: Profile Menu ── */}
      <div className="shrink-0 p-3">
        <Popover open={profileOpen} onOpenChange={setProfileOpen}>
          <PopoverTrigger asChild>
            <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/30">
              <div className="size-7 rounded-full bg-muted flex items-center justify-center">
                <User className="size-3.5 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium text-foreground">
                  {activeInstanceName}
                </p>
              </div>
              <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${profileOpen ? "rotate-180" : ""}`} />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-48 p-1" align="start" side="top">
            <button
              onClick={() => {
                setTheme(resolvedTheme === "dark" ? "light" : "dark");
                setProfileOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {resolvedTheme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
              {resolvedTheme === "dark" ? "Light Mode" : "Dark Mode"}
            </button>

            <button
              onClick={() => {
                void handleLogout();
                setProfileOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-destructive transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <LogOut className="size-3.5" />
              Logout
            </button>
          </PopoverContent>
        </Popover>
      </div>

      {/* ── Rename Dialog ── */}
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

      {/* ── Delete Confirmation ── */}
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
    </div>
  );
}