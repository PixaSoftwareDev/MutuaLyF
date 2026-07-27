"use client";

import { AccountSettings } from "@/components/account/account-settings";

export default function AccountPage() {
  return (
    <AccountSettings
      nameHint="Es el nombre que ven los afiliados cuando entrás a una conversación."
      emailHint="El email es tu identificador de acceso y no se puede cambiar. Para cambiarlo, pedile al administrador."
      showSectors
    />
  );
}
