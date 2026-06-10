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
    // Topbar CLARO, coherente con el login y el sidebar del admin. La marca de
    // la barra es Intellix (el producto); el tenant es contexto a la derecha.
    <header
      className="h-14 text-slate-600 flex items-center px-3 sm:px-4 gap-3 shrink-0 border-b border-slate-200"
      style={{
        // Superficie clara con tinte de marca leve y uniforme, igual que el
        // sidebar del admin. Sin gradientes localizados.
        background: "#f1f2fb",
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

      {/* Nav tabs — visibles también en mobile (solo ícono): cambiar entre
          Bandeja e Historial es la acción más frecuente del operador y no
          debería requerir abrir el menú de tres puntos. */}
      <nav className="flex items-center gap-1 ml-1 sm:ml-2">
        <span className="hidden sm:block h-4 w-px bg-slate-200 mr-1" />
        {NAV_ITEMS.map(item => {
          const active = item.href === "/operator"
            ? pathname === "/operator"
            : pathname?.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              title={item.label}
              className={cn(
                "flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                active
                  ? "bg-action/[0.08] text-foreground font-semibold"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100",
              )}
            >
              <Icon className={cn("h-4 w-4 sm:h-3.5 sm:w-3.5", active && "text-action")} />
              <span className="hidden sm:inline">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Contexto del tenant — logo + organización en la que opera. */}
      <div className="hidden md:flex items-center gap-2 min-w-0">
        <div
          className="relative w-7 h-7 flex items-center justify-center shrink-0 rounded-md overflow-hidden ring-1 ring-slate-200"
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
        <span className="text-[13px] font-medium text-foreground truncate max-w-[160px]">{branding.display_name}</span>
      </div>

      <span className="hidden md:block h-5 w-px bg-slate-200" />

      {/* Operator identity — rol como identidad principal, email como secundario. */}
      <div className="hidden sm:flex flex-col items-end leading-tight min-w-0">
        <span className="text-xs font-medium text-foreground truncate max-w-[220px]">{roleLabel}</span>
        {userEmail && (
          <span className="text-[11px] text-slate-500 truncate max-w-[220px]">{userEmail}</span>
        )}
      </div>

      {/* Actions */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors shrink-0"
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
