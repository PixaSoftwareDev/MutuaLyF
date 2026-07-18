"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { GeneralSettings } from "@/components/admin/settings/general-settings";
import { ChannelsSettings } from "@/components/admin/settings/channels-settings";
import { HandoffSettings } from "@/components/admin/settings/handoff-settings";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

// ?tab= soporta valores viejos para no romper links guardados. La personalización
// del widget (ex "Apariencia") ahora vive en Canales → Widget → Personalizar, así
// que los links viejos ?tab=apariencia|branding aterrizan en Canales.
function resolveTab(param: string | null): string {
  if (param === "apariencia" || param === "branding" || param === "canales") return "canales";
  if (param === "derivacion" || param === "handoff") return "derivacion";
  return "asistente";
}

function SettingsContent() {
  const params = useSearchParams();
  const [tab, setTab] = useState(() => resolveTab(params.get("tab")));

  // En desktop la pestaña se elige desde el panel Sistema (subitems ?tab=) →
  // sincronizar cuando cambia la URL. En mobile siguen las tabs locales.
  useEffect(() => { setTab(resolveTab(params.get("tab"))); }, [params]);

  // Sub-pestañas del canal Widget (Instalar/Personalizar) — en la barra del
  // título (desktop), a la derecha. Gana la fila que antes ocupaban dentro del
  // contenido. Manejadas por URL para que la sección Widget las lea.
  const canalParam = params.get("canal");
  const onWidget = tab === "canales" && canalParam !== "whatsapp" && canalParam !== "all";
  const sub = params.get("sub") === "personalizar" ? "personalizar" : "instalar";
  const widgetSubTabs = onWidget ? (
    <div className="hidden rounded-lg bg-muted/60 p-0.5 lg:flex">
      {([["instalar", "Instalar"], ["personalizar", "Personalizar"]] as const).map(([key, label]) => (
        <Link
          key={key}
          href={`/admin/settings?tab=canales&canal=widget&sub=${key}`}
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

  return (
    <PageShell width="wide">
      <PageHeader title="Configuración" actions={widgetSubTabs} />

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        {/* Tabs solo en mobile: en desktop las reemplaza el submenú del panel */}
        <TabsList className="lg:hidden">
          <TabsTrigger value="asistente">Asistente</TabsTrigger>
          <TabsTrigger value="canales">Canales</TabsTrigger>
          <TabsTrigger value="derivacion">
            <span className="sm:hidden">Derivación</span>
            <span className="hidden sm:inline">Derivación a humano</span>
          </TabsTrigger>
        </TabsList>

        {/* mt-6 separa del TabsList en mobile; en desktop la lista está oculta y
            PageShell ya aporta el gap, así que anulamos el margen extra (evita un
            scroll de más por muy poco). */}
        <TabsContent value="asistente" className="mt-6 animate-fade-in lg:mt-0">
          <GeneralSettings />
        </TabsContent>
        <TabsContent value="canales" className="mt-6 animate-fade-in lg:mt-0">
          <ChannelsSettings />
        </TabsContent>
        <TabsContent value="derivacion" className="mt-6 animate-fade-in lg:mt-0">
          <HandoffSettings />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Cargando…</div>}>
      <SettingsContent />
    </Suspense>
  );
}
