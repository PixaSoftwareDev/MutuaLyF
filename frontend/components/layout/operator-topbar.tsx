"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import { LogOut, Inbox, History, MoreVertical, UserCircle } from "lucide-react";
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

  return (
    // Topbar CLARO, coherente con el login y el sidebar del admin. La marca de
    // la barra es Intellix (el producto); el tenant es contexto a la derecha.
    <header
      className="relative h-16 text-slate-600 flex items-center pr-3 sm:pr-5 gap-3 shrink-0 border-b border-slate-200"
      style={{
        // Superficie clara con tinte de marca leve y uniforme, igual que el
        // sidebar del admin.
        background: "#f1f2fb",
      }}
    >
      {/* Mesh de marca sutil — el mismo lenguaje del sidebar del admin y el
          login (cyan/violeta en las esquinas superiores). */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle at 0% 0%, #4FC3F726 0%, transparent 62%)," +
            "radial-gradient(circle at 100% 0%, #7A2DFF20 0%, transparent 60%)",
        }}
      />

      {/* Zona de marca: mismo ancho que la columna de la bandeja (w-80) — las
          tabs arrancan alineadas con el área de chat. Marca centrada en su zona;
          sin línea en el topbar (la divisoria la dibuja el contenido abajo). */}
      <div className="flex items-center h-full px-3 sm:px-5 sm:w-80 shrink-0 min-w-0 sm:justify-center">
        <Link href="/operator" className="flex items-center gap-2 min-w-0" aria-label="Intellix">
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
            className="h-[14px] w-auto object-contain hidden min-[420px]:block"
          />
        </Link>
      </div>

      {/* Nav tabs — visibles también en mobile (solo ícono): cambiar entre
          Bandeja e Historial es la acción más frecuente del operador y no
          debería requerir abrir el menú de tres puntos. */}
      <nav className="flex items-center gap-1 sm:ml-1">
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
                "flex items-center gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-lg text-xs font-medium transition-colors",
                active
                  ? "bg-action/[0.08] text-foreground font-semibold"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-100",
              )}
            >
              <Icon className={cn("h-4 w-4 sm:h-3.5 sm:w-3.5", active && "text-action")} />
              <span className="hidden sm:inline">{item.label}</span>
              {/* Cola de espera — visible también desde Historial, que es
                  cuando el operador no está mirando la bandeja. */}
              {item.href === "/operator" && waitingCount > 0 && (
                <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold inline-flex items-center justify-center tabular-nums shadow-sm">
                  {waitingCount > 9 ? "9+" : waitingCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Operator identity — rol como identidad principal, email como secundario.
          (El logo/nombre del tenant se quitó: el panel es identidad Intellix.) */}
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
