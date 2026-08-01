// Las pantallas de auth llegan con el form ya renderizado por el server (en dev
// siempre; en prod /loginSuperadmin es HTML estático). Entre el primer paint y
// la hidratación de React hay una ventana en la que el form se ve pero no tiene
// handler: un click en "Ingresar" ahí dispara el submit NATIVO del form (GET a
// la misma URL) y la página se recarga en silencio con los campos vacíos — el
// "apreto ingresar y no entra, recargo y recién toma". Este script corre antes
// de la hidratación: traga esos submits y los deja anotados para que cada
// página los reenvíe al montar (ver el efecto de replay en login/page.tsx).
// Post-hidratación es inocuo: todos los forms de auth manejan el submit por JS
// y hacen su propio preventDefault. ES5-safe: corre sin transpilar.
const PREHYDRATION_SUBMIT_SCRIPT = `
document.addEventListener('submit', function (e) {
  if (window.__iaHydrated) return;
  e.preventDefault();
  window.__iaPendingSubmit = true;
}, true);
`.trim();

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: PREHYDRATION_SUBMIT_SCRIPT }} />
      {children}
    </>
  );
}
