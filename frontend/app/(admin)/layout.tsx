import { AdminGuard } from "@/components/auth-guard";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNavBar } from "@/components/layout/mobile-nav-bar";
import { OnboardingGate } from "@/components/admin/onboarding-gate";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminGuard>
      <div className="flex h-[100dvh] overflow-hidden bg-background">
        <Sidebar />
        <div className="flex flex-col flex-1 overflow-hidden min-w-0">
          <MobileNavBar />
          <main className="flex-1 overflow-auto">{children}</main>
        </div>
      </div>
      <OnboardingGate />
    </AdminGuard>
  );
}
