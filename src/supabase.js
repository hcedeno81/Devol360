import { createClient } from '@supabase/supabase-js';

const URL  = "https://yxsagdndsjontidgpyiv.supabase.co";
const KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl4c2FnZG5kc2pvbnRpZGdweWl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxMzEyMDUsImV4cCI6MjA5ODcwNzIwNX0.1NRImBGfupZ0hxWg90NOlzEipvtuXWHXfAwKnFTB1YQ";

export const supabase = createClient(URL, KEY);

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

export const db = {
  users: {
    async list() {
      const { data, error } = await supabase.from('fk_users').select('*').order('id');
      if (error) throw error;
      return toCamel(data);
    },
    async insert(user) {
      const { data, error } = await supabase.from('fk_users').insert(toSnake(user)).select().single();
      if (error) throw error;
      return toCamel(data);
    },
    async update(id, patch) {
      const { data, error } = await supabase.from('fk_users').update(toSnake(patch)).eq('id', id).select().single();
      if (error) throw error;
      return toCamel(data);
    },
  },

  invites: {
    async list() {
      const { data, error } = await supabase.from('fk_invites').select('*').order('id');
      if (error) throw error;
      return toCamel(data);
    },
    async insert(invite) {
      const { data, error } = await supabase.from('fk_invites').insert(toSnake(invite)).select().single();
      if (error) throw error;
      return toCamel(data);
    },
    async update(id, patch) {
      const { data, error } = await supabase.from('fk_invites').update(toSnake(patch)).eq('id', id).select().single();
      if (error) throw error;
      return toCamel(data);
    },
  },

  motivos: {
    async list() {
      const { data, error } = await supabase.from('fk_motivos').select('*').order('codigo');
      if (error) throw error;
      return toCamel(data);
    },
    async insert(row) {
      const { data, error } = await supabase.from('fk_motivos').insert(toSnake(row)).select().single();
      if (error) throw error;
      return toCamel(data);
    },
    async insertMany(rows) {
      const { data, error } = await supabase.from('fk_motivos').insert(rows.map(toSnake)).select();
      if (error) throw error;
      return toCamel(data);
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
    async list() {
      const { data, error } = await supabase.from('fk_plotes').select('*').order('codigo').order('lote');
      if (error) throw error;
      return (toCamel(data) || []).map(r => ({ ...r, fechaCad: r.fechaCad }));
    },
    async insert(row) {
      const rec = { lote: row.lote, codigo: row.codigo, nombre: row.nombre, fecha_cad: row.fechaCad, temp_alm: row.tempAlm };
      const { data, error } = await supabase.from('fk_plotes').insert(rec).select().single();
      if (error) throw error;
      return toCamel(data);
    },
    async insertMany(rows) {
      const recs = rows.map(r => ({ lote: r.lote, codigo: r.codigo, nombre: r.nombre, fecha_cad: r.fechaCad, temp_alm: r.tempAlm }));
      const { data, error } = await supabase.from('fk_plotes').insert(recs).select();
      if (error) throw error;
      return toCamel(data);
    },
    async update(id, row) {
      const rec = { lote: row.lote, codigo: row.codigo, nombre: row.nombre, fecha_cad: row.fechaCad, temp_alm: row.tempAlm };
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

  facturas: {
    async list() {
      const { data, error } = await supabase.from('fk_facturas').select('*').order('cod_cliente').order('no_factura');
      if (error) throw error;
      return (data || []).map(r => ({
        id:             r.id,
        codCliente:     r.cod_cliente,
        nombreCliente:  r.nombre_cliente,
        noFactura:      r.no_factura,
        codMaterial:    r.cod_material,
        nombre:         r.nombre_material,
        lote:           r.lote,
        cantidad:       r.cantidad,
        valor:          r.valor,
        vendedor:       r.vendedor,
        facturador:     r.facturador,
      }));
    },
    async insert(row) {
      const rec = {
        cod_cliente: row.codCliente, nombre_cliente: row.nombreCliente,
        no_factura: row.noFactura, cod_material: row.codMaterial,
        nombre_material: row.nombre, lote: row.lote,
        cantidad: row.cantidad, valor: row.valor,
        vendedor: row.vendedor, facturador: row.facturador,
      };
      const { data, error } = await supabase.from('fk_facturas').insert(rec).select().single();
      if (error) throw error;
      return { id: data.id, codCliente: data.cod_cliente, nombreCliente: data.nombre_cliente,
        noFactura: data.no_factura, codMaterial: data.cod_material, nombre: data.nombre_material,
        lote: data.lote, cantidad: data.cantidad, valor: data.valor,
        vendedor: data.vendedor, facturador: data.facturador };
    },
    async insertMany(rows) {
      const recs = rows.map(r => ({
        cod_cliente: r.codCliente, nombre_cliente: r.nombreCliente,
        no_factura: r.noFactura, cod_material: r.codMaterial,
        nombre_material: r.nombre, lote: r.lote,
        cantidad: r.cantidad, valor: r.valor,
        vendedor: r.vendedor, facturador: r.facturador,
      }));
      const { data, error } = await supabase.from('fk_facturas').insert(recs).select();
      if (error) throw error;
      return (data || []).map(r => ({
        id: r.id, codCliente: r.cod_cliente, nombreCliente: r.nombre_cliente,
        noFactura: r.no_factura, codMaterial: r.cod_material, nombre: r.nombre_material,
        lote: r.lote, cantidad: r.cantidad, valor: r.valor,
        vendedor: r.vendedor, facturador: r.facturador,
      }));
    },
    async update(id, row) {
      const rec = {
        cod_cliente: row.codCliente, nombre_cliente: row.nombreCliente,
        no_factura: row.noFactura, cod_material: row.codMaterial,
        nombre_material: row.nombre, lote: row.lote,
        cantidad: row.cantidad, valor: row.valor,
        vendedor: row.vendedor, facturador: row.facturador,
      };
      const { data, error } = await supabase.from('fk_facturas').update(rec).eq('id', id).select().single();
      if (error) throw error;
      return toCamel(data);
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
      const { data, error } = await supabase.from('fk_notas').select('*').order('id', { ascending: false });
      if (error) throw error;
      return (data || []).map(r => ({
        id:               r.id,
        ndv:              r.ndv,
        asignadoA:        r.asignado_a,
        rrvvNombre:       r.rrvv_nombre,
        creadoPor:        r.creado_por,
        creadoPorNombre:  r.creado_por_nombre,
        estado:           r.estado,
        motivoRechazo:    r.motivo_rechazo,
        form:             r.form,
        modActual:        r.mod_actual,
        registroFinal:    r.registro_final,
        historial:        r.historial,
      }));
    },
    async insert(nota) {
      const { data: ndvData, error: ndvError } = await supabase.rpc('next_ndv');
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
        form:              nota.form,
        mod_actual:        nota.modActual || null,
        registro_final:    nota.registroFinal || null,
        historial:         nota.historial || [],
      };
      const { data, error } = await supabase.from('fk_notas').insert(rec).select().single();
      if (error) throw error;
      return { ...nota, id: data.id, ndv };
    },
    async update(id, patch) {
      const rec = {};
      if (patch.estado          !== undefined) rec.estado           = patch.estado;
      if (patch.motivoRechazo   !== undefined) rec.motivo_rechazo   = patch.motivoRechazo;
      if (patch.modActual       !== undefined) rec.mod_actual        = patch.modActual;
      if (patch.registroFinal   !== undefined) rec.registro_final    = patch.registroFinal;
      if (patch.historial       !== undefined) rec.historial         = patch.historial;
      if (patch.form            !== undefined) rec.form              = patch.form;
      const { error } = await supabase.from('fk_notas').update(rec).eq('id', id);
      if (error) throw error;
    },
  },
};