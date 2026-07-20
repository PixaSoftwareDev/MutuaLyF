"use client";

import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { ConversationsPanel } from "@/components/conversations/conversations-panel";

export default function OperatorPage() {
  return (
    <Suspense fallback={
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    }>
      <ConversationsPanel mode="operator" />
    </Suspense>
  );
}
