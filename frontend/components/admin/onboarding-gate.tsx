"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { OnboardingModal } from "./onboarding-modal";

export function OnboardingGate() {
  const { tenantId, userRole, _hasHydrated } = useAuthStore();

  const { data: botConfig, isLoading } = useQuery({
    queryKey: ["bot-config", tenantId],
    queryFn: () => api.tenants.getBotConfig(tenantId!),
    enabled: !!tenantId && _hasHydrated && userRole === "admin",
    staleTime: 60_000,
  });

  if (!_hasHydrated || isLoading || !tenantId || userRole !== "admin") return null;
  if (botConfig?.onboarding_completed) return null;

  return <OnboardingModal />;
}
