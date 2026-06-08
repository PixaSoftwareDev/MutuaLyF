"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import Image from "next/image";
import { LogOut, Inbox, History, MoreVertical, UserCircle } from "lucide-react";
import { useAuthStore } from "@/lib/store";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useTenantBranding } from "@/lib/use-tenant-branding";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
function fullLogoUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `${API_URL}${url}`;
}

const NAV_ITEMS: Array<{ href: string; label: string; icon: typeof Inbox }> = [
  { href: "/operator",           label: "Bandeja",   icon: Inbox   },
  { href: "/operator/historial", label: "Historial", icon: History },
];

const ROLE_LABEL: Record<string, string> = {
  operator: "Operador",
  admin: "Administrador",
  super_admin: "Super admin",
};

export function OperatorTopbar() {
  const { userEmail, userRole, clearAuth } = useAuthStore();
  const roleLabel = ROLE_LABEL[userRole ?? ""] ?? "Operador";
  const router = useRouter();
  const pathname = usePathname();
  const { branding } = useTenantBranding();
  const brandLogoUrl = fullLogoUrl(branding.logo_url);

  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    clearAuth();
    router.push("/login");
  };

  return (
    // Topbar índigo-navy Intellix, coherente con el sidebar del admin. La marca
    // de la barra es Intellix (el producto); el tenant es contexto a la derecha.
    <header
      className="h-14 text-slate-300 flex items-center px-3 sm:px-4 gap-3 shrink-0 border-b border-white/[0.06]"
      style={{
        // Mismo mesh de marca del login (cyan/violeta/índigo) en versión oscura,
        // coherente con el sidebar del admin.
        background:
          "radial-gradient(40% 140% at 2% 0%, rgba(79,195,247,0.20) 0%, transparent 60%), radial-gradient(45% 150% at 35% 100%, rgba(122,45,255,0.16) 0%, transparent 60%), radial-gradient(50% 160% at 75% 0%, rgba(91,91,255,0.16) 0%, transparent 62%), linear-gradient(90deg, #1a1b3e 0%, #16172f 60%, #101126 100%)",
      }}
    >
      {/* Brand Intellix */}
      <Link href="/operator" className="flex items-center min-w-0" aria-label="Intellix">
        <Image
          src="/brand/intellix-wordmark-white.png"
          alt="Intellix"
          width={520}
          height={170}
          priority
          unoptimized
          className="h-[22px] w-auto object-contain"
        />
      </Link>

      {/* Nav tabs */}
      <nav className="hidden sm:flex items-center gap-1 ml-2">
        <span className="h-4 w-px bg-white/10 mr-1" />
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
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                active
                  ? "bg-white/[0.08] text-white"
                  : "text-slate-400 hover:text-white hover:bg-white/5",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Contexto del tenant — logo + organización en la que opera. */}
      <div className="hidden md:flex items-center gap-2 min-w-0">
        <div
          className="relative w-7 h-7 flex items-center justify-center shrink-0 rounded-md overflow-hidden ring-1 ring-white/10"
          style={!brandLogoUrl ? { background: branding.primary_color } : undefined}
        >
          {brandLogoUrl ? (
            <Image src={brandLogoUrl} alt={branding.display_name} width={28} height={28} className="w-full h-full object-contain" unoptimized />
          ) : (
            <span className="text-white font-bold text-[11px]">
              {(branding.display_name.trim()[0] ?? "?").toUpperCase()}
            </span>
          )}
        </div>
        <span className="text-[13px] font-medium text-white truncate max-w-[160px]">{branding.display_name}</span>
      </div>

      <span className="hidden md:block h-5 w-px bg-white/10" />

      {/* Operator identity — rol como identidad principal, email como secundario. */}
      <div className="hidden sm:flex flex-col items-end leading-tight min-w-0">
        <span className="text-xs font-medium text-white truncate max-w-[220px]">{roleLabel}</span>
        {userEmail && (
          <span className="text-[11px] text-slate-500 truncate max-w-[220px]">{userEmail}</span>
        )}
      </div>

      {/* Actions */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors shrink-0"
            aria-label="Acciones de cuenta"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="sm:hidden font-normal">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium truncate">{roleLabel}</span>
              {userEmail && (
                <span className="text-[11px] text-muted-foreground truncate">{userEmail}</span>
              )}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="sm:hidden" />
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
