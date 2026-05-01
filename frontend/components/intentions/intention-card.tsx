"use client";

import { CheckCircle, XCircle, Zap, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface IntentionCardProps {
  id: string;
  label: string;
  description?: string | null;
  exampleCount: number;
  autoLearnedCount: number;
  isActive: boolean;
  isPending?: boolean;
  onApprove?: (id: string) => void;
  onReject?: (id: string) => void;
}

export function IntentionCard({
  id,
  label,
  description,
  exampleCount,
  autoLearnedCount,
  isActive,
  isPending,
  onApprove,
  onReject,
}: IntentionCardProps) {
  const autoLearnPct = exampleCount > 0 ? Math.round((autoLearnedCount / exampleCount) * 100) : 0;
  const capWarning = autoLearnPct >= 25; // Approaching 30% cap

  return (
    <Card className={isPending ? "border-yellow-300 bg-yellow-50/50" : ""}>
      <CardHeader className="pb-2 flex flex-row items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Zap className={`h-4 w-4 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
          <span className="font-medium text-sm truncate">{label}</span>
          {isPending && (
            <Badge variant="warning" className="shrink-0">
              Revisión
            </Badge>
          )}
          {!isActive && (
            <Badge variant="secondary" className="shrink-0">
              Inactiva
            </Badge>
          )}
        </div>

        {isPending && onApprove && onReject && (
          <div className="flex gap-1 shrink-0">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-green-600 hover:text-green-700 hover:bg-green-100"
              onClick={() => onApprove(id)}
              title="Aprobar"
            >
              <CheckCircle className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => onReject(id)}
              title="Rechazar"
            >
              <XCircle className="h-4 w-4" />
            </Button>
          </div>
        )}
      </CardHeader>

      <CardContent className="pt-0 space-y-2">
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <BookOpen className="h-3 w-3" />
            {exampleCount} ejemplos
          </span>
          {autoLearnedCount > 0 && (
            <span className={capWarning ? "text-yellow-700 font-medium" : ""}>
              {autoLearnedCount} auto-aprendidos ({autoLearnPct}%{capWarning ? " ⚠" : ""})
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
