"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import { LogOut, Inbox, History, UserCircle, Monitor, Sun, Moon } from "lucide-react";
import { useAuthStore } from "@/lib/store";
import { useTenantBranding } from "@/lib/use-tenant-branding";
import { useTheme } from "@/lib/theme";
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

  // Inyecta el color del tenant (--brand) en el panel del operador, igual que
  // el Sidebar del admin. Sin esto, las burbujas del chat (bg-brand) caían al
  // azul por defecto de --brand, mientras el admin y el widget las ven verdes.
  // No cambia la identidad Intellix del shell (eso vive en --action).
  useTenantBranding();
  const { pref: theme, setPref: setTheme } = useTheme();
  const THEMES = [
    { key: "auto"  as const, label: "Auto",   icon: Monitor },
    { key: "light" as const, label: "Claro",  icon: Sun },
    { key: "dark"  as const, label: "Oscuro", icon: Moon },
  ];

  // Conversaciones en espera — badge en la tab Bandeja. Misma query key que el
  // panel del operador: con la bandeja abierta comparten cache (cero requests
  // extra, el panel pollea cada 6s); en Historial este poll más relajado
  // mantiene el contador vivo, que es justo cuando el operador no está mirando
  // la cola y necesita enterarse.
  const { data: convsData } = useQuery({
    queryKey: ["operator-conversations", "all", "operator"],
    queryFn: () => api.operator.listConversations(),
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  const waitingCount = (convsData?.sectors ?? [])
    .flatMap((s: any) => s.conversations)
    .filter((c: any) => c.status === "handoff_requested").length;

  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* ignore */ }
    clearAuth();
    router.push("/login");
  };

  const avatarInitial = (userEmail?.trim()?.[0] ?? roleLabel[0] ?? "O").toUpperCase();

  return (
    // Topbar claro, coherente con el login y el sidebar del admin. Marca Intellix
    // a la izquierda junto a la navegación; identidad del operador a la derecha.
    <header className="relative flex h-14 shrink-0 items-center gap-3 border-b bg-card px-3 sm:gap-4 sm:px-5">
      {/* Mesh de marca sutil (cyan/violeta en las esquinas) — identidad Intellix. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 0% 0%, #22d3ee14 0%, transparent 55%)," +
            "radial-gradient(circle at 100% 0%, #7A2DFF14 0%, transparent 55%)",
        }}
      />

      {/* Izquierda: marca + navegación, agrupadas y separadas por un divisor. */}
      <div className="relative flex items-center gap-3 sm:gap-4 min-w-0">
        <Link href="/operator" className="flex items-center gap-2 shrink-0" aria-label="Intellix">
          <Image
            src="/brand/intellix-mark.png"
            alt=""
            width={1400}
            height={1400}
            priority
            unoptimized
            className="h-7 w-7 object-contain shrink-0"
          />
          <Image
            src="/brand/intellix-wordmark.png"
            alt=""
            width={1518}
            height={174}
            priority
            unoptimized
            className="h-[14px] w-auto object-contain hidden min-[520px]:block"
          />
        </Link>

        <div className="hidden h-6 w-px shrink-0 bg-border sm:block" />

        {/* Nav tabs — segmented control. Cambiar entre Bandeja e Historial es la
            acción más frecuente del operador; siempre visible (ícono en mobile). */}
        <nav className="flex items-center gap-1 rounded-xl bg-muted/60 p-1">
          {NAV_ITEMS.map(item => {
            const active = item.href === "/operator"
              ? pathname === "/operator"
              : pathname?.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.href === "/operator" && waitingCount > 0
                  ? `${item.label} — ${waitingCount} en espera`
                  : item.label}
                title={item.href === "/operator" && waitingCount > 0
                  ? `${item.label} — ${waitingCount} en espera`
                  : item.label}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all",
                  active
                    ? "bg-card text-foreground font-semibold shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className={cn("h-4 w-4 sm:h-3.5 sm:w-3.5", active && "text-action")} />
                <span className="hidden sm:inline">{item.label}</span>
                {item.href === "/operator" && waitingCount > 0 && (
                  <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold inline-flex items-center justify-center tabular-nums shadow-sm">
                    {waitingCount > 99 ? "99+" : waitingCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="flex-1" />

      {/* Derecha: identidad del operador (avatar + rol/email), clickeable → menú. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="relative flex shrink-0 items-center gap-2.5 rounded-xl py-1 pl-2.5 pr-1.5 transition-colors hover:bg-muted"
            aria-label="Acciones de cuenta"
          >
            <div className="hidden min-w-0 flex-col items-end leading-tight sm:flex">
              <span className="max-w-[200px] truncate text-xs font-semibold text-foreground">{roleLabel}</span>
              {userEmail && (
                <span className="max-w-[200px] truncate text-[11px] text-muted-foreground">{userEmail}</span>
              )}
            </div>
            <div
              className="h-8 w-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 shadow-sm"
              style={{ background: "linear-gradient(135deg, #22d3ee 0%, #6366f1 55%, #7A2DFF 100%)" }}
              aria-hidden
            >
              {avatarInitial}
            </div>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold truncate">{roleLabel}</span>
              {userEmail && (
                <span className="text-[11px] text-muted-foreground truncate">{userEmail}</span>
              )}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => router.push("/operator/cuenta")}>
            <UserCircle className="h-4 w-4 mr-2" />
            Mi cuenta
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/* Tema — dark/light igual que el admin */}
          <div className="flex h-9 items-center justify-between px-2">
            <span className="text-[13px] font-medium text-foreground">Tema</span>
            <div className="flex items-center gap-0.5">
              {THEMES.map(t => (
                <button
                  key={t.key}
                  onClick={() => setTheme(t.key)}
                  title={t.label}
                  aria-label={`Tema ${t.label}`}
                  aria-pressed={theme === t.key}
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
                    theme === t.key ? "bg-muted text-foreground" : "text-muted-foreground/60 hover:text-foreground",
                  )}
                >
                  <t.icon className="h-[15px] w-[15px]" />
                </button>
              ))}
            </div>
          </div>
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
