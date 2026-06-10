"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GeneralSettings } from "@/components/admin/settings/general-settings";
import { AppearanceSettings } from "@/components/admin/settings/appearance-settings";
import { ChannelsSettings } from "@/components/admin/settings/channels-settings";
import { HandoffSettings } from "@/components/admin/settings/handoff-settings";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

// ?tab= soporta los valores nuevos y los viejos (general/handoff) para no
// romper links guardados ni la redirección desde /admin/branding.
function resolveTab(param: string | null): string {
  if (param === "apariencia" || param === "branding") return "apariencia";
  if (param === "derivacion" || param === "handoff") return "derivacion";
  if (param === "canales") return "canales";
  return "asistente";
}

function SettingsContent() {
  const params = useSearchParams();
  const [tab, setTab] = useState(() => resolveTab(params.get("tab")));

  return (
    <PageShell>
      <PageHeader
        title="Configuración"
        description="Identidad, apariencia y comportamiento del asistente, y reglas de derivación a operadores humanos."
      />

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="asistente">Asistente</TabsTrigger>
          <TabsTrigger value="apariencia">Apariencia</TabsTrigger>
          <TabsTrigger value="canales">Canales</TabsTrigger>
          <TabsTrigger value="derivacion">Derivación a humano</TabsTrigger>
        </TabsList>

        <TabsContent value="asistente" className="mt-6">
          <GeneralSettings />
        </TabsContent>
        <TabsContent value="apariencia" className="mt-6">
          <AppearanceSettings />
        </TabsContent>
        <TabsContent value="canales" className="mt-6">
          <ChannelsSettings />
        </TabsContent>
        <TabsContent value="derivacion" className="mt-6">
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
