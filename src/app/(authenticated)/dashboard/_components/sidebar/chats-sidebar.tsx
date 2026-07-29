"use client";

import { useState, useCallback } from "react";
import { Plus, Search, MoreHorizontal, Pencil, Trash2, MessageSquare } from "lucide-react";
import moment from "moment";
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
import { ChatsSidebarSkeleton } from "./chats-sidebar.skeleton";

export function ChatsSidebar() {
  const [instanceId] = useInstanceId();
  const [chatId, setChatId] = useChatId();
  const [searchQuery, setSearchQuery] = useState("");
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const utils = trpc.useUtils();

  const { data: chats, isLoading, error, refetch } = trpc.chats.list.useQuery({ instanceId });

  const createChat = trpc.chats.create.useMutation({
    onSuccess: (newChat) => {
      void utils.chats.list.invalidate();
      setChatId(newChat.id);
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
      if (deleteTarget === chatId) {
        void createChat.mutateAsync({ instanceId });
      }
    },
  });

  const handleNewChat = useCallback(() => {
    const emptyNewChat = chats?.find((c) => c.name === "New Chat");
    if (emptyNewChat) {
      setChatId(emptyNewChat.id);
      return;
    }
    void createChat.mutateAsync({ instanceId });
  }, [createChat, instanceId, chats, setChatId]);

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

  if (isLoading) {
    return <ChatsSidebarSkeleton />;
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <ErrorDisplay message="Failed to load chats" retryText="Retry" onRetry={() => void refetch()} />
      </div>
    );
  }

  const filteredChats = chats?.filter((chat) =>
    chat.name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div className="flex h-full flex-col border-r border-border">
      {/* Header */}
      <div className="flex items-center gap-2 p-3">
        <Button
          variant="outline"
          size="sm"
          onClick={handleNewChat}
          disabled={createChat.isPending}
          className="flex-1 justify-start gap-2"
        >
          <Plus className="size-4" />
          <span>New Chat</span>
        </Button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search chats..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      {/* Chat list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!filteredChats || filteredChats.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
            <MessageSquare className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {searchQuery ? "No matching chats" : "No chats yet"}
            </p>
            {!searchQuery && (
              <Button variant="ghost" size="sm" onClick={handleNewChat}>
                Create your first chat
              </Button>
            )}
          </div>
        ) : (
          filteredChats.map((chat) => {
            const isActive = chat.id === chatId;
            return (
              <div
                key={chat.id}
                onClick={() => setChatId(chat.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setChatId(chat.id);
                  }
                }}
                className={`group flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors cursor-pointer rounded-lg mx-1 my-0.5 ${
                  isActive
                    ? "bg-accent/70 border-l-2 border-primary shadow-sm"
                    : "hover:bg-accent/30 border-l-2 border-transparent"
                }`}
              >
                <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{chat.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {moment(chat.updatedAt).fromNow()}
                  </p>
                </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-36 p-1" align="end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start gap-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameTarget({ id: chat.id, name: chat.name });
                      }}
                    >
                      <Pencil className="size-3.5" />
                      Rename
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start gap-2 text-destructive hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(chat.id);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </Button>
                  </PopoverContent>
                </Popover>
              </div>
            );
          })
        )}
      </div>

      {/* Rename Dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Chat</DialogTitle>
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
              className="mt-2"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={renameChat.isPending}>
                {renameChat.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Chat</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this chat and all its messages. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteChatMut.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteChatMut.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}