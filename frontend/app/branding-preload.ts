/**
 * Script inline que corre EN EL <head> antes de que el body se renderice.
 *
 * El branding del tenant se cargaba con React (useEffect + cache localStorage),
 * pero React monta despues del primer paint -> microflash visible al refrescar,
 * peor si el user apreta F5 muy seguido. Esta es la solucion estandar (la que
 * usan Next, GitHub, Vercel para el dark/light theme): un script sincrono que
 * lee el cache y aplica las CSS vars antes que el navegador pinte nada.
 *
 * Devuelve el script como string para inyectar con dangerouslySetInnerHTML.
 * El codigo debe ser ES5-safe (sin let, sin arrow, sin template literals
 * complicados) porque corre sin transpilar y queremos compat con browsers
 * viejos sin que rompa el preload.
 */
export const BRANDING_PRELOAD_SCRIPT = `
(function() {
  try {
    var path = window.location.pathname;
    // /login NUNCA muestra branding del tenant — es la cara de la plataforma.
    if (path === '/login' || path.indexOf('/login/') === 0) return;

    var params = new URLSearchParams(window.location.search);
    var tenantId = params.get('tenant') || localStorage.getItem('tenant_id');
    if (!tenantId || tenantId === '__platform__') return;

    var raw = localStorage.getItem('tenant_branding_cache');
    if (!raw) return;

    var map = JSON.parse(raw);
    // Backward-compat con la forma vieja del cache (v1: { tenant_id, branding })
    if (map && map.tenant_id && map.branding) {
      var tmp = {}; tmp[map.tenant_id] = map.branding; map = tmp;
    }

    var b = map[tenantId];
    if (!b || !b.primary_color) return;

    var hex = b.primary_color.replace('#', '');
    if (hex.length !== 6) return;

    var r = parseInt(hex.slice(0, 2), 16) / 255;
    var g = parseInt(hex.slice(2, 4), 16) / 255;
    var bl = parseInt(hex.slice(4, 6), 16) / 255;
    var max = Math.max(r, g, bl), min = Math.min(r, g, bl);
    var l = (max + min) / 2, s = 0, h = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - bl) / d + (g < bl ? 6 : 0);
      else if (max === g) h = (bl - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }

    function tuple(lightness) {
      return h.toFixed(1) + ' ' + (s * 100).toFixed(1) + '% ' + lightness.toFixed(1) + '%';
    }
    function clamp(n) { return Math.max(0, Math.min(100, n)); }

    var lPct = l * 100;
    var root = document.documentElement;
    root.style.setProperty('--brand',         tuple(lPct));
    root.style.setProperty('--brand-dark',    tuple(clamp(lPct - 15)));
    root.style.setProperty('--brand-light',   tuple(clamp(lPct + 15)));
    root.style.setProperty('--brand-primary', b.primary_color);
  } catch (e) { /* silent — peor caso: flash, no es bloqueante */ }
})();
`.trim();
