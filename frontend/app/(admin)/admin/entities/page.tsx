"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  User, Building2, Briefcase, Clock, Globe, Calendar,
  MapPin, Tag, Search, X, ChevronRight, FileText, ChevronDown,
  Pencil, Trash2, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, type EntitySummary, type EntityStats, type EntityLabel } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { PageShell } from "@/components/layout/page-shell";
import { PageHeader } from "@/components/layout/page-header";

// Resalta el nombre de la entidad dentro del texto del chunk (case-insensitive).
// Usa <mark> nativo del browser que ya viene con un styling visible.
function highlightEntity(text: string, name: string): React.ReactNode[] {
  if (!name) return [text];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(re);
  return parts.map((p, i) =>
    re.test(p) ? <mark key={i} className="bg-amber-200 text-amber-900 rounded px-0.5">{p}</mark> : p,
  );
}

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
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Trackear qué docs están expandidos para mostrar el texto de sus chunks
  const [expandedDocs, setExpandedDocs] = useState<Record<string, boolean>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["entity-detail", entity?.label, entity?.nombre],
    queryFn: () => api.entities.detail(entity!.label, entity!.nombre),
    enabled: open && !!entity,
  });

  const deleteM = useMutation({
    mutationFn: () => api.entities.remove(entity!.label, entity!.nombre),
    onSuccess: () => {
      toast({ title: "Entidad eliminada", variant: "success" });
      qc.invalidateQueries({ queryKey: ["entities"] });
      qc.invalidateQueries({ queryKey: ["entity-stats"] });
      onClose();
    },
    onError: (err: any) => {
      const d = err?.response?.data?.detail || "No se pudo eliminar.";
      toast({ title: "Error", description: typeof d === "string" ? d : "Intentá de nuevo.", variant: "destructive" });
    },
  });

  if (!entity) return null;
  const cfg = getLabelConfig(entity.label);

  // Agrupar chunks por documento; ahora cada chunk lleva su `text`.
  const byDoc: Record<string, { filename: string | null; chunks: { chunk_id: string; text: string | null }[] }> = {};
  if (data) {
    for (const c of data.chunks) {
      if (!byDoc[c.doc_id]) byDoc[c.doc_id] = { filename: c.doc_filename, chunks: [] };
      byDoc[c.doc_id].chunks.push({ chunk_id: c.chunk_id, text: c.text });
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <DialogTitle className="truncate">{entity.nombre}</DialogTitle>
                <DialogDescription>
                  {cfg.label} · {entity.mention_count} {entity.mention_count === 1 ? "mención" : "menciones"}
                </DialogDescription>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm" variant="outline"
                  onClick={() => setEditOpen(true)}
                  className="h-8"
                >
                  <Pencil className="h-3.5 w-3.5 mr-1.5" />
                  Editar
                </Button>
                <Button
                  size="sm" variant="outline"
                  onClick={() => setConfirmDelete(true)}
                  className="h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  Eliminar
                </Button>
              </div>
            </div>
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

            {!isLoading && data && Object.entries(byDoc).map(([docId, info]) => {
              const isOpen = !!expandedDocs[docId];
              return (
                <div key={docId} className="rounded-md border bg-card">
                  <button
                    onClick={() => setExpandedDocs(prev => ({ ...prev, [docId]: !prev[docId] }))}
                    className="w-full flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted/40 transition-colors text-left"
                  >
                    <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        {info.filename ?? docId.slice(0, 8) + "…"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {info.chunks.length} {info.chunks.length === 1 ? "fragmento" : "fragmentos"}
                      </p>
                    </div>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 text-muted-foreground transition-transform mt-1",
                        isOpen && "rotate-180",
                      )}
                    />
                  </button>
                  {isOpen && (
                    <div className="border-t bg-muted/20 px-3 py-2 space-y-2">
                      {info.chunks.map((c, idx) => (
                        <div key={c.chunk_id} className="text-xs leading-relaxed">
                          {info.chunks.length > 1 && (
                            <p className="text-[10px] font-semibold text-muted-foreground/80 mb-1 uppercase tracking-wide">
                              Fragmento {idx + 1}
                            </p>
                          )}
                          {c.text ? (
                            <p className="text-foreground/90 whitespace-pre-wrap break-words">
                              {highlightEntity(c.text, entity.nombre)}
                            </p>
                          ) : (
                            <p className="text-muted-foreground italic">
                              (Texto no disponible — chunk solo en Neo4j)
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      <EntityEditDialog
        entity={entity}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          // Después de editar, cerrar todo y refrescar
          setEditOpen(false);
          onClose();
        }}
      />

      <Dialog open={confirmDelete} onOpenChange={(v) => !deleteM.isPending && !v && setConfirmDelete(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Eliminar entidad</DialogTitle>
            <DialogDescription>
              ¿Eliminar <span className="font-semibold">"{entity.nombre}"</span> ({cfg.label}) del grafo?
              Los documentos quedan intactos — solo se desvincula la entidad. No se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} disabled={deleteM.isPending}>
              Cancelar
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => deleteM.mutate()}
              disabled={deleteM.isPending}
            >
              {deleteM.isPending ? (
                <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Eliminando…</>
              ) : "Eliminar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Edit entity dialog ─────────────────────────────────────────────────────────

const EDITABLE_LABELS: EntityLabel[] = [
  "Persona", "Rol", "Departamento", "Horario", "Dominio",
  "Organizacion", "Fecha", "Lugar", "Entidad",
];

function EntityEditDialog({
  entity,
  open,
  onClose,
  onSaved,
}: {
  entity: EntitySummary;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [nombre, setNombre] = useState(entity.nombre);
  const [label, setLabel] = useState<EntityLabel>(entity.label as EntityLabel);

  useEffect(() => {
    if (open) {
      setNombre(entity.nombre);
      setLabel(entity.label as EntityLabel);
    }
  }, [open, entity]);

  const saveM = useMutation({
    mutationFn: () => {
      const changes: { new_nombre?: string; new_label?: EntityLabel } = {};
      if (nombre.trim() !== entity.nombre) changes.new_nombre = nombre.trim();
      if (label !== entity.label) changes.new_label = label;
      return api.entities.update(entity.label, entity.nombre, changes);
    },
    onSuccess: () => {
      toast({ title: "Entidad actualizada", variant: "success" });
      qc.invalidateQueries({ queryKey: ["entities"] });
      qc.invalidateQueries({ queryKey: ["entity-stats"] });
      qc.invalidateQueries({ queryKey: ["entity-detail"] });
      onSaved();
    },
    onError: (err: any) => {
      const d = err?.response?.data?.detail || "No se pudo guardar.";
      toast({ title: "Error", description: typeof d === "string" ? d : "Intentá de nuevo.", variant: "destructive" });
    },
  });

  const dirty = nombre.trim() !== entity.nombre || label !== entity.label;
  const valid = nombre.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !saveM.isPending && !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar entidad</DialogTitle>
          <DialogDescription>
            Corregí el nombre o el tipo si GLiNER lo detectó mal. Las menciones
            en documentos se conservan.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <label className="text-xs font-medium">Nombre</label>
            <Input
              value={nombre}
              onChange={e => setNombre(e.target.value)}
              disabled={saveM.isPending}
              maxLength={200}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">Tipo</label>
            <div className="grid grid-cols-3 gap-1.5">
              {EDITABLE_LABELS.map(l => {
                const cfg = getLabelConfig(l);
                const Icon = cfg.icon;
                const active = label === l;
                return (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLabel(l)}
                    disabled={saveM.isPending}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-xs transition-colors",
                      active
                        ? "border-primary bg-primary/5 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="h-3 w-3 shrink-0" />
                    <span className="truncate">{cfg.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saveM.isPending}>
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={() => saveM.mutate()}
            disabled={!dirty || !valid || saveM.isPending}
          >
            {saveM.isPending ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Guardando…</>
            ) : "Guardar cambios"}
          </Button>
        </DialogFooter>
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
