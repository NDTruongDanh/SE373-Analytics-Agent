import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export interface SafeMarkdownProps {
  content: string;
  className?: string;
}

/**
 * Render model-produced Markdown safely per architecture §1.2 Invariant 3:
 * raw HTML, remote images, and auto-links are disabled so untrusted DB rows
 * cannot inject scripts or exfiltrate data via external image/link beacons.
 */
export function SafeMarkdown({ content, className }: SafeMarkdownProps) {
  return (
    <div className={cn("space-y-2 text-[13px] leading-relaxed text-foreground", className)}>
      <Markdown
        skipHtml
        disallowedElements={["img", "a"]}
        unwrapDisallowed
        urlTransform={() => ""}
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="m-0 whitespace-pre-wrap leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="my-1 list-disc pl-5 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="my-1 list-decimal pl-5 space-y-1">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-accent-foreground">{children}</strong>,
          code: ({ children }) => (
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-accent-foreground">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-lg bg-[#f4f7f5] p-3 font-mono text-xs text-foreground">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border bg-muted/60 px-2.5 py-1.5 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="border-b border-border px-2.5 py-1.5">{children}</td>,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
