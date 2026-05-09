"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Settings, ArrowRightLeft } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GeneralSettings } from "@/components/admin/settings/general-settings";
import { HandoffSettings } from "@/components/admin/settings/handoff-settings";

function SettingsContent() {
  const params = useSearchParams();
  const initial = params.get("tab") === "handoff" ? "handoff" : "general";
  const [tab, setTab] = useState(initial);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings className="h-6 w-6 text-primary" />
          Configuración del bot
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Ajustes del comportamiento del asistente y reglas de derivación a operadores humanos.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="general" className="gap-1.5">
            <Settings className="h-3.5 w-3.5" />
            General
          </TabsTrigger>
          <TabsTrigger value="handoff" className="gap-1.5">
            <ArrowRightLeft className="h-3.5 w-3.5" />
            Derivación a humano
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-6">
          <GeneralSettings />
        </TabsContent>
        <TabsContent value="handoff" className="mt-6">
          <HandoffSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Cargando…</div>}>
      <SettingsContent />
    </Suspense>
  );
}
