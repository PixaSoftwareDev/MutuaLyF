import { cn } from "@/lib/utils";

type Props = {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
};

/**
 * Standard page header. Title is plain text (no decorative icon, no color)
 * so the visual rhythm stays the same across every page. Actions slot is
 * for primary CTAs only — secondary actions belong inside the page body.
 */
export function PageHeader({ title, description, actions, className }: Props) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="text-2xl sm:text-[28px] font-bold tracking-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-muted-foreground mt-1.5">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
