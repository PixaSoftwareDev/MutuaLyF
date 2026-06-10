"use client";

import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";
import { AccountSettings } from "@/components/account/account-settings";

export default function AdminAccountPage() {
  return (
    <PageShell>
      <PageHeader
        title="Mi cuenta"
        description="Tu perfil y tus credenciales de acceso."
      />
      <AccountSettings
        emailHint="El email es tu identificador de acceso y no se puede cambiar."
      />
    </PageShell>
  );
}
