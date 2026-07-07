"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import { LogOut, Inbox, History, UserCircle } from "lucide-react";
import { useAuthStore } from "@/lib/store";
import { useTenantBranding } from "@/lib/use-tenant-branding";
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
    <header
      className="relative h-16 flex items-center gap-3 sm:gap-4 px-3 sm:px-5 shrink-0 border-b border-slate-200"
      style={{ background: "#f1f2fb" }}
    >
      {/* Mesh de marca (cyan/violeta en las esquinas) — identidad Intellix, y de
          paso diferencia el topbar del contenido blanco. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle at 0% 0%, #4FC3F726 0%, transparent 62%)," +
            "radial-gradient(circle at 100% 0%, #7A2DFF20 0%, transparent 60%)",
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

        <div className="hidden sm:block h-6 w-px bg-slate-200 shrink-0" />

        {/* Nav tabs — segmented control. Cambiar entre Bandeja e Historial es la
            acción más frecuente del operador; siempre visible (ícono en mobile). */}
        <nav className="flex items-center gap-1 p-1 rounded-xl bg-slate-900/[0.04]">
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
                    ? "bg-white text-foreground font-semibold shadow-sm ring-1 ring-black/[0.04]"
                    : "text-slate-500 hover:text-slate-800",
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
            className="relative flex items-center gap-2.5 rounded-xl pl-2.5 pr-1.5 py-1 hover:bg-white/60 transition-colors shrink-0"
            aria-label="Acciones de cuenta"
          >
            <div className="hidden sm:flex flex-col items-end leading-tight min-w-0">
              <span className="text-xs font-semibold text-foreground truncate max-w-[200px]">{roleLabel}</span>
              {userEmail && (
                <span className="text-[11px] text-slate-500 truncate max-w-[200px]">{userEmail}</span>
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
          <DropdownMenuItem onSelect={handleLogout}>
            <LogOut className="h-4 w-4 mr-2" />
            Cerrar sesión
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
