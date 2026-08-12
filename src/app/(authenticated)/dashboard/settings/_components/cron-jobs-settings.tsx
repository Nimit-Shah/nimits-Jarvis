"use client";

import { Calendar, Clock, Loader2, Trash2 } from "lucide-react";
import { trpc } from "~/clients/trpc";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { AlertDialog } from "~/components/core/confirm-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import {
  showSuccessToast,
  trpcToastOnError,
} from "~/components/core/toast-notifications";
import { VirtualizedList } from "~/components/core/virtualized-list";
import { useInstanceId } from "~/hooks/use-instance-id";
import { DEFAULT_TIMEZONE, formatDateTimeLocal } from "~/lib/timezone";

function formatCronExpression(expression: string): string {
  const parts = expression.split(" ");
  if (parts.length !== 5) return expression;

  const minute = parts[0] ?? "0";
  const hour = parts[1] ?? "*";
  const dayOfMonth = parts[2] ?? "*";
  const month = parts[3] ?? "*";
  const dayOfWeek = parts[4] ?? "*";

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    if (minute === "0" && hour === "*") return "Every hour";
    if (hour === "*") return `Every hour at :${minute.padStart(2, "0")}`;
    return `Daily at ${hour}:${minute.padStart(2, "0")}`;
  }

  if (dayOfWeek !== "*" && dayOfMonth === "*" && month === "*") {
    const days: Record<string, string> = {
      "0": "Sunday",
      "1": "Monday",
      "2": "Tuesday",
      "3": "Wednesday",
      "4": "Thursday",
      "5": "Friday",
      "6": "Saturday",
    };
    const dayName = days[dayOfWeek] ?? dayOfWeek;
    return `Every ${dayName} at ${hour}:${minute.padStart(2, "0")}`;
  }

  return expression;
}

function formatDate(date: Date | null, timezone = DEFAULT_TIMEZONE): string {
  if (!date) return "\u2014";
  return formatDateTimeLocal(date, timezone);
}

export function CronJobsSettings() {
  const [instanceId] = useInstanceId();
  const utils = trpc.useUtils();

  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } =
    trpc.nimitsJarvis.getCronJobs.useInfiniteQuery(
      { instanceId, limit: 20 },
      { getNextPageParam: (lastPage) => lastPage.nextCursor },
    );

  const cronJobs = data?.pages.flatMap((page) => page.items) ?? [];

  const toggleCronJob = trpc.nimitsJarvis.toggleCronJob.useMutation({
    onSuccess: () => {
      void utils.nimitsJarvis.getCronJobs.invalidate();
    },
    onError: trpcToastOnError,
  });

  const deleteCronJob = trpc.nimitsJarvis.deleteCronJob.useMutation({
    onSuccess: () => {
      showSuccessToast("Cron job deleted");
      void utils.nimitsJarvis.getCronJobs.invalidate();
    },
    onError: trpcToastOnError,
  });

  const handleToggle = (jobId: string, enabled: boolean) => {
    void toggleCronJob.mutateAsync({ instanceId, jobId, enabled });
  };

  const handleDelete = (jobId: string) => {
    void deleteCronJob.mutateAsync({ instanceId, jobId });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scheduled Tasks</CardTitle>
        <CardDescription>
          Cron jobs that run your agent on a schedule
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : cronJobs.length === 0 ? (
          <div className="border-border rounded-lg border border-dashed p-6 text-center">
            <Calendar className="text-muted-foreground mx-auto mb-2 h-8 w-8" />
            <p className="text-muted-foreground text-sm">
              No scheduled tasks. Ask your agent to schedule something!
            </p>
          </div>
        ) : (
          <VirtualizedList
            items={cronJobs}
            renderItem={(job) => (
              <div className="border-border flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-sm font-medium">{job.prompt}</p>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatCronExpression(job.expression)}
                    </span>
                    {job.nextRunAt && (
                      <span>
                        Next: {formatDate(job.nextRunAt, job.timezone)}
                      </span>
                    )}
                    {!job.enabled && <Badge variant="secondary">Paused</Badge>}
                  </div>
                </div>
                <div className="flex items-center gap-2 self-end sm:self-center">
                  <Switch
                    checked={job.enabled}
                    onCheckedChange={(checked) => handleToggle(job.id, checked)}
                    disabled={toggleCronJob.isPending}
                  />
                  <AlertDialog
                    trigger={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        disabled={deleteCronJob.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    }
                    title="Delete Cron Job"
                    description={`This will permanently delete the scheduled task: "${job.prompt}"`}
                    confirmLabel="Delete"
                    onConfirm={() => handleDelete(job.id)}
                    isPending={deleteCronJob.isPending}
                  />
                </div>
              </div>
            )}
            estimateSize={100}
            className="max-h-64 md:max-h-96"
            onEndReached={() => {
              if (hasNextPage && !isFetchingNextPage) {
                void fetchNextPage();
              }
            }}
            footer={
              isFetchingNextPage ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
                </div>
              ) : null
            }
          />
        )}
      </CardContent>
    </Card>
  );
}
