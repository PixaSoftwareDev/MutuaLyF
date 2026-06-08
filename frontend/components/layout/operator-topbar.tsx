"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import Image from "next/image";
import { LogOut, Inbox, History, MoreVertical, UserCircle } from "lucide-react";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useTenantBranding } from "@/lib/use-tenant-branding";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
function fullLogoUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${API_URL}${url}`;
}
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
  const { userEmail, clearAuth } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const { branding } = useTenantBranding();
  const brandLogoUrl = fullLogoUrl(branding.logo_url);

  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    clearAuth();
    router.push("/login");
  };

  // Display the tenant as a stable, recognizable badge for the worker

  return (
    <header
      style={{ background: branding.primary_color }}
      className="h-14 text-brand-foreground flex items-center px-3 sm:px-4 gap-3 shrink-0 border-b border-black/20"
    >
      {/* Brand: logo + tenant name */}
      <div className="flex items-center gap-2 min-w-0">
        <div className={cn(
          "relative w-8 h-8 flex items-center justify-center shrink-0",
          !brandLogoUrl && "rounded-sm overflow-hidden bg-white/10",
        )}>
          {brandLogoUrl ? (
            <Image
              src={brandLogoUrl}
              alt={branding.display_name}
              width={32}
              height={32}
              className="w-full h-full object-contain"
              priority
              unoptimized
            />
          ) : (
            <span className="text-brand-foreground font-bold text-sm">
              {(branding.display_name.trim()[0] ?? "?").toUpperCase()}
            </span>
          )}
        </div>
        <span className="font-semibold text-sm tracking-tight truncate">
          {branding.display_name}
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
                  ? "bg-white/15 text-brand-foreground font-medium"
                  : "text-brand-foreground/70 hover:text-brand-foreground hover:bg-white/10",
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
        <span className="text-xs font-medium text-brand-foreground truncate max-w-[220px]">{userEmail}</span>
        <span className="text-[10px] text-brand-foreground/60">Operador · {branding.display_name}</span>
      </div>

      {/* Actions */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center justify-center w-8 h-8 rounded-md text-brand-foreground/80 hover:text-brand-foreground hover:bg-white/10 transition-colors shrink-0"
            aria-label="Acciones de cuenta"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="sm:hidden font-normal">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium truncate">{userEmail}</span>
              <span className="text-[10px] text-muted-foreground">Operador · {branding.display_name}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="sm:hidden" />
          {/* En mobile la nav (Bandeja/Historial) está oculta arriba: la repetimos
              acá para que el operador no pierda el acceso a Historial en el teléfono. */}
          {NAV_ITEMS.map(item => {
            const Icon = item.icon;
            return (
              <DropdownMenuItem key={item.href} className="sm:hidden" onSelect={() => router.push(item.href)}>
                <Icon className="h-4 w-4 mr-2" />
                {item.label}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator className="sm:hidden" />
          <DropdownMenuItem onSelect={() => router.push("/operator/cuenta")}>
            <UserCircle className="h-4 w-4 mr-2" />
            Mi cuenta
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleLogout}>
            <LogOut className="h-4 w-4 mr-2" />
            Cerrar sesión
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
