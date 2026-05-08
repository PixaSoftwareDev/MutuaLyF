// Route group layout for the operator panel.
// Intentionally minimal — no sidebar, no admin guard.
// Auth and role check happens in operator/layout.tsx.
export default function OperatorGroupLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
