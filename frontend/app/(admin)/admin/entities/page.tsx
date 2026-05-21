"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  User, Building2, Briefcase, Clock, Globe, Calendar,
  MapPin, Tag, Search, X, ChevronRight, FileText, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, type EntitySummary, type EntityStats } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

// ── Label config ───────────────────────────────────────────────────────────────

const LABEL_CONFIG: Record<string, { icon: React.ElementType; label: string }> = {
  Persona:       { icon: User,      label: "Persona"       },
  Rol:           { icon: Briefcase, label: "Rol"           },
  Departamento:  { icon: Building2, label: "Departamento"  },
  Organizacion:  { icon: Building2, label: "Organización"  },
  Horario:       { icon: Clock,     label: "Horario"       },
  Fecha:         { icon: Calendar,  label: "Fecha"         },
  Lugar:         { icon: MapPin,    label: "Lugar"         },
  Dominio:       { icon: Globe,     label: "Dominio"       },
  Entidad:       { icon: Tag,       label: "Entidad"       },
};

function getLabelConfig(label: string) {
  return LABEL_CONFIG[label] ?? LABEL_CONFIG["Entidad"];
}

// ── Filter chip ────────────────────────────────────────────────────────────────

function FilterChip({
  label, count, active, onClick, icon: Icon,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  icon?: React.ElementType;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 h-8 px-3 rounded-md border text-xs font-medium transition-colors",
        active
          ? "bg-brand text-brand-foreground border-brand"
          : "bg-background border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
      )}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {label}
      <span
        className={cn(
          "ml-0.5 inline-flex items-center justify-center min-w-4 h-4 px-1 rounded text-[10px] font-semibold tabular-nums",
          active ? "bg-brand-foreground/20" : "bg-muted text-foreground/70"
        )}
      >
        {count}
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
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-muted/50 transition-colors text-left group"
    >
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{entity.nombre}</p>
        <p className="text-xs text-muted-foreground">{cfg.label}</p>
      </div>
      <Badge variant="secondary" className="text-xs shrink-0 font-normal">
        {entity.mention_count} {entity.mention_count === 1 ? "mención" : "menciones"}
      </Badge>
      <ChevronRight className="h-4 w-4 text-muted-foreground/60 group-hover:text-foreground shrink-0" />
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
          <DialogTitle>{entity.nombre}</DialogTitle>
          <DialogDescription>
            {cfg.label} · {entity.mention_count} {entity.mention_count === 1 ? "mención" : "menciones"}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Aparece en</p>

          {isLoading && (
            <div className="space-y-2">
              {[1, 2].map(i => <Skeleton key={i} className="h-14 w-full rounded-md" />)}
            </div>
          )}

          {!isLoading && data && Object.entries(byDoc).length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">Sin resultados</p>
          )}

          {!isLoading && data && Object.entries(byDoc).map(([docId, info]) => (
            <div key={docId} className="flex items-start gap-2.5 rounded-md border bg-card px-3 py-2.5">
              <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {info.filename ?? docId.slice(0, 8) + "…"}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {info.chunks.length} {info.chunks.length === 1 ? "fragmento" : "fragmentos"}
                </p>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 30;

export default function EntitiesPage() {
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<EntitySummary | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Resetear "ventana visible" al cambiar filtro o búsqueda — sino el usuario
  // entra a "Personas" y ve la pagina anterior con las entidades de "Roles".
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [activeLabel, search]);

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["entity-stats"],
    queryFn: api.entities.stats,
    staleTime: 60_000,
  });

  const { data: entities, isLoading: listLoading } = useQuery({
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
        description="Personas, áreas y conceptos extraídos automáticamente de tus documentos."
      />

      {/* Filtros */}
      <div className="flex flex-wrap gap-1.5">
        <FilterChip
          label="Todas"
          count={statsLoading ? 0 : totalEntities}
          active={activeLabel === null}
          onClick={() => setActiveLabel(null)}
        />
        {statsLoading && [1, 2, 3].map(i => (
          <Skeleton key={i} className="h-8 w-24 rounded-md" />
        ))}
        {stats?.map((s: EntityStats) => {
          const cfg = getLabelConfig(s.label);
          return (
            <FilterChip
              key={s.label}
              label={cfg.label}
              count={s.count}
              icon={cfg.icon}
              active={activeLabel === s.label}
              onClick={() => setActiveLabel(prev => prev === s.label ? null : s.label)}
            />
          );
        })}
      </div>

      {/* Lista de entidades */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-4">
            <CardTitle className="text-base">
              Entidades ({listLoading ? "…" : entities?.length ?? 0})
            </CardTitle>
            <div className="relative max-w-xs">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8 pr-8 h-8 text-sm"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-2">
          {listLoading && (
            <div className="space-y-1 p-1">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full rounded-md" />)}
            </div>
          )}

          {!listLoading && (!entities || entities.length === 0) && (
            <p className="text-sm text-muted-foreground text-center py-8">
              {search
                ? `Sin resultados para "${search}".`
                : "Todavía no hay entidades. Ingresá documentos para empezar."}
            </p>
          )}

          {!listLoading && entities && entities.length > 0 && (
            <>
              <div className="space-y-0.5">
                {entities.slice(0, visibleCount).map(e => (
                  <EntityRow
                    key={`${e.label}-${e.nombre}`}
                    entity={e}
                    onClick={() => openDetail(e)}
                  />
                ))}
              </div>

              {entities.length > visibleCount && (
                <div className="flex items-center justify-between gap-3 px-2 pt-3 mt-2 border-t">
                  <p className="text-xs text-muted-foreground">
                    Mostrando <span className="font-medium text-foreground">{visibleCount}</span> de{" "}
                    <span className="font-medium text-foreground">{entities.length}</span>
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
                  >
                    <ChevronDown className="h-3.5 w-3.5 mr-1.5" />
                    Cargar {Math.min(PAGE_SIZE, entities.length - visibleCount)} más
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <EntityDetailDialog
        entity={selected}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
    </PageShell>
  );
}
