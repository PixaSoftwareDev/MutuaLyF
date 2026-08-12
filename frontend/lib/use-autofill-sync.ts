"use client";

import { useEffect, useRef } from "react";

/**
 * Sincroniza inputs CONTROLADOS con lo que el navegador realmente puso en el DOM.
 *
 * El problema (el bug del login que volvió 4 veces): un `<input value={estado}>`
 * es controlado — React cree que el valor es `estado` y solo escribe el DOM
 * cuando ese estado cambia. Pero hay tres caminos por los que el DOM se llena
 * SIN que React se entere:
 *
 *   1. Autofill del gestor de contraseñas de Chrome. Llega de forma asincrónica
 *      DESPUÉS del mount (a veces cientos de ms después, sobre todo cuando el
 *      form se pinta del lado del cliente) y no siempre dispara un evento que
 *      React vea. El usuario VE su email y su contraseña; `estado` sigue en "".
 *   2. Tipeo/autofill en la ventana pre-hidratación: el HTML ya está pintado
 *      pero React todavía no montó, así que no hay onChange que escuchar.
 *   3. Restauración de formulario del navegador al volver con el botón atrás
 *      (bfcache → evento `pageshow`).
 *
 * Consecuencia: al enviar, la validación corre contra el estado vacío y sale
 * "Ingresá tu email para continuar" con el campo lleno a la vista. El usuario
 * recarga, el autofill vuelve a correr con React ya vivo, y ahí sí entra.
 *
 * La defensa es doble y hay que mantener LAS DOS:
 *   - Este hook empuja DOM → estado apenas puede (mount + ventana de reintentos
 *     + señal `animationstart` del truco `:-webkit-autofill` de globals.css +
 *     `pageshow`), así la UI queda coherente.
 *   - `domFieldValue()` en el submit: el DOM manda sobre el estado. Es la red
 *     de seguridad para el caso en que el autofill llegue tan tarde que ni el
 *     último reintento lo haya visto.
 *
 * NO convertir estos formularios a no controlados "para simplificar": varias
 * pantallas necesitan el email en estado (paso multi-organización, recuperar
 * contraseña). El par hook + lectura del DOM cubre los dos mundos.
 */

/** Valor actual del input en el DOM, sin pasar por React. "" si no existe. */
export function domFieldValue(id: string): string {
  if (typeof document === "undefined") return "";
  const el = document.getElementById(id) as HTMLInputElement | null;
  return el?.value ?? "";
}

// Reintentos tras el mount, en ms. Cubren el autofill tardío de Chrome sin
// dejar timers vivos más allá del primer segundo y medio de la pantalla.
const RETRY_MS = [0, 40, 120, 300, 700, 1500];

// Debe coincidir con el @keyframes de globals.css que dispara `animationstart`
// cuando Chrome marca un input como autocompletado.
export const AUTOFILL_ANIMATION_NAME = "ia-autofill-start";

/**
 * @param fields mapa `id del input` → setter del estado. Se lee siempre la
 *               versión más fresca, así que no hace falta memoizarlo.
 */
export function useAutofillSync(fields: Record<string, (value: string) => void>): void {
  // El objeto se recrea en cada render; guardarlo en una ref evita re-suscribir
  // listeners y timers en cada uno (el efecto corre una sola vez).
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;

  useEffect(() => {
    let alive = true;

    const sync = () => {
      if (!alive) return;
      for (const [id, setValue] of Object.entries(fieldsRef.current)) {
        const domValue = domFieldValue(id);
        // Solo empujamos valores no vacíos: un campo vacío en el DOM significa
        // que el usuario lo borró tipeando, y eso ya viajó por onChange. Pisar
        // el estado con "" acá borraría lo que el usuario acaba de escribir si
        // el input todavía no está montado en este paso del formulario.
        if (domValue) setValue(domValue);
      }
    };

    const timers = RETRY_MS.map((ms) => setTimeout(sync, ms));

    // Señal explícita del navegador: Chrome dispara `animationstart` sobre los
    // inputs que acaba de autocompletar (ver globals.css). Es lo único que
    // convierte al autofill en un evento observable de forma confiable.
    const onAnimationStart = (e: AnimationEvent) => {
      if (e.animationName === AUTOFILL_ANIMATION_NAME) sync();
    };
    document.addEventListener("animationstart", onAnimationStart, true);
    // Vuelta con el botón atrás (bfcache): el navegador restaura los valores
    // del form pero React remonta con el estado inicial.
    window.addEventListener("pageshow", sync);

    return () => {
      alive = false;
      timers.forEach(clearTimeout);
      document.removeEventListener("animationstart", onAnimationStart, true);
      window.removeEventListener("pageshow", sync);
    };
  }, []);
}
