"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Única fuente de los tipos de autenticación — la usan el alta y el detalle.
export const AUTH_TYPES = [
  { value: "none",    label: "Sin autenticación" },
  { value: "api_key", label: "API key" },
  { value: "bearer",  label: "Bearer token" },
  { value: "basic",   label: "Basic (usuario + contraseña)" },
  { value: "oauth2",  label: "OAuth2 (el token se renueva solo)" },
];

// Todo lo que el admin puede tipear para una credencial, con valor pelado por
// campo — el JSON de auth_config lo arma buildAuthConfigPatch, nunca el admin.
export type CredentialValues = {
  secret: string;      // password / bearer / api key / client_secret (cifrado)
  basicUser: string;   // basic: va en auth_config, no es secreto
  keyIn: string;       // api_key: "header" | "query"
  keyField: string;    // api_key: nombre del header o del query param
  oaTokenUrl: string;
  oaClientId: string;
  oaScopes: string;
  oaStyle: string;     // oauth2: "body" | "basic_header"
};

export const emptyCredentialValues: CredentialValues = {
  secret: "", basicUser: "", keyIn: "header", keyField: "",
  oaTokenUrl: "", oaClientId: "", oaScopes: "", oaStyle: "body",
};

// Estado inicial del editor a partir del auth_config guardado (el detalle lo
// usa para que "Cambiar" muestre lo que ya está configurado).
export function credentialValuesFromConfig(cfg: Record<string, unknown> | null | undefined): CredentialValues {
  const c = (cfg ?? {}) as Record<string, unknown>;
  const keyIn = String(c.in ?? "header");
  return {
    secret: "",
    basicUser: String(c.username ?? ""),
    keyIn,
    keyField: String((keyIn === "query" ? c.param : c.header) ?? ""),
    oaTokenUrl: String(c.token_url ?? ""),
    oaClientId: String(c.client_id ?? ""),
    oaScopes: String(c.scopes ?? ""),
    oaStyle: String(c.token_auth_style ?? "body"),
  };
}

export function credentialLabel(authType: string): string {
  return authType === "basic" ? "Contraseña"
    : authType === "bearer" ? "Bearer token"
    : authType === "oauth2" ? "Client Secret" : "API key";
}

// auth_config a persistir, mergeado sobre lo existente (preserva claves ajenas
// como identity_validation). null = este tipo no guarda config (bearer / none).
export function buildAuthConfigPatch(
  authType: string, v: CredentialValues, existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const cfg = (existing ?? {}) as Record<string, unknown>;
  if (authType === "basic") return { ...cfg, username: v.basicUser.trim() };
  if (authType === "api_key") {
    const field = v.keyField.trim();
    return {
      ...cfg, in: v.keyIn,
      ...(v.keyIn === "query" ? { param: field || "api_key" } : { header: field || "X-API-Key" }),
    };
  }
  if (authType === "oauth2") {
    return {
      ...cfg,
      token_url: v.oaTokenUrl.trim(),
      client_id: v.oaClientId.trim(),
      scopes: v.oaScopes.trim(),
      token_auth_style: v.oaStyle,
    };
  }
  return null;
}

// ¿Falta algo para poder guardar? Con secreto ya cargado (hasSecret) se puede
// re-guardar solo la config sin re-tipear la clave.
export function credentialIncomplete(authType: string, v: CredentialValues, hasSecret: boolean): boolean {
  const needsSecret = !hasSecret && !v.secret.trim();
  if (authType === "basic")   return !v.basicUser.trim() || needsSecret;
  if (authType === "api_key") return needsSecret;
  if (authType === "oauth2")  return !v.oaTokenUrl.trim() || !v.oaClientId.trim() || needsSecret;
  if (authType === "bearer")  return !v.secret.trim();
  return false;
}

// ¿El admin no tipeó nada todavía? El alta lo usa para permitir crear sin
// credencial ("la cargo después") pero exigirla completa si la empezó.
export function credentialEmpty(authType: string, v: CredentialValues): boolean {
  if (v.secret.trim()) return false;
  if (authType === "basic")   return !v.basicUser.trim();
  if (authType === "oauth2")  return !v.oaTokenUrl.trim() && !v.oaClientId.trim() && !v.oaScopes.trim();
  if (authType === "api_key") return !v.keyField.trim();
  return true;
}

// Campos de credencial según tipo de auth — controlado por el padre, que decide
// dónde y cuándo guardar. Mismo markup en el alta y en el detalle.
export function CredentialFields({ authType, values: v, onChange, hasSecret = false, autoFocus = false }: {
  authType: string;
  values: CredentialValues;
  onChange: (patch: Partial<CredentialValues>) => void;
  hasSecret?: boolean;
  autoFocus?: boolean;
}) {
  if (authType === "none") return null;
  const label = credentialLabel(authType);
  return (
    <div className="space-y-3">
      {authType === "basic" && (
        <div className="max-w-sm space-y-1.5">
          <Label className="text-xs">Usuario</Label>
          <Input
            autoFocus={autoFocus}
            placeholder="usuario del proveedor"
            value={v.basicUser}
            onChange={e => onChange({ basicUser: e.target.value })}
          />
        </div>
      )}
      {authType === "oauth2" && (
        <div className="space-y-3">
          <div className="max-w-sm space-y-1.5">
            <Label className="text-xs">URL del token</Label>
            <Input
              autoFocus={autoFocus}
              className="font-mono text-sm"
              placeholder="https://auth.proveedor.com/oauth/token"
              value={v.oaTokenUrl}
              onChange={e => onChange({ oaTokenUrl: e.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">Está en la doc del proveedor como &quot;token endpoint&quot;. El sistema pide y renueva los tokens solo.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="w-56 space-y-1.5">
              <Label className="text-xs">Client ID</Label>
              <Input className="font-mono text-sm" placeholder="client id del proveedor"
                     value={v.oaClientId} onChange={e => onChange({ oaClientId: e.target.value })} />
            </div>
            <div className="w-56 space-y-1.5">
              <Label className="text-xs">Scopes <span className="text-muted-foreground/60">(opcional)</span></Label>
              <Input className="font-mono text-sm" placeholder="read:datos"
                     value={v.oaScopes} onChange={e => onChange({ oaScopes: e.target.value })} />
              <p className="text-[11px] text-muted-foreground">Pedí solo lectura si el proveedor lo permite.</p>
            </div>
            <div className="w-56 space-y-1.5">
              <Label className="text-xs">¿Cómo van las credenciales?</Label>
              <Select value={v.oaStyle} onValueChange={val => onChange({ oaStyle: val })}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="body">En el cuerpo del pedido (lo común)</SelectItem>
                  <SelectItem value="basic_header">Header Basic (spec estricta)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}
      {authType === "api_key" && (
        <div className="flex flex-wrap gap-3">
          <div className="w-60 space-y-1.5">
            <Label className="text-xs">¿Dónde va la clave?</Label>
            <Select value={v.keyIn} onValueChange={val => onChange({ keyIn: val, keyField: "" })}>
              <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="header">En un header HTTP (lo más común)</SelectItem>
                <SelectItem value="query">En la URL, como parámetro</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-44 space-y-1.5">
            <Label className="text-xs">Nombre del campo</Label>
            <Input
              className="font-mono text-sm"
              placeholder={v.keyIn === "query" ? "api_key" : "X-API-Key"}
              value={v.keyField}
              onChange={e => onChange({ keyField: e.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">Como lo pide la doc del proveedor.</p>
          </div>
        </div>
      )}
      <div className="max-w-sm space-y-1.5">
        <Label className="text-xs">{label}</Label>
        <Input
          type="password"
          autoFocus={autoFocus && authType !== "basic" && authType !== "oauth2"}
          placeholder={hasSecret ? "•••••••• (reemplazar)" : label.toLowerCase()}
          value={v.secret}
          onChange={e => onChange({ secret: e.target.value })}
        />
        <p className="text-[11px] text-muted-foreground">Se guarda cifrada y nunca se vuelve a mostrar.</p>
      </div>
    </div>
  );
}
