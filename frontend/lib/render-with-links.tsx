/**
 * Detecta enlaces en el texto del bot y los renderiza como <a> clickables.
 *
 * Se usa desde TODAS las UIs de chat: admin (message-bubble),
 * chat publico (app/chat/page), panel operador (conversations-panel),
 * y el widget embed (que tiene su version vanilla JS en widget.js).
 *
 * Detecta tres formatos (en este orden de prioridad):
 *   0. Markdown links: [etiqueta](https://url)  → muestra solo "etiqueta"
 *      (el LLM genera este formato; sin esto se veía el markdown crudo + la URL)
 *   1. URLs con protocolo: https://example.com
 *   2. Dominios sin protocolo: example.com, soporte.empresa.com.ar
 *      (requiere TLD conocido para evitar falsos positivos)
 */

import React from "react";

// [etiqueta](https://url) — la etiqueta es lo que se muestra; la url es el href.
const MD_LINK_REGEX = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
// http(s):// hasta espacio/comilla/cierre.
const PROTO_REGEX = /https?:\/\/[^\s<>"')\]]+/g;
// Dominios sin protocolo: algo.tld o algo.sub.tld
const BARE_DOMAIN_REGEX = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:com\.ar|net\.ar|org\.ar|gob\.ar|edu\.ar|com|net|org|io|co|ar|edu|gov|info|app|dev|ai)\b(?:\/[^\s<>"')\]]*)?/g;

const ANCHOR_CLASS = "underline underline-offset-2 hover:opacity-80 break-all";

function anchor(href: string, label: string, key: string): React.ReactNode {
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer" className={ANCHOR_CLASS}>
      {label}
    </a>
  );
}

// Pasada 0: Markdown [etiqueta](url). Devuelve nodos string + <a>.
function buildMarkdownLinks(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  MD_LINK_REGEX.lastIndex = 0;
  while ((match = MD_LINK_REGEX.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(anchor(match[2], match[1], `md-${match.index}`));
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// Pasadas 1/2: URLs sueltas sobre un segmento de texto plano.
function buildLinks(
  text: string,
  regex: RegExp,
  getHref: (raw: string) => string,
  keyPrefix: string,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    parts.push(anchor(getHref(raw), raw, `${keyPrefix}-${match.index}`));
    last = match.index + raw.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function renderWithLinks(text: string): React.ReactNode[] {
  // 0. Markdown links primero (consume [etiqueta](url) enteros).
  // 1/2. Sobre los segmentos de texto restantes (no sobre los <a> ya creados):
  //      URLs con protocolo, luego dominios sin protocolo.
  const result: React.ReactNode[] = [];
  for (const mdNode of buildMarkdownLinks(text)) {
    if (typeof mdNode !== "string") { result.push(mdNode); continue; }
    for (const protoNode of buildLinks(mdNode, PROTO_REGEX, (u) => u, "p")) {
      if (typeof protoNode !== "string") { result.push(protoNode); continue; }
      result.push(...buildLinks(protoNode, BARE_DOMAIN_REGEX, (u) => `https://${u}`, "b"));
    }
  }
  return result.length > 0 ? result : [text];
}
