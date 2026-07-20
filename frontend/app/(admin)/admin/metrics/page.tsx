import { MetricsDashboard } from "@/components/admin/metrics-dashboard";

// Informe Resumen. Los otros informes son rutas hermanas (/asistente, /atencion).
export default function MetricsResumenPage() {
  return <MetricsDashboard view="resumen" />;
}
