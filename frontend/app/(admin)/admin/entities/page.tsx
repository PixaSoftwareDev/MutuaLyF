"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  User, Building2, Briefcase, Clock, Globe, Calendar,
  MapPin, Tag, Search, X, ChevronRight, FileText, RefreshCw, Loader2,
} from "lucide-react";
import { api, type EntitySummary, type EntityStats, type EntityDetail } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

// ── Label config ───────────────────────────────────────────────────────────────

// Four semantic families instead of nine colors. Keeps the page readable
// without turning it into a rainbow.
const FAMILY = {
  people:  { color: "text-slate-700", bg: "bg-slate-100" },
  org:     { color: "text-slate-700", bg: "bg-slate-100" },
  context: { color: "text-slate-700", bg: "bg-slate-100" },
  other:   { color: "text-slate-700", bg: "bg-slate-100" },
} as const;

const LABEL_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string; label: string }> = {
  Persona:       { icon: User,      label: "Persona",       ...FAMILY.people },
  Rol:           { icon: Briefcase, label: "Rol",           ...FAMILY.people },
  Departamento:  { icon: Building2, label: "Departamento",  ...FAMILY.org },
  Organizacion:  { icon: Building2, label: "Organización",  ...FAMILY.org },
  Horario:       { icon: Clock,     label: "Horario",       ...FAMILY.context },
  Fecha:         { icon: Calendar,  label: "Fecha",         ...FAMILY.context },
  Lugar:         { icon: MapPin,    label: "Lugar",         ...FAMILY.context },
  Dominio:       { icon: Globe,     label: "Dominio",       ...FAMILY.context },
  Entidad:       { icon: Tag,       label: "Entidad",       ...FAMILY.other },
};

const ALL_LABELS = Object.keys(LABEL_CONFIG);

function getLabelConfig(label: string) {
  return LABEL_CONFIG[label] ?? LABEL_CONFIG["Entidad"];
}

// ── Stat pill ──────────────────────────────────────────────────────────────────

function StatPill({ stat, active, onClick }: { stat: EntityStats; active: boolean; onClick: () => void }) {
  const cfg = getLabelConfig(stat.label);
  const Icon = cfg.icon;
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-full border text-sm font-medium transition-all ${
        active
          ? `${cfg.bg} ${cfg.color} border-current`
          : "bg-white border-gray-200 text-gray-600 hover:border-gray-300"
      }`}
    >
      <Icon className="w-4 h-4" />
      {cfg.label}
      <span className={`ml-1 px-1.5 py-0.5 rounded-full text-xs font-bold ${active ? cfg.color : "text-gray-500"} bg-white/60`}>
        {stat.count}
      </span>
    </button>
  );
}

// ── Entity row ─────────────────────────────────────────────────────────────────

function EntityRow({ entity, onClick }: { entity: EntitySummary; onClick: () => void }) {
  const cfg = getLabelConfig(entity.label);
  const Icon = cfg.icon;
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-200 transition-all text-left group"
    >
      <div className={`p-2 rounded-lg ${cfg.bg}`}>
        <Icon className={`w-4 h-4 ${cfg.color}`} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{entity.nombre}</p>
        <p className="text-xs text-gray-500">{cfg.label}</p>
      </div>
      <Badge variant="secondary" className="text-xs shrink-0">
        {entity.mention_count} {entity.mention_count === 1 ? "mención" : "menciones"}
      </Badge>
      <ChevronRight className="w-4 h-4 text-gray-400 group-hover:text-gray-600 shrink-0" />
    </button>
  );
}

// ── Detail dialog ──────────────────────────────────────────────────────────────

function EntityDetailDialog({
  entity,
  open,
  onClose,
}: {
  entity: EntitySummary | null;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["entity-detail", entity?.label, entity?.nombre],
    queryFn: () => api.entities.detail(entity!.label, entity!.nombre),
    enabled: open && !!entity,
  });

  if (!entity) return null;
  const cfg = getLabelConfig(entity.label);
  const Icon = cfg.icon;

  // Group chunks by document
  const byDoc: Record<string, { filename: string | null; chunks: string[] }> = {};
  if (data) {
    for (const c of data.chunks) {
      if (!byDoc[c.doc_id]) byDoc[c.doc_id] = { filename: c.doc_filename, chunks: [] };
      byDoc[c.doc_id].chunks.push(c.chunk_id);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-1">
            <div className={`p-2 rounded-lg ${cfg.bg}`}>
              <Icon className={`w-5 h-5 ${cfg.color}`} />
            </div>
            <div>
              <DialogTitle className="text-lg">{entity.nombre}</DialogTitle>
              <DialogDescription>{cfg.label} · {entity.mention_count} menciones</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="mt-2 space-y-3">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Aparece en estos documentos
          </p>

          {isLoading && (
            <div className="space-y-2">
              {[1, 2].map(i => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
            </div>
          )}

          {!isLoading && data && Object.entries(byDoc).length === 0 && (
            <p className="text-sm text-gray-500 py-4 text-center">Sin resultados</p>
          )}

          {!isLoading && data && Object.entries(byDoc).map(([docId, info]) => (
            <div key={docId} className="rounded-lg border border-gray-100 p-3">
              <div className="flex items-start gap-2">
                <FileText className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">
                    {info.filename ?? docId.slice(0, 8) + "…"}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {info.chunks.length} {info.chunks.length === 1 ? "fragmento" : "fragmentos"} con esta entidad
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function EntitiesPage() {
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<EntitySummary | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["entity-stats"],
    queryFn: api.entities.stats,
    staleTime: 60_000,
  });

  const { data: entities, isLoading: listLoading, refetch } = useQuery({
    queryKey: ["entities", activeLabel, search],
    queryFn: () => api.entities.list({
      label: activeLabel ?? undefined,
      search: search.trim() || undefined,
      limit: 200,
    }),
    staleTime: 30_000,
  });

  function openDetail(e: EntitySummary) {
    setSelected(e);
    setDetailOpen(true);
  }

  const totalEntities = stats?.reduce((s, x) => s + x.count, 0) ?? 0;

  return (
    <PageShell>
      <PageHeader
        title="Entidades"
        description="Personas, departamentos, roles y más extraídos automáticamente de tus documentos."
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Actualizar
          </Button>
        }
      />

      {/* Stats pills */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setActiveLabel(null)}
          className={`flex items-center gap-2 px-4 py-2 rounded-full border text-sm font-medium transition-all ${
            activeLabel === null
              ? "bg-gray-900 text-white border-gray-900"
              : "bg-white border-gray-200 text-gray-600 hover:border-gray-300"
          }`}
        >
          Todas
          <span className="ml-1 px-1.5 py-0.5 rounded-full text-xs font-bold bg-white/20">
            {statsLoading ? "…" : totalEntities}
          </span>
        </button>

        {statsLoading && [1, 2, 3].map(i => (
          <Skeleton key={i} className="h-9 w-28 rounded-full" />
        ))}

        {stats?.map(s => (
          <StatPill
            key={s.label}
            stat={s}
            active={activeLabel === s.label}
            onClick={() => setActiveLabel(prev => prev === s.label ? null : s.label)}
          />
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input
          placeholder="Buscar entidad por nombre…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-9 pr-9"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Entity list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {listLoading ? "Cargando…" : `${entities?.length ?? 0} entidades`}
          </CardTitle>
          {activeLabel && (
            <CardDescription>
              Filtrando por: <strong>{getLabelConfig(activeLabel).label}</strong>
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="p-2">
          {listLoading && (
            <div className="space-y-1 p-2">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
            </div>
          )}

          {!listLoading && (!entities || entities.length === 0) && (
            <div className="py-12 text-center text-gray-500">
              <Tag className="w-8 h-8 mx-auto mb-2 text-gray-300" />
              <p className="text-sm">
                {search
                  ? `Sin resultados para "${search}"`
                  : "No hay entidades extraídas todavía. Ingresá documentos para empezar."}
              </p>
            </div>
          )}

          {!listLoading && entities && entities.length > 0 && (
            <div className="space-y-0.5">
              {entities.map(e => (
                <EntityRow
                  key={`${e.label}-${e.nombre}`}
                  entity={e}
                  onClick={() => openDetail(e)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Info box */}
      <div className="rounded-lg bg-blue-50 border border-blue-100 p-4 text-sm text-blue-800">
        <strong>¿Cómo funciona?</strong> Al ingestar un documento, el sistema extrae automáticamente
        entidades usando GLiNER (modelo local de NER). Cuando alguien hace una consulta que menciona
        una persona, departamento u otra entidad, el sistema la busca en Neo4j para encontrar
        exactamente qué fragmentos la mencionan — y los incluye en el contexto aunque no aparezcan
        primero en la búsqueda semántica.
      </div>

      <EntityDetailDialog
        entity={selected}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
    </PageShell>
  );
}
