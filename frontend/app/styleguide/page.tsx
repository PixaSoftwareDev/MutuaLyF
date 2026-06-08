"use client";

/**
 * Sistema de diseño (styleguide vivo). Página standalone para revisar tokens y
 * componentes base antes de aplicarlos a todo el panel. NO afecta la app: es una
 * ruta aparte (/styleguide). Borrable cuando el sistema esté aprobado.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Inbox, Plus, Search, FileText, Settings, Loader2, Check, Trash2, Upload,
} from "lucide-react";

function Swatch({ name, varName, className }: { name: string; varName: string; className: string }) {
  return (
    <div className="space-y-1.5">
      <div className={`h-16 rounded-xl border shadow-xs ${className}`} />
      <div className="px-0.5">
        <p className="text-xs font-semibold text-foreground">{name}</p>
        <p className="text-[11px] text-muted-foreground font-mono">{varName}</p>
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-5">
      <div className="border-b pb-3">
        <h2 className="text-xl font-bold tracking-tight text-foreground">{title}</h2>
        {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

export default function StyleguidePage() {
  const [demo, setDemo] = useState("");
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-6 sm:px-8 py-10 space-y-14">

        {/* Header */}
        <header className="space-y-2">
          <Badge variant="info">Propuesta · v1</Badge>
          <h1 className="text-3xl sm:text-[34px] font-bold tracking-tight text-foreground">Sistema de diseño</h1>
          <p className="text-base text-muted-foreground max-w-2xl">
            Tokens y componentes base del panel. Acento <span className="text-action font-semibold">índigo</span> con
            intención, neutros graduados, tipografía con jerarquía y un shell oscuro para la navegación.
          </p>
        </header>

        {/* COLOR */}
        <Section title="Color" subtitle="Acento de acción + estados semánticos + neutros en capas.">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Acento y estados</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
              <Swatch name="Acción (índigo)" varName="--action" className="bg-action" />
              <Swatch name="Éxito" varName="--success" className="bg-success" />
              <Swatch name="Atención" varName="--warning" className="bg-warning" />
              <Swatch name="Info" varName="--info" className="bg-info" />
              <Swatch name="Peligro" varName="--destructive" className="bg-destructive" />
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Superficies y neutros</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
              <Swatch name="Fondo (canvas)" varName="--background" className="bg-background" />
              <Swatch name="Tarjeta" varName="--card" className="bg-card" />
              <Swatch name="Sutil" varName="--muted" className="bg-muted" />
              <Swatch name="Borde" varName="--border" className="bg-border" />
              <Swatch name="Shell oscuro" varName="sidebar" className="bg-[#1c1815]" />
            </div>
          </div>
        </Section>

        {/* TIPOGRAFÍA */}
        <Section title="Tipografía" subtitle="Plus Jakarta Sans — geométrica moderna con carácter. Jerarquía clara.">
          <Card>
            <CardContent className="pt-6 space-y-3">
              <p className="text-3xl font-bold tracking-tight text-foreground">Título de página · 34/28px bold</p>
              <p className="text-xl font-semibold tracking-tight text-foreground">Encabezado de sección · 20px semibold</p>
              <p className="text-base text-foreground">Texto de cuerpo · 16px regular. Buen interlineado para lectura cómoda en pantallas de trabajo prolongado.</p>
              <p className="text-sm text-muted-foreground">Texto secundario / descripciones · 14px atenuado.</p>
              <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">Label de sección · 12px uppercase</p>
            </CardContent>
          </Card>
        </Section>

        {/* BOTONES */}
        <Section title="Botones" subtitle="Primario en acento índigo. Variantes y estados consistentes.">
          <div className="flex flex-wrap items-center gap-3">
            <Button><Plus className="h-4 w-4 mr-1.5" /> Primario</Button>
            <Button variant="secondary">Secundario</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive"><Trash2 className="h-4 w-4 mr-1.5" /> Eliminar</Button>
            <Button variant="link">Link</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="xs">Extra chico</Button>
            <Button size="sm">Chico</Button>
            <Button>Normal</Button>
            <Button size="lg">Grande</Button>
            <Button disabled>Deshabilitado</Button>
            <Button disabled><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Guardando…</Button>
          </div>
        </Section>

        {/* INPUTS */}
        <Section title="Inputs" subtitle="Campos táctiles con foco en el acento.">
          <div className="grid sm:grid-cols-2 gap-4 max-w-xl">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground/80">Campo normal</label>
              <Input placeholder="Escribí algo…" value={demo} onChange={e => setDemo(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground/80">Con icono</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Buscar…" className="pl-9" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground/80">Deshabilitado</label>
              <Input placeholder="No editable" disabled />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground/80">Con error</label>
              <Input placeholder="Valor inválido" className="border-destructive focus-visible:ring-destructive" />
            </div>
          </div>
        </Section>

        {/* CARDS */}
        <Section title="Cards" subtitle="Bordes sutiles, sombra suave, radios generosos, padding cómodo.">
          <div className="grid sm:grid-cols-2 gap-5">
            <Card>
              <CardHeader>
                <CardTitle>Documentos</CardTitle>
                <CardDescription>Base de conocimiento del asistente.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">Las cards tienen profundidad y respiran. El contenido se agrupa con jerarquía clara.</p>
              </CardContent>
              <CardFooter className="gap-2">
                <Button size="sm"><Upload className="h-4 w-4 mr-1.5" /> Subir</Button>
                <Button size="sm" variant="ghost">Cancelar</Button>
              </CardFooter>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  Estado del bot
                  <Badge variant="success"><Check className="h-3 w-3 mr-1" /> Activo</Badge>
                </CardTitle>
                <CardDescription>Resumen rápido con métrica de cabecera.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold tabular-nums text-foreground">1.284</p>
                <p className="text-xs text-muted-foreground mt-1">consultas en los últimos 30 días</p>
              </CardContent>
            </Card>
          </div>
        </Section>

        {/* BADGES */}
        <Section title="Badges / etiquetas" subtitle="Estados con color semántico, prolijos y legibles.">
          <div className="flex flex-wrap gap-2.5">
            <Badge>Default</Badge>
            <Badge variant="secondary">Secundario</Badge>
            <Badge variant="success">Listo</Badge>
            <Badge variant="warning">Pendiente</Badge>
            <Badge variant="info">Info</Badge>
            <Badge variant="destructive">Error</Badge>
            <Badge variant="outline">Outline</Badge>
          </div>
        </Section>

        {/* SIDEBAR ITEM */}
        <Section title="Navegación (shell oscuro)" subtitle="Ítem activo con barra de acento del color de marca del tenant.">
          <div className="max-w-[260px] rounded-2xl bg-[#1c1815] p-3 space-y-0.5 border border-white/[0.06]">
            <p className="px-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Conocimiento</p>
            {[
              { icon: Inbox, label: "Conversaciones", active: false },
              { icon: FileText, label: "Documentos", active: true },
              { icon: Settings, label: "Configuración", active: false },
            ].map(({ icon: Icon, label, active }) => (
              <div key={label} className={`relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium ${active ? "bg-white/[0.08] text-white" : "text-slate-400"}`}>
                {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-action" />}
                <Icon className="h-[18px] w-[18px]" />
                {label}
              </div>
            ))}
          </div>
        </Section>

        {/* EMPTY STATE */}
        <Section title="Estado vacío" subtitle="Ícono + título + copy + acción, no un texto gris suelto.">
          <Card>
            <EmptyState
              icon={FileText}
              title="Todavía no hay documentos"
              description="Subí documentos para que el asistente los use en sus respuestas. PDF, DOCX, TXT o HTML."
              action={<Button size="sm"><Upload className="h-4 w-4 mr-1.5" /> Subir documento</Button>}
            />
          </Card>
        </Section>

        {/* ELEVACIÓN */}
        <Section title="Elevación y radios" subtitle="Sombras suaves con presencia; radios generosos.">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { c: "shadow-xs", l: "xs" },
              { c: "shadow-sm", l: "sm" },
              { c: "shadow-md", l: "md" },
              { c: "shadow-lg", l: "lg" },
            ].map(({ c, l }) => (
              <div key={l} className={`h-24 rounded-2xl bg-card border flex items-center justify-center text-sm text-muted-foreground ${c}`}>
                {l}
              </div>
            ))}
          </div>
        </Section>

        <footer className="border-t pt-6 pb-10">
          <p className="text-sm text-muted-foreground">
            Si aprobás este sistema, lo aplico sección por sección manteniendo consistencia total. Si querés cambiar el
            acento, la fuente o el tono del shell, lo ajusto acá primero.
          </p>
        </footer>
      </div>
    </div>
  );
}
