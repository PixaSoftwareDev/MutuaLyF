/**
 * Detecta URLs en texto y las renderiza como <a> clickables.
 *
 * Se usa desde TODAS las UIs de chat: admin (message-bubble),
 * chat publico (app/chat/page), panel operador (conversations-panel),
 * y el widget embed (que tiene su version vanilla JS abajo).
 *
 * Detecta dos formatos:
 *   1. URLs con protocolo: https://example.com
 *   2. Dominios sin protocolo: example.com, soporte.empresa.com.ar
 *      (requiere TLD conocido para evitar falsos positivos)
 */

import React from "react";

// Matchea http(s):// seguido de cualquier cosa hasta espacio/comilla/etc.
const PROTO_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

// Matchea dominios sin protocolo: algo.tld o algo.sub.tld
// TLDs soportados: com, net, org, ar, com.ar, edu, gov, io, co, etc.
const BARE_DOMAIN_REGEX = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:com\.ar|net\.ar|org\.ar|gob\.ar|edu\.ar|com|net|org|io|co|ar|edu|gov|info|app|dev|ai)\b(?:\/[^\s<>"')\]]*)?/g;

function buildLinks(text: string, regex: RegExp, getHref: (raw: string) => string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    const href = getHref(raw);
    parts.push(
      <a
        key={match.index}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:opacity-80 break-all"
      >
        {raw}
      </a>,
    );
    last = match.index + raw.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function renderWithLinks(text: string): React.ReactNode[] {
  // Primera pasada: URLs con protocolo
  const afterProto = buildLinks(text, PROTO_REGEX, (u) => u);

  // Segunda pasada: sobre los segmentos de texto (no sobre los <a> ya creados)
  const result: React.ReactNode[] = [];
  for (const node of afterProto) {
    if (typeof node === "string") {
      const withBare = buildLinks(node, BARE_DOMAIN_REGEX, (u) => `https://${u}`);
      result.push(...withBare);
    } else {
      result.push(node);
    }
  }

  return result.length > 0 ? result : [text];
}
