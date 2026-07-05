import { createClient } from '@supabase/supabase-js';

// Las credenciales se leen desde variables de entorno cuando están disponibles.
// El anon key es público por diseño en Supabase — la seguridad real la proveen
// las funciones SECURITY DEFINER y las políticas RLS configuradas en el servidor,
// no el hecho de ocultar este key.
// En Vercel/producción: configura VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY
// en Settings → Environment Variables para sobreescribir estos valores.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
  || "https://yxsagdndsjontidgpyiv.supabase.co";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
  || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl4c2FnZG5kc2pvbnRpZGdweWl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxMzEyMDUsImV4cCI6MjA5ODcwNzIwNX0.1NRImBGfupZ0hxWg90NOlzEipvtuXWHXfAwKnFTB1YQ";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const toCamel = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(toCamel);
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      toCamel(v),
    ])
  );
};

const toSnake = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(toSnake);
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k.replace(/([A-Z])/g, '_$1').toLowerCase(),
      v,
    ])
  );
};

// Trae TODOS los registros de una tabla superando el límite de 1000 de Supabase.
// Pagina automáticamente hasta obtener el total completo.
async function fetchAll(query, pageSize = 1000) {
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await query(from, from + pageSize - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// Sanitiza el término de búsqueda para consultas ILIKE dentro de .or():
// elimina caracteres que romperían el patrón o la sintaxis del filtro.
const san = (q) => String(q || '').replace(/[%_,()]/g, ' ').trim();

// Mapea una fila cruda de fk_facturas al formato de la app, con trim defensivo.
const trf = (v) => (typeof v === 'string' ? v.trim() : v);
const mapFactura = (r) => ({
  id: r.id,
  codCliente: trf(r.cod_cliente), nombreCliente: trf(r.nombre_cliente),
  noFactura: trf(r.no_factura), codMaterial: trf(r.cod_material),
  nombre: trf(r.nombre_material), lote: trf(r.lote),
  cantidad: r.cantidad, valor: r.valor,
  vendedor: trf(r.vendedor), facturador: trf(r.facturador),
});

// Mapea una fila cruda de fk_notas (snake_case) al formato de la app (camelCase).
const mapNota = (r) => ({
  id:               r.id,
  ndv:              r.ndv,
  asignadoA:        r.asignado_a,
  rrvvNombre:       r.rrvv_nombre,
  creadoPor:        r.creado_por,
  creadoPorNombre:  r.creado_por_nombre,
  estado:           r.estado,
  motivoRechazo:    r.motivo_rechazo,
  tipoProducto:     r.tipo_producto || 'normal',
  ciudad:           r.ciudad || 'guayaquil',
  form:             r.form,
  modActual:        r.mod_actual,
  registroFinal:    r.registro_final,
  historial:        r.historial,
});

export const db = {
  // ── AUTENTICACIÓN ─────────────────────────────────────────────────────────
  // El login y el cambio de contraseña se ejecutan DENTRO de la base de datos
  // (funciones SECURITY DEFINER con bcrypt). Las contraseñas y sus hashes
  // nunca viajan al navegador.
  auth: {
    // Devuelve el usuario (sin hash) si usuario+contraseña+activo son válidos; null si no.
    async login(username, password) {
      const { data, error } = await supabase.rpc('fn_login', { p_username: username, p_password: password });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      return {
        id: row.id, username: row.username, role: row.role, name: row.name,
        email: row.email, active: row.active, mustChangePassword: row.must_change_password,
      };
    },
    // Cambio de contraseña por el propio usuario (exige la contraseña actual).
    async changePassword(username, oldPassword, newPassword) {
      const { data, error } = await supabase.rpc('fn_change_password', {
        p_username: username, p_old: oldPassword, p_new: newPassword,
      });
      if (error) throw error;
      return data === true;
    },
  },

  users: {
    // Lista desde la vista pública: NUNCA incluye contraseñas ni hashes.
    async list() {
      const data = await fetchAll((f,t) => supabase.from('fk_users_public').select('*').order('id').range(f,t));
      return (data || []).map(r => ({
        id: r.id, username: r.username, role: r.role, name: r.name,
        email: r.email, active: r.active, mustChangePassword: r.must_change_password,
      }));
    },
    // Crear usuario (solo admin): asigna clave inicial; el usuario deberá cambiarla al ingresar.
    async create(adminCreds, { username, password, role, name, email }) {
      const { data, error } = await supabase.rpc('fn_admin_create_user', {
        p_admin_user: adminCreds.username, p_admin_pass: adminCreds.password,
        p_username: username, p_password: password, p_role: role, p_name: name, p_email: email,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return {
        id: row.id, username: row.username, role: row.role, name: row.name,
        email: row.email, active: row.active, mustChangePassword: row.must_change_password,
      };
    },
    // Resetear contraseña (solo admin): asigna una temporal sin poder ver la anterior.
    async resetPassword(adminCreds, targetId, newPassword) {
      const { data, error } = await supabase.rpc('fn_admin_reset_password', {
        p_admin_user: adminCreds.username, p_admin_pass: adminCreds.password,
        p_target_id: targetId, p_new_password: newPassword,
      });
      if (error) throw error;
      return data === true;
    },
    // Activar/desactivar acceso (solo admin).
    async setActive(adminCreds, targetId, active) {
      const { data, error } = await supabase.rpc('fn_admin_set_active', {
        p_admin_user: adminCreds.username, p_admin_pass: adminCreds.password,
        p_target_id: targetId, p_active: active,
      });
      if (error) throw error;
      return data === true;
    },
    // Editar nombre/correo/rol (solo admin). Nunca la contraseña.
    async adminUpdate(adminCreds, targetId, { name, email, role }) {
      const { data, error } = await supabase.rpc('fn_admin_update_user', {
        p_admin_user: adminCreds.username, p_admin_pass: adminCreds.password,
        p_target_id: targetId, p_name: name, p_email: email, p_role: role,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return {
        id: row.id, username: row.username, role: row.role, name: row.name,
        email: row.email, active: row.active, mustChangePassword: row.must_change_password,
      };
    },
    // Eliminar usuario permanentemente (solo admin). No se puede eliminar la propia cuenta.
    async deleteUser(adminCreds, targetId) {
      const { data, error } = await supabase.rpc('fn_admin_delete_user', {
        p_admin_user: adminCreds.username, p_admin_pass: adminCreds.password,
        p_target_id: targetId,
      });
      if (error) throw error;
      return data === true;
    },
  },

  motivos: {
    async list() {
      const data = await fetchAll((f,t) => supabase.from('fk_motivos').select('*').order('codigo').range(f,t));
      const tr=(v)=> typeof v==="string" ? v.trim() : v;
      return toCamel(data).map(r => ({ ...r, codigo: tr(r.codigo), descripcion: tr(r.descripcion) }));
    },
    // Página para la pantalla de Maestros (motivos es pequeño, pero se usa la
    // misma mecánica por consistencia).
    async page({ page = 0, pageSize = 50, q = '' } = {}) {
      let query = supabase.from('fk_motivos').select('*', { count: 'exact' });
      const s = san(q);
      if (s) query = query.or(`codigo.ilike.%${s}%,descripcion.ilike.%${s}%`);
      const from = page * pageSize;
      const { data, count, error } = await query.order('codigo').range(from, from + pageSize - 1);
      if (error) throw error;
      const tr=(v)=> typeof v==="string" ? v.trim() : v;
      return { rows: (data || []).map(r => ({ id:r.id, codigo:tr(r.codigo), descripcion:tr(r.descripcion) })), total: count || 0 };
    },
    async insert(row) {
      const { data, error } = await supabase.from('fk_motivos').upsert(toSnake(row), { onConflict: 'codigo' }).select().single();
      if (error) throw error;
      return toCamel(data);
    },
    async insertMany(rows) {
      const { data, error } = await supabase.from('fk_motivos').upsert(rows.map(toSnake), { onConflict: 'codigo' }).select('id');
      if (error) throw error;
      return data || [];
    },
    async update(id, patch) {
      const { data, error } = await supabase.from('fk_motivos').update(toSnake(patch)).eq('id', id).select().single();
      if (error) throw error;
      return toCamel(data);
    },
    async delete(id) {
      const { error } = await supabase.from('fk_motivos').delete().eq('id', id);
      if (error) throw error;
    },
    async deleteAll() {
      const { error } = await supabase.from('fk_motivos').delete().neq('id', 0);
      if (error) throw error;
    },
  },

  plotes: {
    // Fecha de caducidad de un lote específico — consulta puntual, indexada.
    // Tolerante a espacios invisibles: trae los lotes del código y compara
    // con trim en el cliente (datos antiguos pueden tener espacios residuales).
    async fechaCad(codigo, lote) {
      const t=(v)=>String(v||'').trim();
      let { data, error } = await supabase.from('fk_plotes')
        .select('lote,fecha_cad')
        .eq('codigo', t(codigo))
        .limit(200);
      if (error) throw error;
      // Fallback: si el código guardado en plotes tiene espacios, el eq exacto
      // no encuentra nada — reintenta con búsqueda parcial y filtra con trim.
      if (!data || data.length === 0) {
        const s = san(codigo);
        if (s) {
          const r2 = await supabase.from('fk_plotes')
            .select('codigo,lote,fecha_cad')
            .ilike('codigo', `%${s}%`)
            .limit(200);
          if (r2.error) throw r2.error;
          data = (r2.data || []).filter(r => t(r.codigo) === t(codigo));
        }
      }
      const row = (data || []).find(r => t(r.lote) === t(lote));
      return row ? row.fecha_cad : "";
    },
    // Página para la pantalla de Maestros.
    async page({ page = 0, pageSize = 50, q = '' } = {}) {
      let query = supabase.from('fk_plotes').select('*', { count: 'estimated' });
      const s = san(q);
      if (s) query = query.or(`codigo.ilike.%${s}%,lote.ilike.%${s}%,nombre.ilike.%${s}%`);
      const from = page * pageSize;
      const { data, count, error } = await query.order('id', { ascending: false }).range(from, from + pageSize - 1);
      if (error) throw error;
      const tr=(v)=> typeof v==="string" ? v.trim() : v;
      return {
        rows: (data || []).map(r => ({ id:r.id, lote:tr(r.lote), codigo:tr(r.codigo), nombre:tr(r.nombre), fechaCad:r.fecha_cad, tempAlm:tr(r.temp_alm) })),
        total: count || 0,
      };
    },
    // UPSERT por lote+codigo: recargas regulares sin duplicados.
    async insertMany(rows) {
      const recs = rows.map(r => ({ lote: String(r.lote||"").trim(), codigo: String(r.codigo||"").trim(), nombre: String(r.nombre||"").trim(), fecha_cad: r.fechaCad, temp_alm: String(r.tempAlm||"").trim() }));
      const { data, error } = await supabase.from('fk_plotes')
        .upsert(recs, { onConflict: 'lote,codigo' })
        .select('id');
      if (error) throw error;
      return data || [];
    },
    async insert(row) {
      const rec = { lote: String(row.lote||"").trim(), codigo: String(row.codigo||"").trim(), nombre: String(row.nombre||"").trim(), fecha_cad: row.fechaCad, temp_alm: String(row.tempAlm||"").trim() };
      const { data, error } = await supabase.from('fk_plotes').upsert(rec, { onConflict: 'lote,codigo' }).select().single();
      if (error) throw error;
      return toCamel(data);
    },
    async update(id, row) {
      const rec = { lote: String(row.lote||"").trim(), codigo: String(row.codigo||"").trim(), nombre: String(row.nombre||"").trim(), fecha_cad: row.fechaCad, temp_alm: String(row.tempAlm||"").trim() };
      const { data, error } = await supabase.from('fk_plotes').update(rec).eq('id', id).select().single();
      if (error) throw error;
      return toCamel(data);
    },
    async delete(id) {
      const { error } = await supabase.from('fk_plotes').delete().eq('id', id);
      if (error) throw error;
    },
    async deleteAll() {
      const { error } = await supabase.from('fk_plotes').delete().neq('id', 0);
      if (error) throw error;
    },
  },

  clientes: {
    // Búsqueda de clientes en el SERVIDOR sobre la tabla derivada fk_clientes
    // (pequeña y con índices trigram) — nunca se descarga el maestro completo.
    async search(q) {
      let query = supabase.from('fk_clientes').select('cod,nombre').order('nombre').limit(15);
      const s = san(q);
      if (s) query = query.or(`cod.ilike.%${s}%,nombre.ilike.%${s}%`);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).map(r => ({ cod: trf(r.cod), label: trf(r.nombre) || trf(r.cod) }));
    },
  },

  facturas: {
    // ── Consultas puntuales para la cascada del formulario ──────────────────
    // Productos vendidos al cliente que coinciden con lo escrito (máx. 15).
    async searchProductos(codCliente, q) {
      let query = supabase.from('fk_facturas')
        .select('cod_material,nombre_material')
        .eq('cod_cliente', codCliente)
        .limit(200);
      const s = san(q);
      if (s) query = query.or(`cod_material.ilike.%${s}%,nombre_material.ilike.%${s}%`);
      const { data, error } = await query;
      if (error) throw error;
      const m = new Map();
      (data || []).forEach(r => { const c = trf(r.cod_material); if (c && !m.has(c)) m.set(c, trf(r.nombre_material)); });
      return [...m.entries()].slice(0, 15).map(([cod, label]) => ({ cod, label: label || cod }));
    },
    // Lotes del cliente para un material (deduplicados).
    async lotes(codCliente, codMaterial) {
      const { data, error } = await supabase.from('fk_facturas')
        .select('lote')
        .eq('cod_cliente', codCliente).eq('cod_material', codMaterial)
        .not('lote', 'is', null)
        .limit(500);
      if (error) throw error;
      return [...new Set((data || []).map(r => trf(r.lote)).filter(Boolean))].sort();
    },
    // Facturas del cliente para material+lote, con su vendedor.
    async facturasDe(codCliente, codMaterial, lote) {
      let query = supabase.from('fk_facturas')
        .select('no_factura,vendedor')
        .eq('cod_cliente', codCliente).eq('cod_material', codMaterial)
        .limit(500);
      if (lote) query = query.eq('lote', lote);
      const { data, error } = await query;
      if (error) throw error;
      const m = new Map();
      (data || []).forEach(r => { const f = trf(r.no_factura); if (f && !m.has(f)) m.set(f, trf(r.vendedor) || ''); });
      return [...m.entries()].map(([noFactura, vendedor]) => ({ noFactura, vendedor }));
    },
    // Conteo rápido de líneas de factura del cliente (índice + head:true, no trae datos).
    async countByCliente(codCliente) {
      const { count, error } = await supabase.from('fk_facturas')
        .select('id', { count: 'exact', head: true })
        .eq('cod_cliente', codCliente);
      if (error) throw error;
      return count || 0;
    },
    // ── Página para la pantalla de Maestros (búsqueda en servidor) ───────────
    async page({ page = 0, pageSize = 50, q = '' } = {}) {
      let query = supabase.from('fk_facturas').select('*', { count: 'estimated' });
      const s = san(q);
      if (s) query = query.or(`cod_cliente.ilike.%${s}%,nombre_cliente.ilike.%${s}%,no_factura.ilike.%${s}%,cod_material.ilike.%${s}%,nombre_material.ilike.%${s}%`);
      const from = page * pageSize;
      const { data, count, error } = await query.order('id', { ascending: false }).range(from, from + pageSize - 1);
      if (error) throw error;
      return { rows: (data || []).map(mapFactura), total: count || 0 };
    },
    // ── Escritura ────────────────────────────────────────────────────────────
    // UPSERT por clave natural: recargas regulares sin duplicados — si la fila
    // ya existe se actualiza, si no se inserta. La deduplicación la hace la BASE
    // (índice único), no el navegador.
    async insertMany(rows) {
      const recs = rows.map(r => ({
        cod_cliente: String(r.codCliente||"").trim(), nombre_cliente: String(r.nombreCliente||"").trim(),
        no_factura: String(r.noFactura||"").trim(), cod_material: String(r.codMaterial||"").trim(),
        nombre_material: String(r.nombre||"").trim(), lote: String(r.lote||"").trim(),
        cantidad: r.cantidad, valor: r.valor,
        vendedor: String(r.vendedor||"").trim(), facturador: String(r.facturador||"").trim(),
      }));
      const { data, error } = await supabase.from('fk_facturas')
        .upsert(recs, { onConflict: 'no_factura,cod_cliente,cod_material,lote' })
        .select('id');
      if (error) throw error;
      return data || [];
    },
    async insert(row) {
      const rec = {
        cod_cliente: String(row.codCliente||"").trim(), nombre_cliente: String(row.nombreCliente||"").trim(),
        no_factura: String(row.noFactura||"").trim(), cod_material: String(row.codMaterial||"").trim(),
        nombre_material: String(row.nombre||"").trim(), lote: String(row.lote||"").trim(),
        cantidad: row.cantidad, valor: row.valor,
        vendedor: String(row.vendedor||"").trim(), facturador: String(row.facturador||"").trim(),
      };
      const { data, error } = await supabase.from('fk_facturas')
        .upsert(rec, { onConflict: 'no_factura,cod_cliente,cod_material,lote' })
        .select().single();
      if (error) throw error;
      return mapFactura(data);
    },
    async update(id, row) {
      const rec = {
        cod_cliente: String(row.codCliente||"").trim(), nombre_cliente: String(row.nombreCliente||"").trim(),
        no_factura: String(row.noFactura||"").trim(), cod_material: String(row.codMaterial||"").trim(),
        nombre_material: String(row.nombre||"").trim(), lote: String(row.lote||"").trim(),
        cantidad: row.cantidad, valor: row.valor,
        vendedor: String(row.vendedor||"").trim(), facturador: String(row.facturador||"").trim(),
      };
      const { data, error } = await supabase.from('fk_facturas').update(rec).eq('id', id).select().single();
      if (error) throw error;
      return mapFactura(data);
    },
    async delete(id) {
      const { error } = await supabase.from('fk_facturas').delete().eq('id', id);
      if (error) throw error;
    },
    async deleteAll() {
      const { error } = await supabase.from('fk_facturas').delete().neq('id', 0);
      if (error) throw error;
    },
  },

  notas: {
    async list() {
      const data = await fetchAll((f,t) => supabase.from('fk_notas').select('*').order('id', { ascending: false }).range(f,t));
      return (data || []).map(mapNota);
    },
    // Trae UNA nota fresca desde la base — usada al abrir el detalle para no
    // actuar sobre datos viejos cuando varios usuarios trabajan a la vez.
    async get(id) {
      const { data, error } = await supabase.from('fk_notas').select('*').eq('id', id).single();
      if (error) throw error;
      return mapNota(data);
    },
    async insert(nota) {
      // Elige la secuencia según el tipo de producto:
      //  normal     → next_ndv()            → 'NDV-00000X'
      //  controlado → next_ndv_controlado() → 'C-00000X'
      const rpcName = nota.tipoProducto === 'controlado' ? 'next_ndv_controlado' : 'next_ndv';
      const { data: ndvData, error: ndvError } = await supabase.rpc(rpcName);
      if (ndvError) throw ndvError;
      const ndv = ndvData;
      const rec = {
        ndv,
        asignado_a:        nota.asignadoA,
        rrvv_nombre:       nota.rrvvNombre,
        creado_por:        nota.creadoPor,
        creado_por_nombre: nota.creadoPorNombre,
        estado:            nota.estado || 'en_bodega',
        motivo_rechazo:    nota.motivoRechazo || null,
        tipo_producto:     nota.tipoProducto || 'normal',
        ciudad:            nota.ciudad || 'guayaquil',
        form:              nota.form,
        mod_actual:        nota.modActual || null,
        registro_final:    nota.registroFinal || null,
        historial:         nota.historial || [],
      };
      const { data, error } = await supabase.from('fk_notas').insert(rec).select().single();
      if (error) throw error;
      return { ...nota, id: data.id, ndv };
    },
    // BLOQUEO OPTIMISTA: si se pasa expectedEstado, la actualización solo se
    // aplica si la nota sigue en ese estado en la base. Si otro usuario ya la
    // movió, la base no actualiza ninguna fila y se lanza CONFLICT para que la
    // interfaz recargue y avise — así ninguna acción pisa el trabajo de otro.
    async update(id, patch, expectedEstado) {
      const rec = {};
      if (patch.estado          !== undefined) rec.estado           = patch.estado;
      if (patch.motivoRechazo   !== undefined) rec.motivo_rechazo   = patch.motivoRechazo;
      if (patch.modActual       !== undefined) rec.mod_actual        = patch.modActual;
      if (patch.registroFinal   !== undefined) rec.registro_final    = patch.registroFinal;
      if (patch.historial       !== undefined) rec.historial         = patch.historial;
      if (patch.form            !== undefined) rec.form              = patch.form;
      let q = supabase.from('fk_notas').update(rec).eq('id', id);
      if (expectedEstado !== undefined) q = q.eq('estado', expectedEstado);
      const { data, error } = await q.select('id');
      if (error) throw error;
      if (expectedEstado !== undefined && (!data || data.length === 0)) {
        throw new Error('CONFLICT');
      }
    },
  },
};
