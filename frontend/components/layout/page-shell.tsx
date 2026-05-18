import { cn } from "@/lib/utils";

type Props = {
  children: React.ReactNode;
  className?: string;
};

/**
 * Standard page container. Single source of truth for outer padding and
 * max-width across the back-office. Use it as the outermost wrapper of
 * every admin/superadmin page so the content rail stays consistent.
 */
export function PageShell({ children, className }: Props) {
  return (
    <div className={cn("p-4 sm:p-6 max-w-7xl mx-auto space-y-4 sm:space-y-6", className)}>
      {children}
    </div>
  );
}
