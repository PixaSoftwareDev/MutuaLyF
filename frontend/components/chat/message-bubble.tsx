"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Zap, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { renderWithLinks } from "@/lib/render-with-links";
import type { ChatMessage } from "@/lib/store";

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const isUser = message.role === "user";

  if (message.isLoading) {
    return (
      <div className="flex gap-3">
        <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
          <span className="text-primary text-xs font-bold">IA</span>
        </div>
        <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-3">
          <div className="flex gap-1 items-center h-5">
            <div className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
            <div className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
            <div className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex gap-3", isUser && "flex-row-reverse")}>
      {/* Avatar */}
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-0.5">
          <span className="text-primary text-xs font-bold">IA</span>
        </div>
      )}

      <div className={cn("max-w-[75%] space-y-1", isUser && "items-end flex flex-col")}>
        {/* Bubble */}
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
            isUser
              ? "bg-primary text-primary-foreground rounded-tr-sm"
              : "bg-muted text-foreground rounded-tl-sm"
          )}
        >
          {renderWithLinks(message.content)}
        </div>

        {/* Meta: intent + cache + latency */}
        {!isUser && (message.intent_label || message.from_cache || message.latency_ms) && (
          <div className="flex items-center gap-2 flex-wrap">
            {message.intent_label && (
              <Badge variant="secondary" className="text-xs gap-1">
                <Zap className="h-2.5 w-2.5" />
                {message.intent_label}
              </Badge>
            )}
            {message.from_cache && (
              <Badge variant="outline" className="text-xs text-success border-success/30">
                cache
              </Badge>
            )}
            {message.latency_ms !== undefined && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-2.5 w-2.5" />
                {message.latency_ms < 1000
                  ? `${message.latency_ms}ms`
                  : `${(message.latency_ms / 1000).toFixed(1)}s`}
              </span>
            )}
          </div>
        )}

        {/* Sources */}
        {!isUser && message.sources && message.sources.length > 0 && (
          <div className="w-full">
            <button
              onClick={() => setSourcesOpen((v) => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {sourcesOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {message.sources.length} fuente{message.sources.length !== 1 ? "s" : ""}
            </button>

            {sourcesOpen && (
              <div className="mt-1 space-y-1.5">
                {message.sources.map((src) => (
                  <div
                    key={src.chunk_id}
                    className="rounded-lg border bg-background p-2.5 text-xs space-y-0.5"
                  >
                    <div className="font-medium truncate text-foreground">{src.document_title}</div>
                    <div className="text-muted-foreground line-clamp-2">{src.content_excerpt}</div>
                    <div className="text-muted-foreground">
                      relevancia: {(src.score * 100).toFixed(0)}%
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
