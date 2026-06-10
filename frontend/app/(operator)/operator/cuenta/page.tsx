"use client";

import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { AccountSettings } from "@/components/account/account-settings";

export default function AccountPage() {
  return (
    <PageShell>
      <PageHeader
        title="Mi cuenta"
        description="Editá tu nombre y contraseña. El nombre es lo que verán los afiliados cuando los atiendas."
      />
      <AccountSettings
        nameHint="Es el nombre que ven los afiliados cuando entrás a una conversación."
        emailHint="El email es tu identificador de acceso y no se puede cambiar. Para cambiarlo, pedile al administrador."
        showSectors
      />
    </PageShell>
  );
}
