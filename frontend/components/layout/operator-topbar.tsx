"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import Image from "next/image";
import { LogOut, Inbox, History, MoreVertical } from "lucide-react";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";

const NAV_ITEMS: Array<{ href: string; label: string; icon: typeof Inbox }> = [
  { href: "/operator",           label: "Bandeja",   icon: Inbox   },
  { href: "/operator/historial", label: "Historial", icon: History },
];

export function OperatorTopbar() {
  const { userEmail, tenantId, clearAuth } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();

  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    clearAuth();
    router.push("/login");
  };

  // Display the tenant as a stable, recognizable badge for the worker
  const tenantDisplay = (tenantId ?? "").toUpperCase();

  return (
    <header className="h-12 bg-brand text-white flex items-center px-3 sm:px-4 gap-3 shrink-0 border-b border-brand-dark/40">
      {/* Brand: logo + tenant name */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="relative w-7 h-7 flex items-center justify-center shrink-0">
          <Image
            src="/Logo.png"
            alt="MutualBot"
            width={28}
            height={28}
            className="w-full h-full object-cover rounded-sm"
            priority
            unoptimized
          />
        </div>
        <span className="font-semibold text-sm tracking-tight truncate">
          MutualBot
        </span>
      </div>

      {/* Nav tabs */}
      <nav className="hidden sm:flex items-center gap-1 ml-2">
        <span className="h-4 w-px bg-white/20 mr-1" />
        {NAV_ITEMS.map(item => {
          const active = item.href === "/operator"
            ? pathname === "/operator"
            : pathname?.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors",
                active
                  ? "bg-white/15 text-white font-medium"
                  : "text-white/70 hover:text-white hover:bg-white/10",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Operator identity */}
      <div className="hidden sm:flex flex-col items-end leading-tight min-w-0">
        <span className="text-xs font-medium text-white truncate max-w-[220px]">{userEmail}</span>
        <span className="text-[10px] text-white/60">Operador · {tenantDisplay}</span>
      </div>

      {/* Actions */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center justify-center w-8 h-8 rounded-md text-white/80 hover:text-white hover:bg-white/10 transition-colors shrink-0"
            aria-label="Acciones de cuenta"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="sm:hidden font-normal">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium truncate">{userEmail}</span>
              <span className="text-[10px] text-muted-foreground">Operador · {tenantDisplay}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="sm:hidden" />
          <DropdownMenuItem onSelect={handleLogout}>
            <LogOut className="h-4 w-4 mr-2" />
            Cerrar sesión
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
