/**
 * Detecta URLs en texto y las renderiza como <a> clickables.
 *
 * Se usa desde TODAS las UIs de chat: admin (message-bubble),
 * chat publico (app/chat/page), panel operador (conversations-panel),
 * y el widget embed (que tiene su version vanilla JS abajo).
 *
 * Regex: matchea http://... y https://... hasta el primer espacio,
 * comilla, parentesis o corchete. Strip de puntuacion final (".,;:!?")
 * porque es comun que el LLM escriba "visita https://example.com."
 * y no queremos que el punto entre al link.
 */

import React from "react";

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

export function renderWithLinks(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  // Reset lastIndex porque el regex es global y persiste estado.
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    // Strip trailing punctuation que no es parte de la URL.
    const url = match[0].replace(/[.,;:!?]+$/, "");
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:opacity-80 break-all"
      >
        {url}
      </a>,
    );
    last = match.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : [text];
}
