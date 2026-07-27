"use client";

import { AccountSettings } from "@/components/account/account-settings";

export default function AdminAccountPage() {
  return (
    <AccountSettings
      emailHint="El email es tu identificador de acceso y no se puede cambiar."
    />
  );
}
