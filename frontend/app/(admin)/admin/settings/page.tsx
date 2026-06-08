"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GeneralSettings } from "@/components/admin/settings/general-settings";
import { HandoffSettings } from "@/components/admin/settings/handoff-settings";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

function SettingsContent() {
  const params = useSearchParams();
  const initial = params.get("tab") === "handoff" ? "handoff" : "general";
  const [tab, setTab] = useState(initial);

  return (
    <PageShell>
      <PageHeader
        eyebrow="Sistema"
        title="Configuración del bot"
        description="Ajustes del comportamiento del asistente y reglas de derivación a operadores humanos."
      />

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="handoff">Derivación a humano</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-6">
          <GeneralSettings />
        </TabsContent>
        <TabsContent value="handoff" className="mt-6">
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
