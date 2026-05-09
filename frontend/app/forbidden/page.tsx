"use client";

import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { ShieldX, ArrowLeft } from "lucide-react";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  operator: "Operador",
  super_admin: "Super Administrador",
};

export default function ForbiddenPage() {
  const router = useRouter();
  const { userRole, isAuthenticated } = useAuthStore();

  const roleLabel = userRole ? ROLE_LABELS[userRole] ?? userRole : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="flex justify-center">
          <div className="w-20 h-20 rounded-full bg-red-100 flex items-center justify-center">
            <ShieldX className="w-10 h-10 text-red-500" />
          </div>
        </div>

        <div className="space-y-2">
          <h1 className="text-3xl font-bold text-slate-900">Acceso denegado</h1>
          <p className="text-slate-500">
            {isAuthenticated && roleLabel
              ? `Tu rol de ${roleLabel} no tiene permiso para acceder a esta sección.`
              : "No tenés permisos para ver esta página."}
          </p>
        </div>

        {isAuthenticated && userRole && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
            <strong>Secciones disponibles para tu rol:</strong>
            <ul className="mt-1 space-y-0.5 text-amber-700">
              {userRole === "operator" && <li>• Panel de operador (/operator)</li>}
              {(userRole === "admin" || userRole === "super_admin") && (
                <>
                  <li>• Panel de operador (/operator)</li>
                  <li>• Panel de administrador (/admin)</li>
                </>
              )}
              {userRole === "super_admin" && <li>• Panel super admin (/superadmin)</li>}
            </ul>
          </div>
        )}

        <div className="flex gap-3 justify-center">
          <Button variant="outline" onClick={() => router.back()}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Volver
          </Button>
          <Button
            onClick={() => {
              if (userRole === "super_admin") router.push("/superadmin");
              else if (userRole === "operator") router.push("/operator");
              else if (userRole === "admin") router.push("/admin/documents");
              else router.push("/login");
            }}
          >
            Ir a mi panel
          </Button>
        </div>
      </div>
    </div>
  );
}
