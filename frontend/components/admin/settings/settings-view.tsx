"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { GeneralSettings } from "@/components/admin/settings/general-settings";
import { ChannelsSettings } from "@/components/admin/settings/channels-settings";
import { HandoffSettings } from "@/components/admin/settings/handoff-settings";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

// Cada sección de Configuración es su propia ruta anidada:
//   /admin/settings           → Asistente (base)
//   /admin/settings/canales   → Canales (con ?canal= y ?sub= como sub-filtros)
//   /admin/settings/derivacion→ Derivación a humano
export type SettingsTab = "asistente" | "canales" | "derivacion";

const TABS: Array<{ key: SettingsTab; label: string; labelLg?: string; href: string }> = [
  { key: "asistente",  label: "Asistente",                       href: "/admin/settings" },
  { key: "canales",    label: "Canales",                          href: "/admin/settings/canales" },
  { key: "derivacion", label: "Derivación", labelLg: "Derivación a humano", href: "/admin/settings/derivacion" },
];

export function SettingsView({ tab }: { tab: SettingsTab }) {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Cargando…</div>}>
      <SettingsContent tab={tab} />
    </Suspense>
  );
}

function SettingsContent({ tab }: { tab: SettingsTab }) {
  const params = useSearchParams();

  // Sub-pestañas del canal Widget (Instalar/Personalizar) — a la derecha del
  // título en desktop. Siguen por query porque son sub-estado de Canales/Widget.
  const canalParam = params.get("canal");
  const onWidget = tab === "canales" && canalParam !== "whatsapp" && canalParam !== "all";
  const sub = params.get("sub") === "personalizar" ? "personalizar" : "instalar";
  const widgetSubTabs = onWidget ? (
    <div className="hidden rounded-lg bg-muted/60 p-0.5 lg:flex">
      {([["instalar", "Instalar"], ["personalizar", "Personalizar"]] as const).map(([key, label]) => (
        <Link
          key={key}
          href={`/admin/settings/canales?canal=widget&sub=${key}`}
          className={cn(
            "rounded-md px-3 py-1 text-[13px] font-medium transition-colors",
            sub === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </Link>
      ))}
    </div>
  ) : undefined;

  // Título específico de la pestaña (no el genérico "Configuración"): coherente
  // con Documentos/Operadores, que muestran el nombre de la sección.
  const current = TABS.find(t => t.key === tab);
  const title = current?.labelLg ?? current?.label ?? "Configuración";

  return (
    <PageShell width="wide">
      <PageHeader title={title} actions={widgetSubTabs} />

      {/* Tabs SOLO en mobile (links de ruta); en desktop las reemplaza el submenú. */}
      <div className="lg:hidden">
        <div className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground">
          {TABS.map(t => (
            <Link
              key={t.key}
              href={t.href}
              aria-current={tab === t.key ? "page" : undefined}
              className={cn(
                "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all",
                tab === t.key ? "bg-card text-foreground shadow-sm" : "hover:text-foreground",
              )}
            >
              {t.labelLg ? (
                <>
                  <span className="sm:hidden">{t.label}</span>
                  <span className="hidden sm:inline">{t.labelLg}</span>
                </>
              ) : t.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="mt-6 animate-fade-in lg:mt-0">
        {tab === "asistente"  && <GeneralSettings />}
        {tab === "canales"    && <ChannelsSettings />}
        {tab === "derivacion" && <HandoffSettings />}
      </div>
    </PageShell>
  );
}
