"use client"

import { memo, type ComponentProps } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "~/lib/utils"

type ResponseProps = ComponentProps<typeof Markdown> & { className?: string }

export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <div
      className={cn(
        "prose prose-neutral dark:prose-invert size-full max-w-none",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
    >
      <Markdown remarkPlugins={[remarkGfm]} {...props} />
    </div>
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
)
Response.displayName = "Response"
