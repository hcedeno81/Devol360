import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import { db } from "./supabase";

// ── ROLES ─────────────────────────────────────────────────────────────────────
const ROLES = [
  { value:"admin",          label:"Administrador",          desc:"Acceso total + gestión de usuarios",       color:"#dc2626" },
  { value:"rrvv",           label:"RRVV",                   desc:"Crea notas y confirma/rechaza correcciones", color:"#003087" },
  { value:"bodeguero_uio",  label:"Bodeguero Quito",        desc:"Revisa devoluciones de Quito",             color:"#0891b2" },
  { value:"bodeguero_gye",  label:"Bodeguero Guayaquil",    desc:"Revisa devoluciones de Guayaquil",         color:"#2563eb" },
  { value:"inspector",      label:"Inspector de Calidad",   desc:"Define destinos Stock/Destrucción",        color:"#0d9488" },
  { value:"facturador",     label:"Facturador",             desc:"Corrige facturas y exporta a SAP",         color:"#d97706" },
  { value:"gerente",        label:"Gerente de Operaciones", desc:"Confirma aprobación en SAP",               color:"#16a34a" },
];

// Reconoce cualquiera de los dos roles de bodeguero.
const isBodegueroRole=(role)=>role==="bodeguero_uio"||role==="bodeguero_gye";
// Ciudad que revisa cada rol de bodeguero.
const ciudadDeBodeguero=(role)=>role==="bodeguero_uio"?"quito":role==="bodeguero_gye"?"guayaquil":null;
const CIUDADES={quito:"Quito",guayaquil:"Guayaquil"};

// ── ESTADOS ───────────────────────────────────────────────────────────────────
const STC = {
  en_bodega:      "#0891b2",
  corregida:      "#7c3aed",
  en_calidad:     "#0d9488",
  en_facturacion: "#d97706",
  enviada_sap:    "#f59e0b",
  aprobada_sap:   "#16a34a",
};
const STL = {
  en_bodega:      "En Bodega",
  corregida:      "Corregida — Pend. RRVV",
  en_calidad:     "En Calidad",
  en_facturacion: "En Facturación",
  enviada_sap:    "Enviada a SAP",
  aprobada_sap:   "Aprobada en SAP ✓",
};

// Carpetas por rol (SIN "todas").
// rrvv: solo En Bodega, Corregidas y Aprobadas en SAP.
//   La visibilidad es por propietario (ver visibleNotas): cada RRVV ve solo las notas
//   asignadas a él (asignadoA), por lo que con varios RRVV cada uno queda aislado.
//   Nota: mientras una nota está En Calidad / En Facturación / Enviada a SAP no aparece
//   en ninguna de sus 3 carpetas; reaparece al llegar a "Aprobada en SAP".
const ROLE_STATES = {
  admin:          ["en_bodega","corregida","en_calidad","en_facturacion","enviada_sap","aprobada_sap"],
  rrvv:           ["en_bodega","corregida","aprobada_sap"],
  bodeguero_uio:  ["en_bodega","corregida","en_calidad","en_facturacion","aprobada_sap"],
  bodeguero_gye:  ["en_bodega","corregida","en_calidad","en_facturacion","aprobada_sap"],
  inspector:      ["en_calidad"],
  facturador:     ["en_facturacion","enviada_sap","aprobada_sap"],
  gerente:        ["enviada_sap","aprobada_sap"],
};

const TAB_LABELS = {
  en_bodega:      "📦 Por Revisar",
  corregida:      "🔄 Corregidas",
  en_calidad:     "🔬 En Calidad",
  en_facturacion: "🧾 En Facturación",
  enviada_sap:    "📤 Enviadas a SAP",
  aprobada_sap:   "✅ Aprobadas en SAP",
};

const getTabLabel = (k, role) => {
  if(k==="corregida" && isBodegueroRole(role)) return "🔄 Rechazadas por RRVV";
  if(k==="en_bodega" && role==="rrvv")      return "📦 En Bodega";
  return TAB_LABELS[k] || k;
};

// ── INIT DATA ─────────────────────────────────────────────────────────────────
// Los usuarios se gestionan exclusivamente en Supabase (tabla fk_users, protegida
// por RLS). El usuario administrador inicial se crea con el script security_setup.sql.
// NUNCA se incluyen credenciales en el código fuente.
// Maestro único Producto-Lote.
// Clave de deduplicación: lote + codigo (un mismo nº de lote puede existir en distintos materiales).


// Facturas demo: relacionan cliente → material → lote → factura
// ── HELPERS ───────────────────────────────────────────────────────────────────
const mkL    = ()=>({codigo:"",nombre:"",porc15:null,medVital:null,cantidad:"",lote:"",fechaVenc:"",facturaNo:"",destino:"",cantStock:"",cantDestruccion:""});
const pad    = (arr)=>{ const r=[...arr]; while(r.length<10) r.push(mkL()); return r.slice(0,10); };
const mkForm = ()=>({fecha:"",codigoCliente:"",nombreCliente:"",tipoDevolucion:"",codigoMotivo:"",descripcionMotivo:"",nc:false,canje:false,observacion:"",noBultos:"",lineas:pad([])});
const fmtD   = (iso)=>{ if(!iso) return ""; const p=iso.split("-"); if(p.length!==3) return iso; return `${p[2]}/${p[1]}/${p[0]}`; };
const cloneForm=(f)=>({...f,lineas:f.lineas.map(l=>({...l}))});

// Normaliza una fecha (DD/MM/AAAA, AAAA-MM-DD, DD-MM-AAAA...) a ISO AAAA-MM-DD.
const toISO=(str)=>{
  if(!str) return "";
  str=String(str).trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  let m=str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if(m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  m=str.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if(m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  return str;
};
// Detecta el separador real de un CSV (Excel en español suele guardar con ";").
const detectDelim=(line)=>{
  const c={"\t":(line.match(/\t/g)||[]).length, ";":(line.match(/;/g)||[]).length, ",":(line.match(/,/g)||[]).length};
  const best=Object.keys(c).reduce((a,b)=>c[b]>c[a]?b:a, ",");
  return c[best]>0?best:",";
};
// Parser de una línea CSV respetando comillas y comillas escapadas ("").
const parseLine=(line,delim)=>{
  const out=[]; let cur=""; let inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){ if(inQ&&line[i+1]==='"'){ cur+='"'; i++; } else inQ=!inQ; }
    else if(ch===delim&&!inQ){ out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur);
  return out.map(x=>x.trim());
};

const C={primary:"#003087",accent:"#0066cc",success:"#16a34a",warning:"#d97706",danger:"#dc2626",purple:"#7c3aed",bg:"#f0f4f8",gray:"#6b7280",light:"#e5e7eb"};
const rc=(r)=>ROLES.find(x=>x.value===r)?.color||C.gray;
const s={
  app:    {fontFamily:"Arial,sans-serif",minHeight:"100vh",background:C.bg,fontSize:13},
  hdr:    {background:C.primary,color:"#fff",padding:"10px 20px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"},
  nav:    {background:"#fff",borderBottom:`2px solid ${C.light}`,padding:"0 16px",display:"flex",gap:2,overflowX:"auto"},
  nBtn:   (a)=>({padding:"8px 12px",border:"none",borderBottom:a?`3px solid ${C.primary}`:"3px solid transparent",background:"none",fontWeight:a?"bold":"normal",color:a?C.primary:C.gray,cursor:"pointer",fontSize:12,whiteSpace:"nowrap"}),
  page:   {padding:20,maxWidth:1100,margin:"0 auto"},
  card:   {background:"#fff",borderRadius:8,boxShadow:"0 1px 4px rgba(0,0,0,.1)",padding:20,marginBottom:16},
  title:  {fontSize:16,fontWeight:"bold",color:C.primary,marginBottom:12},
  btn:    (c=C.primary,sm=false)=>({background:c,color:"#fff",border:"none",borderRadius:5,padding:sm?"3px 10px":"7px 14px",cursor:"pointer",fontSize:sm?11:13,fontWeight:"bold"}),
  bOut:   (c=C.primary)=>({background:"#fff",color:c,border:`1px solid ${c}`,borderRadius:5,padding:"7px 14px",cursor:"pointer",fontSize:13}),
  inp:    {border:`1px solid ${C.light}`,borderRadius:4,padding:"5px 8px",fontSize:13,width:"100%",boxSizing:"border-box"},
  inpDis: {border:`1px solid ${C.light}`,borderRadius:4,padding:"5px 8px",fontSize:13,width:"100%",boxSizing:"border-box",background:"#f3f4f6",color:C.gray},
  lbl:    {fontSize:12,color:C.gray,marginBottom:2,display:"block"},
  bdg:    (c)=>({background:c+"22",color:c,padding:"2px 7px",borderRadius:10,fontSize:11,fontWeight:"bold",display:"inline-block"}),
  row:    {display:"flex",gap:12,flexWrap:"wrap"},
  th:     {background:C.primary,color:"#fff",padding:"6px 8px",textAlign:"left",whiteSpace:"nowrap",fontSize:11},
  td:     {padding:"5px 6px",borderBottom:`1px solid ${C.light}`,verticalAlign:"middle"},
  tbl:    {width:"100%",borderCollapse:"collapse",fontSize:12},
};

// ── VISIBILITY ────────────────────────────────────────────────────────────────
const visibleNotas=(notas,user)=>{
  if(!user) return [];
  if(user.role==="admin") return notas;
  if(user.role==="rrvv") return notas.filter(n=>n.asignadoA===user.id);
  // Cada bodeguero solo ve las notas de SU ciudad.
  if(isBodegueroRole(user.role)){
    const ciudad=ciudadDeBodeguero(user.role);
    const states=ROLE_STATES[user.role]||[];
    return notas.filter(n=>n.ciudad===ciudad&&states.includes(n.estado));
  }
  const states=ROLE_STATES[user.role]||[];
  return notas.filter(n=>states.includes(n.estado));
};

// ── DEMO NOTES ────────────────────────────────────────────────────────────────

// ── PREDICTIVE INPUT ──────────────────────────────────────────────────────────
// ── TOAST GLOBAL ──────────────────────────────────────────────────────────────
// Notificaciones propias (alert() está bloqueado en iframes de StackBlitz).
let _toastListener=null;
export const notify=(msg,type="error")=>{ if(_toastListener) _toastListener({msg,type}); };
function ToastHost(){
  const [toast,setToast]=useState(null);
  useEffect(()=>{ _toastListener=(t)=>{ setToast(t); setTimeout(()=>setToast(null),4500); }; return ()=>{_toastListener=null;}; },[]);
  if(!toast) return null;
  const colors={error:"#dc2626",warn:"#d97706",success:"#16a34a",info:"#0066cc"};
  return (
    <div style={{position:"fixed",top:16,left:"50%",transform:"translateX(-50%)",zIndex:9999,background:colors[toast.type]||colors.error,color:"#fff",padding:"12px 22px",borderRadius:8,maxWidth:520,fontSize:13,boxShadow:"0 4px 20px rgba(0,0,0,.3)",whiteSpace:"pre-line"}}>
      {toast.msg}
    </div>
  );
}

// ── RESTRICTED PICKER (combobox de selección obligatoria) ─────────────────────
// Autocompleta por código o nombre, pero NUNCA acepta texto libre: si lo escrito
// no coincide EXACTO con una opción de la lista, el campo se limpia solo al salir
// (blur), evitando que quede un código/nombre "inventado" o mal escrito que
// rompería el enlace con el maestro de datos (facturas, clientes, etc.).
// displayField: qué campo de la opción se muestra/edita en el input ("label" o "cod").
function RestrictedPicker({value,onChange,options,placeholder,style,disabled,displayField="label",emptyMsg="Sin coincidencias",invalidMsg="⚠ Debes elegir una opción de la lista.",fallbackText=""}) {
  // options: [{cod, label}]
  const [open,setOpen]=useState(false);
  const [text,setText]=useState("");
  const skipBlur=useRef(false);
  const matchKey=displayField==="cod"?"cod":"label";

  // Sincroniza el texto mostrado con el valor seleccionado desde afuera.
  // Si el valor no está en options (producto guardado antes de que se actualizara el maestro),
  // usa fallbackText para mostrar el dato guardado en vez de dejarlo vacío.
  useEffect(()=>{
    const sel=options.find(o=>o.cod===value);
    if(sel) setText(sel[matchKey]);
    else if(value && fallbackText) setText(fallbackText);
    else if(!value) setText("");
  },[value,options,matchKey,fallbackText]);

  const norm=(v)=>(v||"").toLowerCase();
  const filtered=text
    ? options.filter(o=>norm(o.label).includes(norm(text))||norm(o.cod).includes(norm(text))).slice(0,15)
    : options.slice(0,15);

  const isValidText = options.some(o=>o[matchKey]===text);

  const handleSelect=(o)=>{
    skipBlur.current=true;
    setText(o[matchKey]);
    onChange(o.cod);
    setOpen(false);
    setTimeout(()=>{ skipBlur.current=false; },300);
  };

  const handleBlur=()=>{
    if(skipBlur.current) return;
    setOpen(false);
    // Si lo escrito no coincide exactamente con una opción válida, se limpia
    // para no arrastrar una selección "a medias" sin datos asociados reales.
    if(!isValidText){
      onChange("");
      setText("");
    }
  };

  return (
    <div style={{position:"relative",width:style?.width||"100%"}}>
      <input
        style={{...style,width:"100%",boxSizing:"border-box",border:`1px solid ${disabled?C.light:(value?C.accent:(text?C.danger:C.light))}`}}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onChange={e=>{ setText(e.target.value); onChange(""); setOpen(true); }}
        onFocus={()=>setOpen(true)}
        onBlur={handleBlur}
      />
      {open&&!disabled&&filtered.length>0&&(
        <div style={{position:"absolute",zIndex:1000,background:"#fff",border:`1px solid ${C.accent}`,borderRadius:6,boxShadow:"0 4px 16px rgba(0,0,0,.15)",maxHeight:240,overflowY:"auto",width:"max-content",minWidth:"100%",top:"calc(100% + 2px)",left:0}}>
          {filtered.map(o=>(
            <div key={o.cod} style={{padding:"7px 12px",cursor:"pointer",fontSize:12,borderBottom:`1px solid ${C.light}`,background:"#fff",whiteSpace:"nowrap"}}
              onMouseDown={e=>{ e.preventDefault(); handleSelect(o); }}
              onMouseEnter={e=>e.currentTarget.style.background="#eff6ff"}
              onMouseLeave={e=>e.currentTarget.style.background="#fff"}>
              <strong>{o.cod}</strong> — {o.label}
            </div>
          ))}
        </div>
      )}
      {open&&!disabled&&filtered.length===0&&(
        <div style={{position:"absolute",zIndex:1000,background:"#fff",border:`1px solid ${C.light}`,borderRadius:6,padding:"7px 12px",fontSize:12,color:C.gray,top:"calc(100% + 2px)",left:0,width:"max-content"}}>
          {emptyMsg}
        </div>
      )}
      {text&&!value&&!open&&!disabled&&(
        <div style={{fontSize:11,color:C.danger,marginTop:2}}>{invalidMsg}</div>
      )}
    </div>
  );
}

// Wrapper específico para cliente (mantiene el nombre usado en NotaForm).
function ClientPicker({value,onChange,options,placeholder,style}) {
  return <RestrictedPicker value={value} onChange={onChange} options={options} placeholder={placeholder} style={style}
    displayField="label" invalidMsg="⚠ Debes elegir un cliente de la lista."/>;
}

// ── PRODUCT TABLE ─────────────────────────────────────────────────────────────
function ProductHeader({calEditable}) {
  return (
    <thead>
      <tr>
        <th style={s.th}>Nº</th><th style={s.th}>Código</th><th style={s.th}>Descripción</th>
        <th style={{...s.th,textAlign:"center"}} colSpan={2}>Porcentaje 15%</th>
        <th style={{...s.th,textAlign:"center"}} colSpan={2}>Medicamento Vital</th>
        <th style={s.th}>Cantidad</th><th style={s.th}>Lote</th><th style={s.th}>F. Vencimiento</th>
        <th style={s.th}>Factura Nº</th>
        <th style={{...s.th,background:calEditable?"#0d9488":"#6b7280"}}>{calEditable?"Stock / Destrucción":"Destino"}</th>
      </tr>
      <tr style={{background:"#1e3a6e"}}>
        {["","","","Sí","No","Sí","No","","","","",""].map((h,i)=>(
          <th key={i} style={{...s.th,background:"#1e3a6e",textAlign:"center",fontSize:10}}>{h}</th>
        ))}
      </tr>
    </thead>
  );
}

// Fila memoizada: solo se re-renderiza la fila que cambia al escribir.
// facCliente y productoOptions llegan precalculados desde ProductRows (una sola vez,
// memoizados) en vez de recalcularse en cada una de las 10 filas por cada render —
// clave para mantener el sistema ágil con maestros de facturas grandes.
const ProductRow = memo(function ProductRow({l,i,editable,calEditable,facEditable,onChangeLine,plotes=[],facCliente=[],productoOptions=[],codigoCliente=""}) {
  // Lotes: los que aparecen en facturas del cliente para ese código (deduplicados)
  const lotesEnFactura=[...new Set(facCliente.filter(f=>f.codMaterial===l.codigo).map(f=>f.lote).filter(Boolean))];
  // Facturas del cliente para ese código+lote específico
  const facturasSug=[...new Set(
    facCliente.filter(f=>f.codMaterial===l.codigo&&(!l.lote||f.lote===l.lote)).map(f=>f.noFactura)
  )];

  return (
    <tr style={{background:i%2===0?"#f9fafb":"#fff"}}>
      <td style={s.td}>{i+1}</td>
      {editable?(
        <>
          <td style={s.td}>
            <RestrictedPicker style={{...s.inp,width:85}} value={l.codigo}
              options={productoOptions} displayField="cod"
              placeholder={codigoCliente?"Código...":"— Elige cliente —"}
              disabled={!codigoCliente}
              fallbackText={l.codigo}
              emptyMsg="Sin productos para este cliente"
              invalidMsg="⚠ Elige un producto de la lista."
              onChange={v=>{
                const fac=facCliente.find(x=>x.codMaterial===v);
                onChangeLine(i,{codigo:v,nombre:fac?fac.nombre:"",lote:"",fechaVenc:"",facturaNo:""});
              }}/>
          </td>
          <td style={s.td}>
            <RestrictedPicker style={{...s.inp,width:170}} value={l.codigo}
              options={productoOptions} displayField="label"
              placeholder={codigoCliente?"Nombre material...":"— Elige cliente —"}
              disabled={!codigoCliente}
              fallbackText={l.nombre}
              emptyMsg="Sin productos para este cliente"
              invalidMsg="⚠ Elige un producto de la lista."
              onChange={v=>{
                const fac=facCliente.find(x=>x.codMaterial===v);
                onChangeLine(i,{codigo:v,nombre:fac?fac.nombre:"",lote:"",fechaVenc:"",facturaNo:""});
              }}/>
          </td>
          <td style={{...s.td,textAlign:"center"}}><input type="radio" name={`p15-${i}`} checked={l.porc15==="si"} onChange={()=>onChangeLine(i,{porc15:"si"})}/></td>
          <td style={{...s.td,textAlign:"center"}}><input type="radio" name={`p15-${i}`} checked={l.porc15==="no"} onChange={()=>onChangeLine(i,{porc15:"no"})}/></td>
          <td style={{...s.td,textAlign:"center"}}><input type="radio" name={`mv-${i}`} checked={l.medVital==="si"} onChange={()=>onChangeLine(i,{medVital:"si"})}/></td>
          <td style={{...s.td,textAlign:"center"}}><input type="radio" name={`mv-${i}`} checked={l.medVital==="no"} onChange={()=>onChangeLine(i,{medVital:"no"})}/></td>
          <td style={s.td}><input style={{...s.inp,width:60}} value={l.cantidad} onChange={e=>onChangeLine(i,{cantidad:e.target.value})}/></td>
          <td style={s.td}>
            <select style={{...s.inp,width:110}}
              value={l.lote}
              disabled={!l.codigo}
              onChange={e=>{ const v=e.target.value; const lt=plotes.find(x=>x.codigo===l.codigo&&x.lote===v); onChangeLine(i,{lote:v,fechaVenc:lt?lt.fechaCad:"",facturaNo:""}); }}>
              <option value="">{!l.codigo?"— Elige código primero —":lotesEnFactura.length===0?"Sin lotes disponibles":"— Seleccionar lote —"}</option>
              {lotesEnFactura.map(lt=><option key={lt} value={lt}>{lt}</option>)}
            </select>
          </td>
          <td style={s.td}>
            {l.fechaVenc
              ? <span style={{fontSize:12,color:C.primary,fontWeight:"bold"}}>{fmtD(l.fechaVenc)}</span>
              : <span style={{fontSize:11,color:C.gray}}>—</span>}
          </td>
          <td style={s.td}>
            <select style={{...s.inp,width:115}}
              value={l.facturaNo}
              disabled={!l.lote}
              onChange={e=>onChangeLine(i,{facturaNo:e.target.value})}>
              <option value="">{!l.lote?"— Elige lote primero —":facturasSug.length===0?"Sin facturas":"— Seleccionar factura —"}</option>
              {facturasSug.map(f=><option key={f} value={f}>{f}</option>)}
            </select>
          </td>
          <td style={s.td}><input style={s.inpDis} value="—" disabled title="Solo lo llena Calidad"/></td>
        </>
      ):calEditable?(
        <>
          <td style={s.td}>{l.codigo}</td><td style={s.td}>{l.nombre}</td>
          <td style={{...s.td,textAlign:"center"}}>{l.porc15==="si"?"✓":""}</td>
          <td style={{...s.td,textAlign:"center"}}>{l.porc15==="no"?"✓":""}</td>
          <td style={{...s.td,textAlign:"center"}}>{l.medVital==="si"?"✓":""}</td>
          <td style={{...s.td,textAlign:"center"}}>{l.medVital==="no"?"✓":""}</td>
          <td style={s.td}>{l.cantidad}</td><td style={s.td}>{l.lote}</td>
          <td style={s.td}>{fmtD(l.fechaVenc)}</td><td style={s.td}>{l.facturaNo}</td>
          <td style={s.td}>
            <div style={{display:"flex",gap:4}}>
              <input style={{...s.inp,width:55}} value={l.cantStock||""} placeholder="Stock" onChange={e=>{ const v=e.target.value; onChangeLine(i,{cantStock:v,destino:parseFloat(v)>0&&parseFloat(l.cantDestruccion)>0?"Stock/Destrucción":parseFloat(v)>0?"Stock":parseFloat(l.cantDestruccion)>0?"Destrucción":""}); }}/>
              <input style={{...s.inp,width:65}} value={l.cantDestruccion||""} placeholder="Destruc." onChange={e=>{ const v=e.target.value; onChangeLine(i,{cantDestruccion:v,destino:parseFloat(l.cantStock)>0&&parseFloat(v)>0?"Stock/Destrucción":parseFloat(v)>0?"Destrucción":parseFloat(l.cantStock)>0?"Stock":""}); }}/>
            </div>
            {(()=>{ if(!l.nombre&&!l.codigo) return null; const cant=parseFloat(l.cantidad)||0; const sum=(parseFloat(l.cantStock)||0)+(parseFloat(l.cantDestruccion)||0); if(sum===0&&cant>0) return <div style={{fontSize:10,color:C.warning,marginTop:2}}>⚠ Pendiente ({cant})</div>; if(sum===cant) return <div style={{fontSize:10,color:C.success,marginTop:2}}>✓ OK</div>; return <div style={{fontSize:10,color:C.danger,marginTop:2}}>✗ {sum}≠{cant}</div>; })()}
          </td>
        </>
      ):facEditable?(
        <>
          <td style={s.td}>{l.codigo}</td><td style={s.td}>{l.nombre}</td>
          <td style={{...s.td,textAlign:"center"}}>{l.porc15==="si"?"✓":""}</td>
          <td style={{...s.td,textAlign:"center"}}>{l.porc15==="no"?"✓":""}</td>
          <td style={{...s.td,textAlign:"center"}}>{l.medVital==="si"?"✓":""}</td>
          <td style={{...s.td,textAlign:"center"}}>{l.medVital==="no"?"✓":""}</td>
          <td style={s.td}>{l.cantidad}</td><td style={s.td}>{l.lote}</td>
          <td style={s.td}>{fmtD(l.fechaVenc)}</td>
          <td style={s.td}><input style={{...s.inp,width:90}} value={l.facturaNo} onChange={e=>onChangeLine(i,{facturaNo:e.target.value})}/></td>
          <td style={s.td}><span style={s.bdg(l.destino==="Stock"?C.success:l.destino?C.danger:C.gray)}>{l.destino||"—"}</span></td>
        </>
      ):(
        <>
          <td style={s.td}>{l.codigo}</td><td style={s.td}>{l.nombre}</td>
          <td style={{...s.td,textAlign:"center"}}>{l.porc15==="si"?"✓":""}</td>
          <td style={{...s.td,textAlign:"center"}}>{l.porc15==="no"?"✓":""}</td>
          <td style={{...s.td,textAlign:"center"}}>{l.medVital==="si"?"✓":""}</td>
          <td style={{...s.td,textAlign:"center"}}>{l.medVital==="no"?"✓":""}</td>
          <td style={s.td}>{l.cantidad}</td><td style={s.td}>{l.lote}</td>
          <td style={s.td}>{fmtD(l.fechaVenc)}</td><td style={s.td}>{l.facturaNo}</td>
          <td style={s.td}><span style={s.bdg(l.destino==="Stock"?C.success:l.destino==="Destrucción"?C.danger:l.destino?C.warning:C.gray)}>{l.destino||"—"}</span></td>
        </>
      )}
    </tr>
  );
});

function ProductRows({lineas,onChangeLine,editable,calEditable,facEditable,plotes=[],facturas=[],codigoCliente=""}) {
  // Cálculo compartido: una sola pasada por el maestro de facturas para las 10 filas.
  // useMemo garantiza identidad estable → React.memo de ProductRow evita re-renders.
  const facCliente=useMemo(
    ()=>codigoCliente?facturas.filter(f=>f.codCliente===codigoCliente):[],
    [facturas,codigoCliente]
  );
  const productoOptions=useMemo(
    ()=>[...new Map(facCliente.map(f=>[f.codMaterial,f.nombre])).entries()]
      .map(([cod,label])=>({cod,label}))
      .sort((a,b)=>a.cod.localeCompare(b.cod)),
    [facCliente]
  );
  return (
    <tbody>
      {lineas.map((l,i)=>(
        <ProductRow key={i} l={l} i={i} editable={editable} calEditable={calEditable} facEditable={facEditable} onChangeLine={onChangeLine} plotes={plotes} facCliente={facCliente} productoOptions={productoOptions} codigoCliente={codigoCliente}/>
      ))}
    </tbody>
  );
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
// La verificación de credenciales ocurre en el servidor (fn_login, bcrypt).
// Si el usuario tiene must_change_password (primer ingreso o reset del admin),
// se le obliga a definir una contraseña nueva antes de entrar al sistema.
function Login({onLogin}) {
  const [u,setU]=useState(""); const [p,setP]=useState("");
  const [err,setErr]=useState(""); const [loading,setLoading]=useState(false);
  const [mustChange,setMustChange]=useState(null); // {usr, oldPass}
  const [np,setNp]=useState(""); const [np2,setNp2]=useState("");

  const doLogin=async()=>{
    if(loading) return;
    if(!u.trim()||!p) return setErr("Ingresa usuario y contraseña.");
    setErr(""); setLoading(true);
    try{
      const usr=await db.auth.login(u.trim(),p);
      if(!usr){ setErr("Usuario o contraseña incorrectos, o cuenta inactiva."); return; }
      if(usr.mustChangePassword){ setMustChange({usr,oldPass:p}); return; }
      onLogin({...usr,_pw:p});
    }catch(e){ setErr("Error de conexión: "+e.message); }
    finally{ setLoading(false); }
  };

  const doChange=async()=>{
    if(loading) return;
    if(np.length<8)              return setErr("La nueva contraseña debe tener al menos 8 caracteres.");
    if(np!==np2)                 return setErr("Las contraseñas no coinciden.");
    if(np===mustChange.oldPass)  return setErr("La nueva contraseña no puede ser igual a la temporal.");
    setErr(""); setLoading(true);
    try{
      const ok=await db.auth.changePassword(mustChange.usr.username,mustChange.oldPass,np);
      if(!ok){ setErr("No se pudo cambiar la contraseña. Intenta de nuevo."); return; }
      onLogin({...mustChange.usr,mustChangePassword:false,_pw:np});
    }catch(e){ setErr("Error: "+e.message); }
    finally{ setLoading(false); }
  };

  return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{...s.card,width:370,textAlign:"center"}}>
        <div style={{color:C.primary,fontWeight:"bold",fontSize:22,marginBottom:4}}>FRESENIUS KABI</div>
        <div style={{color:C.gray,fontSize:13,marginBottom:20}}>Sistema de Gestión de Devoluciones</div>
        {!mustChange?(
          <>
            <label style={s.lbl}>Usuario</label>
            <input style={{...s.inp,marginBottom:10}} value={u} autoComplete="username" onChange={e=>setU(e.target.value)}/>
            <label style={s.lbl}>Contraseña</label>
            <input style={{...s.inp,marginBottom:14}} type="password" autoComplete="current-password" value={p}
              onChange={e=>setP(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doLogin()}/>
            {err&&<div style={{color:C.danger,fontSize:12,marginBottom:8}}>{err}</div>}
            <button style={{...s.btn(),width:"100%",opacity:loading?0.6:1}} onClick={doLogin} disabled={loading}>
              {loading?"⏳ Verificando...":"🔐 Ingresar"}
            </button>
            <div style={{marginTop:14,fontSize:11,color:C.gray}}>
              Si olvidaste tu contraseña, solicita al administrador que te asigne una temporal.
            </div>
          </>
        ):(
          <>
            <div style={{background:"#fffbeb",border:`1px solid #fde68a`,borderRadius:6,padding:10,marginBottom:14,fontSize:12,color:"#92400e",textAlign:"left"}}>
              🔑 Hola <strong>{mustChange.usr.name}</strong>. Por seguridad debes definir tu propia contraseña
              antes de ingresar. La contraseña temporal dejará de funcionar.
            </div>
            <label style={s.lbl}>Nueva contraseña (mín. 8 caracteres)</label>
            <input style={{...s.inp,marginBottom:10}} type="password" autoComplete="new-password" value={np} onChange={e=>setNp(e.target.value)}/>
            <label style={s.lbl}>Confirmar nueva contraseña</label>
            <input style={{...s.inp,marginBottom:14}} type="password" autoComplete="new-password" value={np2}
              onChange={e=>setNp2(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doChange()}/>
            {err&&<div style={{color:C.danger,fontSize:12,marginBottom:8}}>{err}</div>}
            <button style={{...s.btn(C.success),width:"100%",opacity:loading?0.6:1}} onClick={doChange} disabled={loading}>
              {loading?"⏳ Guardando...":"✅ Cambiar contraseña e ingresar"}
            </button>
            <button style={{...s.bOut(),width:"100%",marginTop:8}} onClick={()=>{setMustChange(null);setNp("");setNp2("");setErr("");}}>← Volver</button>
          </>
        )}
      </div>
    </div>
  );
}

// ── NOTA FORM ─────────────────────────────────────────────────────────────────
function NotaForm({user,users,motivos,plotes,facturas,setNotas,onBack}) {
  const rrvvList=users.filter(u=>u.role==="rrvv"&&u.active);
  const hoy=new Date().toISOString().split("T")[0];
  const [form,setForm]=useState({...mkForm(),fecha:hoy});
  const [asig,setAsig]=useState(String(user.id));
  const [tipoProducto,setTipoProducto]=useState(""); // 'normal' | 'controlado'
  const [ciudad,setCiudad]=useState("");             // 'quito'  | 'guayaquil'
  const [submitErr,setSubmitErr]=useState("");
  const [guardando,setGuardando]=useState(false);
  const sf=(k,v)=>setForm(f=>({...f,[k]:v}));
  const changeLine=useCallback((i,patch)=>setForm(f=>{ const ls=[...f.lineas]; ls[i]={...ls[i],...patch}; return{...f,lineas:ls}; }),[]);

  // Opciones únicas de cliente derivadas del maestro de facturas: {cod, label}
  const clienteOptions=useMemo(()=>(
    [...new Map(facturas.map(f=>[f.codCliente,f.nombreCliente||f.codCliente])).entries()]
      .map(([cod,label])=>({cod,label}))
      .sort((a,b)=>a.label.localeCompare(b.label))
  ),[facturas]);

  const submit=async()=>{
    if(guardando) return; // evita doble click → notas duplicadas
    // ── Validación cabecera ────────────────────────────────────────────────────
    if(!form.fecha)          return setSubmitErr("La fecha es obligatoria.");
    if(!tipoProducto)        return setSubmitErr("Indica si es producto normal o controlado.");
    if(!ciudad)              return setSubmitErr("Indica si la devolución se revisa en Quito o Guayaquil.");
    if(!form.codigoCliente)  return setSubmitErr("Selecciona el cliente.");
    if(!form.nombreCliente)  return setSubmitErr("El nombre del cliente es obligatorio.");
    if(!form.tipoDevolucion) return setSubmitErr("Selecciona el tipo de devolución.");
    if(!form.codigoMotivo)   return setSubmitErr("Selecciona el motivo de devolución.");
    if(!form.nc&&!form.canje)return setSubmitErr("Selecciona Nota de Crédito o Canje.");
    if(!asig)                return setSubmitErr("Selecciona el RRVV responsable.");
    // ── Validación líneas ─────────────────────────────────────────────────────
    // Debe haber al menos una línea con producto
    const lineasActivas=form.lineas.filter(l=>l.codigo||l.nombre);
    if(lineasActivas.length===0) return setSubmitErr("Agrega al menos un producto.");
    const erroresLinea=[];
    lineasActivas.forEach((l,idx)=>{
      const n=idx+1;
      if(!l.codigo)    erroresLinea.push(`Línea ${n}: falta el código de material.`);
      if(!l.nombre)    erroresLinea.push(`Línea ${n}: falta el nombre de material.`);
      if(!l.porc15)    erroresLinea.push(`Línea ${n}: indica si aplica el 15%.`);
      if(!l.medVital)  erroresLinea.push(`Línea ${n}: indica si es medicamento vital.`);
      if(!l.cantidad)  erroresLinea.push(`Línea ${n}: falta la cantidad.`);
      if(isNaN(parseFloat(l.cantidad))||parseFloat(l.cantidad)<=0) erroresLinea.push(`Línea ${n}: la cantidad debe ser mayor a 0.`);
      if(!l.lote)      erroresLinea.push(`Línea ${n}: selecciona el lote.`);
      if(!l.fechaVenc) erroresLinea.push(`Línea ${n}: falta la fecha de vencimiento.`);
      if(!l.facturaNo) erroresLinea.push(`Línea ${n}: selecciona la factura.`);
      // destino, cantStock, cantDestruccion → los llena el Inspector, no se validan aquí
    });
    if(erroresLinea.length>0) return setSubmitErr(erroresLinea[0]);
    setSubmitErr("");
    const rrvv=users.find(u=>u.id===parseInt(asig));
    setGuardando(true);
    try{
      const nuevaNota=await db.notas.insert({
        form:cloneForm(form),
        tipoProducto,ciudad,
        asignadoA:parseInt(asig),rrvvNombre:rrvv?.name,
        creadoPor:user.id,creadoPorNombre:user.name,
        estado:"en_bodega",modActual:null,registroFinal:null,motivoRechazo:null,
        historial:[{accion:"Nota creada — (asignando NDV...)",usuario:user.name,fecha:new Date().toLocaleString()}],
      });
      nuevaNota.historial[0].accion=`Nota creada — ${nuevaNota.ndv}`;
      await db.notas.update(nuevaNota.id,{historial:nuevaNota.historial});
      setNotas(prev=>[nuevaNota,...prev]);
      onBack();
    }catch(e){ setSubmitErr("Error al guardar: "+e.message); }
    finally{ setGuardando(false); }
  };

  return (
    <div style={s.page}>
      <div style={{...s.card,borderTop:`4px solid ${C.primary}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
          <div><div style={{fontWeight:"bold",fontSize:17,color:C.primary}}>FRESENIUS KABI — NOTA DE DEVOLUCIÓN</div>
          <div style={{fontSize:11,color:C.gray}}>EC-MU-3207-FORM-LW-000087034 · Ver 1.0</div></div>
          <div style={{background:"#f0f4ff",borderRadius:6,padding:"8px 14px",textAlign:"right"}}>
            <div style={{fontSize:11,color:C.gray}}>Nº Nota</div>
            <div style={{fontWeight:"bold",color:C.primary,fontSize:13}}>
              {tipoProducto==="controlado"?"C-… (al crear)":tipoProducto==="normal"?"NDV-… (al crear)":"Se asignará al crear"}
            </div>
          </div>
        </div>

        <div style={{...s.card,background:"#f8fafc",border:`1px solid ${C.light}`,marginBottom:14}}>
          <div style={s.row}>
            <div style={{flex:"1 1 260px"}}>
              <label style={s.lbl}>Tipo de producto *</label>
              <div style={{display:"flex",gap:8,marginTop:4}}>
                {[["normal","📦 Normal","NDV-"],["controlado","🔒 Controlado","C-"]].map(([v,lbl,pre])=>(
                  <button key={v} type="button" onClick={()=>setTipoProducto(v)}
                    style={{flex:1,padding:"8px 10px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:"bold",
                      border:`2px solid ${tipoProducto===v?C.primary:C.light}`,
                      background:tipoProducto===v?"#eff6ff":"#fff",color:tipoProducto===v?C.primary:C.gray}}>
                    {lbl}<div style={{fontSize:10,fontWeight:"normal",color:C.gray,marginTop:2}}>Prefijo {pre}</div>
                  </button>
                ))}
              </div>
            </div>
            <div style={{flex:"1 1 260px"}}>
              <label style={s.lbl}>Ciudad de revisión *</label>
              <div style={{display:"flex",gap:8,marginTop:4}}>
                {[["quito","🏔️ Quito"],["guayaquil","🌴 Guayaquil"]].map(([v,lbl])=>(
                  <button key={v} type="button" onClick={()=>setCiudad(v)}
                    style={{flex:1,padding:"8px 10px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:"bold",
                      border:`2px solid ${ciudad===v?C.accent:C.light}`,
                      background:ciudad===v?"#eff6ff":"#fff",color:ciudad===v?C.accent:C.gray}}>
                    {lbl}<div style={{fontSize:10,fontWeight:"normal",color:C.gray,marginTop:2}}>Bodega {CIUDADES[v]}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
          {ciudad&&<div style={{fontSize:11,color:C.accent,marginTop:8}}>ℹ️ Esta devolución será revisada por el bodeguero de <strong>{CIUDADES[ciudad]}</strong>.</div>}
        </div>

        <div style={s.row}>
          <div style={{flex:"0 0 180px"}}>
            <label style={s.lbl}>📅 Fecha de creación</label>
            <div style={{...s.inpDis,padding:"5px 8px",borderRadius:4,fontSize:13}}>{fmtD(form.fecha)}</div>
          </div>
          <div style={{flex:"2 1 320px"}}>
            <label style={s.lbl}>Cliente *</label>
            <ClientPicker
              style={s.inp}
              value={form.codigoCliente}
              options={clienteOptions}
              placeholder="Escribe código o nombre del cliente..."
              onChange={v=>{
                const opt=clienteOptions.find(o=>o.cod===v);
                sf("codigoCliente",v);
                sf("nombreCliente",opt?opt.label:"");
                setForm(f=>({...f,lineas:pad([])}));
              }}
            />
          </div>
        </div>
        {(()=>{
          const facCli=facturas.filter(f=>f.codCliente===form.codigoCliente);
          const nProd=new Set(facCli.map(f=>f.codMaterial)).size;
          if(!form.codigoCliente) return null;
          return (
            <div style={{marginTop:6}}>
              <div style={{fontSize:11,color:C.accent}}>✓ {facCli.length} línea(s) de factura · {nProd} material(es) disponible(s)</div>
              {facCli.length===0&&facturas.length>0&&(
                <div style={{fontSize:11,color:C.danger,marginTop:2}}>
                  ⚠ No se encontraron facturas para <strong>{form.codigoCliente}</strong>.
                  Códigos disponibles en el maestro: <strong>{[...new Set(facturas.map(f=>f.codCliente))].join(", ")||"(ninguno)"}</strong>
                </div>
              )}
              {facturas.length===0&&(
                <div style={{fontSize:11,color:C.danger,marginTop:2}}>⚠ El maestro de facturas está vacío. Carga las facturas primero.</div>
              )}
            </div>
          );
        })()}

        <div style={{...s.row,marginTop:10}}>
          <div style={{flex:"1 1 200px"}}><label style={s.lbl}>Tipo Devolución *</label>
            <div style={{display:"flex",gap:16,marginTop:4}}>{["Comercial","Institucional"].map(t=><label key={t} style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer"}}><input type="radio" name="tipo" checked={form.tipoDevolucion===t} onChange={()=>sf("tipoDevolucion",t)}/>{t}</label>)}</div></div>
          <div style={{flex:"2 1 260px"}}>
            <label style={s.lbl}>Motivo de Devolución *</label>
            <select style={s.inp} value={form.codigoMotivo}
              onChange={e=>{ const m=motivos.find(x=>x.codigo===e.target.value); sf("codigoMotivo",e.target.value); sf("descripcionMotivo",m?m.descripcion:""); }}>
              <option value="">— Seleccionar motivo —</option>
              {[...motivos].sort((a,b)=>a.codigo.localeCompare(b.codigo,undefined,{numeric:true})).map(m=>(
                <option key={m.codigo} value={m.codigo}>{m.codigo} — {m.descripcion}</option>
              ))}
            </select>
          </div>
          <div style={{flex:"0 0 120px"}}><label style={s.lbl}>Nº Bultos</label><input style={s.inp} value={form.noBultos} onChange={e=>sf("noBultos",e.target.value)}/></div>
        </div>

        <div style={{...s.row,marginTop:10,alignItems:"center",gap:20}}>
          <div style={{fontWeight:"bold",fontSize:12,color:C.gray}}>Tipo de documento *:</div>
          {[["nc","Nota de Crédito"],["canje","Canje"]].map(([val,lbl])=>(
            <label key={val} style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer",fontSize:13}}>
              <input type="radio" name="nccanje" checked={val==="nc"?form.nc:form.canje} onChange={()=>setForm(f=>({...f,nc:val==="nc",canje:val==="canje"}))}/>{lbl}
            </label>
          ))}
        </div>

        <div style={{overflowX:"auto",marginTop:14}}>
          <table style={s.tbl}>
            <ProductHeader/>
            <ProductRows lineas={form.lineas} editable onChangeLine={changeLine} plotes={plotes} facturas={facturas} codigoCliente={form.codigoCliente}/>
          </table>
        </div>

        <div style={{...s.row,marginTop:12}}>
          <div style={{flex:"3 1 300px"}}><label style={s.lbl}>Observación</label><textarea style={{...s.inp,height:54,resize:"vertical"}} value={form.observacion} onChange={e=>sf("observacion",e.target.value)}/></div>
        </div>

        {submitErr&&<div style={{color:C.danger,fontSize:12,marginTop:8}}>⚠ {submitErr}</div>}
        <div style={{display:"flex",gap:10,marginTop:14,justifyContent:"flex-end"}}>
          <button style={s.bOut(C.danger)} onClick={onBack}>Cancelar</button>
          <button style={{...s.btn(C.primary),opacity:guardando?0.6:1}} onClick={submit} disabled={guardando}>{guardando?"⏳ Guardando...":"📋 Crear Nota de Devolución"}</button>
        </div>
      </div>
    </div>
  );
}

// ── NOTA DETAIL ───────────────────────────────────────────────────────────────
function NotaDetail({nota,user,setNotas,onBack,plotes,facturas=[]}) {
  // El bodeguero siempre parte desde los datos originales del RRVV (nota.form),
  // no desde una corrección intermedia anterior. Los demás roles siguen usando
  // modActual cuando existe (Inspector, Facturador necesitan ver el estado actual).
  const rol=user.role;
  const isBodeguero = isBodegueroRole(rol);
  const workForm = isBodeguero ? nota.form : (nota.modActual||nota.form);
  const [mf,setMf]=useState(cloneForm(workForm));
  const [com,setCom]=useState("");
  const [motivoRechazo,setMotivoRechazo]=useState("");
  const [showRechazo,setShowRechazo]=useState(false);

  const changeLine=useCallback((i,patch)=>setMf(f=>{ const ls=[...f.lineas]; ls[i]={...ls[i],...patch}; return{...f,lineas:ls}; }),[]);
  const push=(a)=>({accion:`${a}${com?": "+com:""}`,usuario:user.name,fecha:new Date().toLocaleString()});
  const [busy,setBusy]=useState(false);
  // Toda acción de workflow pasa por act():
  //  1. Espera a que la escritura en la base termine ANTES de salir de la pantalla
  //     (antes onBack() corría aunque la escritura fallara y el usuario creía que guardó).
  //  2. Bloqueo optimista: la actualización solo se aplica si la nota sigue en el
  //     estado que este usuario está viendo. Si otro usuario ya la movió, la base
  //     rechaza el cambio, se recarga la lista y se avisa — nadie pisa a nadie.
  //  3. busy evita el doble clic (que duplicaba entradas en el historial).
  const act=async(patch)=>{
    if(busy) return;
    setBusy(true);
    try{
      await db.notas.update(nota.id,patch,nota.estado);
      setNotas(n=>n.map(x=>x.id===nota.id?{...x,...patch}:x));
      onBack();
    }catch(e){
      if(e.message==="CONFLICT"){
        notify("⚠ Esta nota fue modificada por otro usuario mientras la revisabas. Se recargó la información — verifica el estado actual antes de continuar.","warn");
        try{ const fresh=await db.notas.get(nota.id); setNotas(n=>n.map(x=>x.id===nota.id?fresh:x)); }catch{}
        onBack();
      } else {
        notify("Error al actualizar nota: "+e.message);
      }
    }finally{ setBusy(false); }
  };

  const isBod    = isBodeguero;
  const isRRVV   = (rol==="rrvv"&&user.id===nota.asignadoA)||rol==="admin";
  const isCal    = rol==="inspector";
  const isFac    = rol==="facturador";
  const isGer    = rol==="gerente";

  const canBodCorregir= isBod && nota.estado==="en_bodega";
  const canRRVVConfirm= isRRVV && nota.estado==="corregida";
  const canCalAprobar = isCal && nota.estado==="en_calidad";
  const canFacEdit    = isFac && nota.estado==="en_facturacion";
  const canFacExportar= isFac && nota.estado==="en_facturacion";
  const canGerConfirm = isGer && nota.estado==="enviada_sap";

  const isEditing    = canBodCorregir;
  const isCalEditing = canCalAprobar;
  const isFacEditing = canFacEdit;

  const detectChanges=(orig,mod)=>{
    const ch=[];
    // ── Cabecera ──────────────────────────────────────────────────────────────
    if(orig.tipoDevolucion!==mod.tipoDevolucion) ch.push(`Tipo devolución: ${orig.tipoDevolucion||"—"}→${mod.tipoDevolucion||"—"}`);
    if(orig.codigoMotivo!==mod.codigoMotivo)     ch.push(`Motivo: ${orig.codigoMotivo||"—"}→${mod.codigoMotivo||"—"}`);
    if(orig.noBultos!==mod.noBultos)             ch.push(`Bultos: ${orig.noBultos||"—"}→${mod.noBultos||"—"}`);
    if(orig.observacion!==mod.observacion)       ch.push(`Observación modificada`);
    if(orig.nc!==mod.nc||orig.canje!==mod.canje) ch.push(`Tipo doc: ${orig.nc?"NC":orig.canje?"Canje":"—"}→${mod.nc?"NC":mod.canje?"Canje":"—"}`);
    // ── Líneas ────────────────────────────────────────────────────────────────
    orig.lineas.forEach((ol,i)=>{
      const ml=mod.lineas[i];
      if(!ol.nombre&&!ml.nombre&&!ol.codigo&&!ml.codigo) return;
      const name=ml.nombre||ol.nombre||ml.codigo||ol.codigo||`Línea ${i+1}`;
      if(ol.codigo!==ml.codigo)       ch.push(`L${i+1} código: ${ol.codigo||"—"}→${ml.codigo||"—"}`);
      if(ol.nombre!==ml.nombre)       ch.push(`L${i+1} (${name}) nombre: "${ol.nombre||"—"}"→"${ml.nombre||"—"}"`);
      if(ol.porc15!==ml.porc15)       ch.push(`L${i+1} (${name}) 15%: ${ol.porc15||"—"}→${ml.porc15||"—"}`);
      if(ol.medVital!==ml.medVital)   ch.push(`L${i+1} (${name}) med.vital: ${ol.medVital||"—"}→${ml.medVital||"—"}`);
      if(ol.cantidad!==ml.cantidad)   ch.push(`L${i+1} (${name}) cantidad: ${ol.cantidad||"—"}→${ml.cantidad||"—"}`);
      if(ol.lote!==ml.lote)           ch.push(`L${i+1} (${name}) lote: ${ol.lote||"—"}→${ml.lote||"—"}`);
      if(ol.fechaVenc!==ml.fechaVenc) ch.push(`L${i+1} (${name}) f.venc: ${fmtD(ol.fechaVenc)||"—"}→${fmtD(ml.fechaVenc)||"—"}`);
      if(ol.facturaNo!==ml.facturaNo) ch.push(`L${i+1} (${name}) factura: ${ol.facturaNo||"—"}→${ml.facturaNo||"—"}`);
    });
    return ch;
  };

  const f=nota.form;
  const dispForm=isEditing?mf:(nota.modActual||nota.form);

  // Alertas de estado — solo se muestran cuando aportan información que no aparece en otro lugar.
  // La alerta de en_bodega solo aparece si el RRVV rechazó (roja); sin rechazo no hay aviso.
  // La alerta de corregida se elimina: el panel de cambios del bodeguero ya es suficiente.
  const alertas={
    en_bodega: nota.motivoRechazo
      ? {bg:"#fef2f2",border:"#fecaca",txt:"#991b1b",jsx:<span>🔴 <strong>RRVV rechazó la corrección anterior:</strong> "{nota.motivoRechazo}". Revisa y realiza una nueva corrección o aprueba directamente.</span>}
      : null,
    corregida: null,
    en_calidad:{bg:"#f0fdf4",border:"#bbf7d0",txt:"#166534",jsx:<span>🔍 Define las cantidades de Stock y Destrucción por línea. La suma debe ser igual a la cantidad devuelta.</span>},
    en_facturacion:{bg:"#fffbeb",border:"#fde68a",txt:"#92400e",jsx:<span>💰 Verifica y corrige los números de factura por línea si es necesario. Luego <b>Exporta a SAP</b>.</span>},
    enviada_sap:{bg:"#f0fdf4",border:"#bbf7d0",txt:"#166534",jsx:<span>📤 Nota enviada a SAP. Una vez aprobada en el sistema SAP, confirma aquí para actualizar el estado.</span>},
    aprobada_sap:{bg:"#f0fdf4",border:"#bbf7d0",txt:"#166534",jsx:<span>✅ Esta nota fue aprobada en SAP. Solo lectura.</span>},
  };
  const al=alertas[nota.estado];

  const origForm=nota.form;
  const modForm=nota.modActual;

  return (
    <div style={s.page}>
      <div style={{...s.card,borderTop:`4px solid ${C.primary}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
          <div>
            <div style={{fontWeight:"bold",fontSize:16,color:C.primary}}>NOTA DE DEVOLUCIÓN — Nº {nota.ndv}</div>
            <div style={{fontSize:12,color:C.gray}}>
              Creada por: <strong>{nota.creadoPorNombre}</strong> · RRVV: <strong>{nota.rrvvNombre}</strong>
              {isBodegueroRole(user.role)&&(()=>{
                const f=nota.form;
                const facturasUsadas=new Set(f.lineas.map(l=>l.facturaNo).filter(Boolean));
                const vendedores=[...new Set(
                  facturas.filter(fc=>fc.codCliente===f.codigoCliente&&facturasUsadas.has(fc.noFactura)).map(fc=>fc.vendedor).filter(Boolean)
                )];
                return vendedores.length>0?<span style={{marginLeft:8}}>· Vendedor: <strong style={{color:C.accent}}>{vendedores.join(", ")}</strong></span>:null;
              })()}
            </div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <span style={s.bdg(nota.tipoProducto==="controlado"?C.danger:C.gray)}>{nota.tipoProducto==="controlado"?"🔒 Controlado":"📦 Normal"}</span>
            <span style={s.bdg(nota.ciudad==="quito"?C.accent:"#2563eb")}>{nota.ciudad==="quito"?"🏔️ Quito":"🌴 Guayaquil"}</span>
            <span style={s.bdg(STC[nota.estado]||C.gray)}>{STL[nota.estado]||nota.estado}</span>
          </div>
        </div>

        {al&&<div style={{background:al.bg,border:`1px solid ${al.border}`,borderRadius:6,padding:10,marginBottom:12,fontSize:12,color:al.txt}}>{al.jsx}</div>}

        {canRRVVConfirm&&modForm&&(
          <div style={{background:"#f0f4ff",border:`1px solid #c7d2fe`,borderRadius:8,padding:14,marginBottom:14}}>
            <div style={{fontWeight:"bold",color:"#3730a3",fontSize:13,marginBottom:10}}>🔄 Cambios realizados por el bodeguero:</div>
            {(()=>{
              const changes=detectChanges(origForm,modForm);
              return changes.length>0
                ? changes.map((c,i)=><div key={i} style={{fontSize:12,color:"#1e40af",marginBottom:4}}>• {c}</div>)
                : <div style={{fontSize:12,color:C.gray}}>Sin cambios en materiales. Posibles ajustes en otros campos.</div>;
            })()}
          </div>
        )}

        <div style={{...s.row,background:"#f9fafb",padding:10,borderRadius:6,marginBottom:12,fontSize:12,gap:14,flexWrap:"wrap"}}>
          {[["Fecha",fmtD(f.fecha)],["Cliente",f.nombreCliente],["Cód.",f.codigoCliente],["Tipo",f.tipoDevolucion],["Motivo",`${f.codigoMotivo} – ${f.descripcionMotivo}`],["Bultos",f.noBultos]].map(([k,v])=>(
            <div key={k}><strong>{k}:</strong> {v||"—"}</div>
          ))}
          {f.nc&&<span style={s.bdg(C.accent)}>Nota de Crédito</span>}
          {f.canje&&<span style={s.bdg(C.purple)}>Canje</span>}
        </div>

        <div style={{overflowX:"auto"}}>
          <table style={s.tbl}>
            <ProductHeader calEditable={isCalEditing}/>
            <ProductRows
              lineas={isCalEditing?mf.lineas:isFacEditing?mf.lineas:dispForm.lineas}
              editable={isEditing} calEditable={isCalEditing} facEditable={isFacEditing}
              onChangeLine={changeLine} plotes={plotes}
              facturas={facturas} codigoCliente={f.codigoCliente}/>
          </table>
        </div>

        {f.observacion&&<div style={{marginTop:8,fontSize:12}}><strong>Observación:</strong> {f.observacion}</div>}

        <div style={{marginTop:14}}>
          <div style={{fontWeight:"bold",fontSize:13,marginBottom:6}}>📋 Historial</div>
          {nota.historial.map((h,i)=>(
            <div key={i} style={{fontSize:12,color:C.gray,borderLeft:`3px solid ${C.primary}`,paddingLeft:8,marginBottom:4}}>
              <strong>{h.usuario}</strong> — {h.accion} <span style={{float:"right",fontSize:11}}>{h.fecha}</span>
            </div>
          ))}
        </div>

        <div style={{marginTop:14,padding:12,background:"#f9fafb",borderRadius:6}}>
          {!showRechazo&&(
            <>
              <label style={s.lbl}>Comentario (opcional)</label>
              <input style={{...s.inp,marginBottom:10}} value={com} onChange={e=>setCom(e.target.value)} placeholder="Agregar comentario..."/>
            </>
          )}
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            <button style={s.bOut()} onClick={onBack}>← Volver</button>

            {canBodCorregir&&(()=>{
              const changes=detectChanges(nota.form,mf);
              const haycambios=changes.length>0;
              return (
                <>
                  {haycambios&&(
                    <div style={{fontSize:12,color:C.warning,background:"#fffbeb",border:`1px solid #fde68a`,borderRadius:6,padding:"6px 10px"}}>
                      ✏️ Hay cambios — debes enviar al RRVV para su confirmación antes de aprobar.
                    </div>
                  )}
                  <button style={{...s.btn(C.warning),opacity:busy?0.6:1}} disabled={busy} onClick={()=>{
                    const log=haycambios
                      ? `Bodeguero corrigió → pendiente confirmación RRVV | ${changes.join(" | ")}`
                      : "Bodeguero corrigió → pendiente confirmación RRVV (sin cambios en materiales)";
                    act({estado:"corregida",modActual:cloneForm(mf),motivoRechazo:null,historial:[...nota.historial,push(log)]});
                  }}>✏️ Corregir → Enviar a RRVV</button>
                  {!haycambios&&(
                    <button style={{...s.btn(STC.en_bodega),opacity:busy?0.6:1}} disabled={busy} onClick={()=>{
                      act({estado:"en_calidad",modActual:cloneForm(mf),motivoRechazo:null,historial:[...nota.historial,push("Bodeguero aprobó → Inspector de Calidad")]});
                    }}>✅ Aprobar → Calidad</button>
                  )}
                </>
              );
            })()}

            {canRRVVConfirm&&!showRechazo&&(
              <>
                <button style={{...s.btn(C.success),opacity:busy?0.6:1}} disabled={busy} onClick={()=>{
                  act({estado:"en_bodega",historial:[...nota.historial,push("RRVV confirmó la corrección → regresa a bodega")]});
                }}>✔ Confirmar corrección</button>
                <button style={s.btn(C.danger)} onClick={()=>setShowRechazo(true)}>✖ Rechazar corrección</button>
              </>
            )}

            {canRRVVConfirm&&showRechazo&&(
              <div style={{width:"100%",background:"#fef2f2",border:`1px solid #fecaca`,borderRadius:8,padding:12,marginTop:4}}>
                <div style={{fontWeight:"bold",color:C.danger,marginBottom:8,fontSize:13}}>✖ Indicar motivo de rechazo</div>
                <textarea style={{...s.inp,height:70,resize:"vertical",marginBottom:10}} value={motivoRechazo} onChange={e=>setMotivoRechazo(e.target.value)} placeholder="Describe por qué rechazas esta corrección..."/>
                <div style={{display:"flex",gap:8}}>
                  <button style={{...s.btn(C.danger),opacity:busy?0.6:1}} disabled={busy} onClick={()=>{
                    if(!motivoRechazo.trim()) return notify("Debes indicar el motivo del rechazo.","warn");
                    act({estado:"en_bodega",motivoRechazo:motivoRechazo.trim(),modActual:null,historial:[...nota.historial,{accion:`RRVV rechazó corrección: ${motivoRechazo.trim()}`,usuario:user.name,fecha:new Date().toLocaleString()}]});
                  }}>Enviar rechazo</button>
                  <button style={s.bOut()} onClick={()=>setShowRechazo(false)}>Cancelar</button>
                </div>
              </div>
            )}

            {canCalAprobar&&<button disabled={busy} style={{...s.btn(STC.en_calidad),opacity:busy?0.6:1}} onClick={()=>{
              const errores=[];
              mf.lineas.forEach((l,i)=>{
                if(!l.nombre&&!l.codigo) return;
                const cant=parseFloat(l.cantidad)||0;
                const sum=(parseFloat(l.cantStock)||0)+(parseFloat(l.cantDestruccion)||0);
                if(sum!==cant) errores.push(`Línea ${i+1} (${l.nombre||l.codigo}): ${sum}≠${cant}`);
              });
              if(errores.length>0){ notify(`❌ Und. Stock / Und. Destruc. deben cuadrar:\n${errores.join("\n")}`,"warn"); return; }
              act({estado:"en_facturacion",modActual:cloneForm(mf),historial:[...nota.historial,push("Inspector aprobó con destinos → Facturador")]});
            }}>✅ Aprobar → Facturador</button>}

            {canFacExportar&&<button disabled={busy} style={{...s.btn(STC.en_facturacion),opacity:busy?0.6:1}} onClick={()=>{
              act({estado:"enviada_sap",registroFinal:cloneForm(mf),modActual:cloneForm(mf),historial:[...nota.historial,push("Facturador exportó a SAP — Excel generado")]});
            }}>📤 Exportar a SAP</button>}

            {canGerConfirm&&<button disabled={busy} style={{...s.btn(STC.aprobada_sap),opacity:busy?0.6:1}} onClick={()=>{
              act({estado:"aprobada_sap",historial:[...nota.historial,push("Gerente confirmó aprobación en SAP ✓")]});
            }}>✅ Confirmar Aprobación en SAP</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── DATOS MAESTROS ────────────────────────────────────────────────────────────
// Esquema de cada maestro: cols = encabezados del CSV (en orden); fields = [clave, etiqueta, placeholder]
// alineados 1:1 con cols; keyOf = clave para deduplicar; dateField = campo fecha (se normaliza a ISO).
// Carga SheetJS dinámicamente desde CDN (funciona en StackBlitz, Vercel y el artifact de Claude).
// En StackBlitz/Vercel puedes también hacer `npm install xlsx` y el import directo.
const loadXLSX = () => new Promise((resolve, reject) => {
  if (window.XLSX) { resolve(window.XLSX); return; }
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  s.onload = () => resolve(window.XLSX);
  s.onerror = () => reject(new Error("No se pudo cargar SheetJS"));
  document.head.appendChild(s);
});

const MASTERS={
  motivos:{
    label:"📋 Motivos",
    cols:["CODIGO_MOTIVO","DESCRIPCION_MOTIVO"],
    fields:[["codigo","Código *","DEF"],["descripcion","Descripción *","Descripción"]],
    keyOf:(o)=>o.codigo,
    example:[["VEN","Vencimiento"],["MAL","Mal estado"]],
  },
  plotes:{
    label:"🏷️ Producto-Lote",
    cols:["LOTE","CODIGO","NOMBRE_MATERIAL","FECHA_CADUCIDAD","TEMP_ALMACENAMIENTO"],
    fields:[["lote","Lote *","L2024A"],["codigo","Código *","FK-001"],["nombre","Nombre Material *","Aminoácidos 500ml"],["fechaCad","Fecha Caducidad *",""],["tempAlm","Temp. Almacenamiento","15–25 °C"]],
    keyOf:(o)=>`${o.lote}|${o.codigo}`,
    dateField:"fechaCad",
    example:[["L2024A","FK-001","Aminoácidos 500ml","2026-07-01","15–25 °C"],["L2025A","FK-001","Aminoácidos 500ml","2027-02-28","15–25 °C"]],
  },
  facturas:{
    label:"🧾 Facturas",
    cols:["COD_CLIENTE","NOMBRE_CLIENTE","NO_FACTURA","COD_MATERIAL","NOMBRE_MATERIAL","LOTE","CANTIDAD","VALOR","VENDEDOR","FACTURADOR"],
    fields:[
      ["codCliente","Cód. Cliente *","CLI001"],
      ["nombreCliente","Nombre Cliente *","Clínica Santa María"],
      ["noFactura","No. Factura *","F-2024-001"],
      ["codMaterial","Cód. Material *","FK-001"],
      ["nombre","Nombre Material *","Aminoácidos 500ml"],
      ["lote","Lote","L2024A"],
      ["cantidad","Cantidad *","100"],
      ["valor","Valor *","1500.00"],
      ["vendedor","Vendedor *","Juan Pérez"],
      ["facturador","Facturador *","María López"],
    ],
    keyOf:(o)=>`${o.noFactura}|${o.codCliente}|${o.codMaterial}|${o.lote||""}`,
    example:[
      ["CLI001","Clínica Santa María","F-2024-001","FK-001","Aminoácidos 500ml","L2024A","100","1500.00","Carlos Pérez","Luis Facturador"],
      ["CLI001","Clínica Santa María","F-2024-001","FK-002","Glucosa 5% 250ml","L2024B","50","800.00","Carlos Pérez","Luis Facturador"],
    ],
  },
};

function DatosMaestros({motivos,setMotivos,plotes,setPlotes,facturas,setFacturas}) {
  const stores={ motivos:[motivos,setMotivos], plotes:[plotes,setPlotes], facturas:[facturas,setFacturas] };
  const [tab,setTab]=useState("motivos");
  const [modal,setModal]=useState(null); const [form,setForm]=useState({}); const [err,setErr]=useState("");
  const [importResult,setImportResult]=useState(null);
  const [importing,setImporting]=useState(null); // {fase,pct,total,done} mientras trabaja
  const [confirmDel,setConfirmDel]=useState(null); // {id, tabName, label}
  const [confirmDelAll,setConfirmDelAll]=useState(false);
  const M=MASTERS[tab]; const data=stores[tab][0];

  const open=(item=null)=>{ setModal({item}); setForm(item?{...item}:{}); setErr(""); };
  const close=()=>setModal(null);

  const save=async()=>{
    const Mm=MASTERS[tab]; const setD=stores[tab][1]; const d=stores[tab][0];
    for(const [fk] of Mm.fields){ if(fk!==Mm.dateField&&!String(form[fk]||"").trim()) return setErr("Completa todos los campos."); }
    const rec={}; Mm.fields.forEach(([fk])=>{ rec[fk]=String(form[fk]||"").trim(); });
    if(Mm.dateField) rec[Mm.dateField]=toISO(rec[Mm.dateField]);
    const k=Mm.keyOf(rec);
    if(d.find(x=>Mm.keyOf(x)===k && x.id!==modal.item?.id)) return setErr("Ese registro ya existe.");
    try{
      if(modal.item){
        await db[tab].update(modal.item.id,rec);
        setD(arr=>arr.map(x=>x.id===modal.item.id?{...x,...rec}:x));
      } else {
        const inserted=await db[tab].insert(rec);
        setD(arr=>[...arr,inserted]);
      }
      close();
    }catch(e){ setErr("Error al guardar: "+e.message); }
  };
  const del=(id,tabName)=>{
    const item=stores[tabName||tab][0].find(x=>x.id===id);
    const label=item?(item.codigo||item.lote||item.noFactura||item.nombre||String(id)):"";
    setConfirmDel({id,tabName:tabName||tab,label});
  };
  const doConfirmDel=async()=>{
    if(!confirmDel) return;
    try{
      await db[confirmDel.tabName].delete(confirmDel.id);
      stores[confirmDel.tabName][1](arr=>arr.filter(x=>x.id!==confirmDel.id));
      setConfirmDel(null);
    }catch(e){ notify("Error al eliminar: "+e.message); }
  };
  const doConfirmDelAll=async()=>{
    try{
      await db[tab].deleteAll();
      stores[tab][1]([]); setConfirmDelAll(false); setImportResult(null);
    }catch(e){ notify("Error al eliminar todos: "+e.message); }
  };

  // Descarga una plantilla .xlsx (Excel real) con encabezados + filas de ejemplo, lista para llenar y subir.
  const downloadTemplate=async()=>{
    try{
      const XL=await loadXLSX();
      const Mm=MASTERS[tab];
      const ws=XL.utils.aoa_to_sheet([Mm.cols, ...Mm.example]);
      ws["!cols"]=Mm.cols.map(c=>({wch:Math.max(18,c.length+2)}));
      const wb=XL.utils.book_new();
      XL.utils.book_append_sheet(wb,ws,"Plantilla");
      XL.writeFile(wb,`Plantilla_${tab}.xlsx`);
    }catch(e){ notify("Error al descargar plantilla: "+e.message); }
  };

  // Procesa filas (array de arrays, fila 0 = encabezados) y carga en lotes reportando progreso.
  const processRows=async(rowsAoa,importTab)=>{
    const Mm=MASTERS[importTab];
    if(!rowsAoa||rowsAoa.length<2){ setImportResult({ok:0,errors:["Archivo vacío o sin filas de datos."]}); return; }
    const header=rowsAoa[0].map(h=>String(h).replace(/"/g,"").trim().toUpperCase());
    const idx=Mm.cols.map(c=>header.indexOf(c));
    const missing=Mm.cols.filter((c,i)=>idx[i]===-1);
    if(missing.length){ setImportResult({ok:0,errors:[`Columnas faltantes: ${missing.join(", ")}. La primera fila debe tener exactamente: ${Mm.cols.join(", ")}. (Usa la plantilla descargada.)`]}); return; }
    const setD=stores[importTab][1]; const d=stores[importTab][0];
    const seen=new Set(d.map(x=>Mm.keyOf(x)));
    const errors=[]; const newItems=[];
    const dataRows=rowsAoa.slice(1).filter(cols=>cols&&!cols.every(c=>String(c==null?"":c).trim()===""));
    const total=dataRows.length;
    // ── Fase 1: validar filas ─────────────────────────────────────────────────
    setImporting({fase:"Validando filas…",pct:0,total,done:0});
    for(let li=0;li<dataRows.length;li++){
      const cols=dataRows[li];
      const rec={}; Mm.fields.forEach(([fk],i)=>{ rec[fk]=String(cols[idx[i]]==null?"":cols[idx[i]]).replace(/"/g,"").trim(); });
      const requiredFields=Mm.fields.filter(([,label])=>label.includes(" *")).map(([fk])=>fk);
      const missingFields=requiredFields.filter(fk=>!rec[fk]);
      if(missingFields.length){ errors.push(`Fila ${li+2}: campos obligatorios vacíos: ${missingFields.join(", ")}.`); continue; }
      if(Mm.dateField){ const iso=toISO(rec[Mm.dateField]); if(!/^\d{4}-\d{2}-\d{2}$/.test(iso)){ errors.push(`Fila ${li+2}: fecha inválida "${rec[Mm.dateField]}" (usa AAAA-MM-DD o DD/MM/AAAA).`); continue; } rec[Mm.dateField]=iso; }
      const k=Mm.keyOf(rec);
      if(seen.has(k)){ errors.push(`Fila ${li+2}: duplicado (${k}).`); continue; }
      seen.add(k); newItems.push({...rec});
      // Actualizar progreso de validación cada 100 filas para no saturar renders
      if(li%100===0) setImporting({fase:"Validando filas…",pct:Math.round((li/total)*50),total,done:li});
    }
    // ── Fase 2: insertar en lotes de 500 ─────────────────────────────────────
    const BATCH=500; let inserted=0;
    for(let i=0;i<newItems.length;i+=BATCH){
      const lote=newItems.slice(i,i+BATCH);
      setImporting({fase:`Guardando en base de datos… (${Math.min(i+BATCH,newItems.length)} de ${newItems.length})`,pct:50+Math.round((i/newItems.length)*50),total,done:inserted});
      try{
        const saved=await db[importTab].insertMany(lote);
        setD(arr=>[...arr,...(saved||[])]);
        inserted+=lote.length;
      }catch(e){ errors.push(`Lote ${Math.floor(i/BATCH)+1}: error al guardar — ${e.message}`); }
    }
    setImporting(null);
    setImportResult({ok:inserted,errors,total});
  };

  // Acepta Excel (.xlsx/.xls) y CSV/TXT (coma, ; o tabulación).
  const handleFile=async(e)=>{
    const file=e.target.files[0]; if(!file) return;
    const importTab=tab; // capturar pestaña activa al iniciar el import
    setImportResult(null);
    const isExcel=/\.(xlsx|xls)$/i.test(file.name);
    const reader=new FileReader();
    reader.onload=async(ev)=>{
      try{
        if(isExcel){
          const XL=await loadXLSX();
          const wb=XL.read(new Uint8Array(ev.target.result),{type:"array"});
          const ws=wb.Sheets[wb.SheetNames[0]];
          await processRows(XL.utils.sheet_to_json(ws,{header:1,raw:false,defval:""}),importTab);
        } else {
          const text=String(ev.target.result).replace(/^\uFEFF/,"");
          const lines=text.split(/\r?\n/).filter(l=>l.trim());
          if(lines.length<2){ setImportResult({ok:0,errors:["Archivo vacío o sin filas de datos."]}); return; }
          const delim=detectDelim(lines[0]);
          await processRows(lines.map(l=>parseLine(l,delim)),importTab);
        }
      }catch(ex){ setImportResult({ok:0,errors:["Error al leer el archivo: "+ex.message]}); }
    };
    if(isExcel) reader.readAsArrayBuffer(file); else reader.readAsText(file,"UTF-8");
    e.target.value="";
  };

  return (
    <div style={s.page}>
      <div style={{...s.card,borderTop:`4px solid ${C.primary}`}}>
        <div style={s.title}>🗂️ Datos Maestros</div>
        <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
          {Object.entries(MASTERS).map(([k,v])=><button key={k} style={s.btn(tab===k?C.primary:"#e5e7eb")} onClick={()=>{setTab(k);setImportResult(null);}}><span style={{color:tab===k?"#fff":C.gray}}>{v.label} ({stores[k][0].length})</span></button>)}
        </div>
        <div style={{background:"#f0fdf4",border:`1px solid #bbf7d0`,borderRadius:8,padding:14,marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
            <div><div style={{fontWeight:"bold",color:"#166534",fontSize:13}}>📥 Carga masiva desde Excel / CSV</div>
            <div style={{fontSize:11,color:"#166534"}}>Descarga la plantilla, reemplaza las filas de ejemplo con tus datos y súbela. Acepta Excel (.xlsx) y CSV.</div></div>
            <div style={{display:"flex",gap:8}}>
              <button style={s.btn("#166534")} onClick={downloadTemplate} disabled={!!importing}>⬇️ Descargar plantilla</button>
              <label style={{...s.btn(importing?"#9ca3af":"#0d9488"),cursor:importing?"not-allowed":"pointer",display:"inline-flex",alignItems:"center",opacity:importing?0.6:1}}>
                {importing?"⏳ Importando...":"📤 Subir archivo"}
                <input type="file" accept=".xlsx,.xls,.csv,.txt" style={{display:"none"}} onChange={handleFile} disabled={!!importing}/>
              </label>
              {data.length>0&&<button style={s.btn(C.danger)} onClick={()=>setConfirmDelAll(true)}>🗑️ Eliminar todos</button>}
            </div>
          </div>
          {importing&&(
            <div style={{marginTop:12,background:"#eff6ff",border:`1px solid #bfdbfe`,borderRadius:8,padding:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <span style={{fontSize:12,fontWeight:"bold",color:C.primary}}>⏳ {importing.fase}</span>
                <span style={{fontSize:11,color:C.gray}}>{importing.pct}%</span>
              </div>
              <div style={{background:"#dbeafe",borderRadius:99,height:8,overflow:"hidden"}}>
                <div style={{height:"100%",borderRadius:99,background:C.primary,width:`${importing.pct}%`,transition:"width .25s ease"}}/>
              </div>
              {importing.total>0&&<div style={{fontSize:11,color:C.gray,marginTop:4}}>{importing.done} de {importing.total} filas procesadas</div>}
            </div>
          )}
          {!importing&&importResult&&(
            <div style={{marginTop:10,background:importResult.ok>0?"#f0fdf4":"#fef2f2",border:`1px solid ${importResult.ok>0?"#bbf7d0":"#fecaca"}`,borderRadius:6,padding:10}}>
              {importResult.ok>0&&<div style={{color:"#166534",fontWeight:"bold",fontSize:13,marginBottom:4}}>✅ {importResult.ok} de {importResult.total||"?"} filas importadas correctamente.</div>}
              {importResult.errors.map((e,i)=><div key={i} style={{fontSize:11,color:C.danger}}>• {e}</div>)}
            </div>
          )}
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontWeight:"bold",color:C.primary}}>{M.label} — {data.length}</div>
          <button style={s.btn()} onClick={()=>open()}>+ Nuevo manual</button>
        </div>
        <div style={{overflowX:"auto"}}>
          <table style={s.tbl}>
            <thead><tr>{M.fields.map(([fk,label])=><th key={fk} style={s.th}>{label.replace(" *","")}</th>)}<th style={s.th}>Acciones</th></tr></thead>
            <tbody>{data.map((item,i)=>(
              <tr key={item.id} style={{background:i%2===0?"#f9fafb":"#fff"}}>
                {M.fields.map(([fk],j)=>(
                  <td key={fk} style={s.td}>{j===0?<code style={{background:"#f3f4f6",padding:"2px 6px",borderRadius:3,fontWeight:"bold"}}>{item[fk]}</code>:(fk===M.dateField?fmtD(item[fk]):item[fk])}</td>
                ))}
                <td style={s.td}><div style={{display:"flex",gap:6}}><button style={s.btn(C.accent,true)} onClick={()=>open(item)}>Editar</button><button style={s.btn(C.danger,true)} onClick={()=>del(item.id,tab)}>Eliminar</button></div></td>
              </tr>
            ))}</tbody>
          </table>
          {data.length===0&&<div style={{textAlign:"center",padding:24,color:C.gray}}>Sin registros. Usa "+ Nuevo manual" o la carga masiva.</div>}
        </div>
      </div>
      {confirmDelAll&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}}>
          <div style={{background:"#fff",borderRadius:10,padding:28,width:360,boxShadow:"0 8px 32px rgba(0,0,0,.25)",textAlign:"center"}}>
            <div style={{fontSize:36,marginBottom:8}}>⚠️</div>
            <div style={{fontWeight:"bold",fontSize:15,color:C.danger,marginBottom:8}}>¿Eliminar TODOS los registros?</div>
            <div style={{fontSize:13,color:C.gray,marginBottom:20}}>
              Se eliminarán los <strong>{data.length}</strong> registros de <strong>{M.label}</strong>.<br/>Esta acción no se puede deshacer.
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <button style={s.bOut()} onClick={()=>setConfirmDelAll(false)}>Cancelar</button>
              <button style={s.btn(C.danger)} onClick={doConfirmDelAll}>Sí, eliminar todos</button>
            </div>
          </div>
        </div>
      )}
      {confirmDel&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:300}}>
          <div style={{background:"#fff",borderRadius:10,padding:28,width:340,boxShadow:"0 8px 32px rgba(0,0,0,.25)",textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:8}}>🗑️</div>
            <div style={{fontWeight:"bold",fontSize:15,color:C.primary,marginBottom:8}}>¿Eliminar registro?</div>
            <div style={{fontSize:13,color:C.gray,marginBottom:20}}>
              Se eliminará <strong style={{color:C.danger}}>{confirmDel.label}</strong>.<br/>Esta acción no se puede deshacer.
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <button style={s.bOut()} onClick={()=>setConfirmDel(null)}>Cancelar</button>
              <button style={s.btn(C.danger)} onClick={doConfirmDel}>Sí, eliminar</button>
            </div>
          </div>
        </div>
      )}
      {modal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100}}>
          <div style={{background:"#fff",borderRadius:8,padding:24,width:400,boxShadow:"0 4px 20px rgba(0,0,0,.2)"}}>
            <div style={{fontWeight:"bold",fontSize:15,color:C.primary,marginBottom:14}}>{modal.item?"Editar":"Nuevo"} — {M.label}</div>
            {M.fields.map(([fk,label,ph])=>(
              <div key={fk}><label style={s.lbl}>{label}</label>
                <input style={{...s.inp,marginBottom:10}} type={fk===M.dateField?"date":"text"} value={form[fk]||""} onChange={e=>setForm(f=>({...f,[fk]:e.target.value}))} placeholder={fk===M.dateField?"":ph}/></div>
            ))}
            {err&&<div style={{color:C.danger,fontSize:12,marginBottom:8}}>{err}</div>}
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}><button style={s.bOut()} onClick={close}>Cancelar</button><button style={s.btn()} onClick={save}>💾 Guardar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── USER MANAGER ──────────────────────────────────────────────────────────────
// El administrador crea usuarios asignando una contraseña inicial que el usuario
// está obligado a cambiar en su primer ingreso. El administrador NUNCA puede ver
// contraseñas: solo puede resetearlas (asignando una nueva temporal) o
// activar/desactivar el acceso. Toda acción se verifica en el servidor con las
// credenciales del propio administrador (fn_admin_* en Supabase).
function UserManager({users,setUsers,currentUser}) {
  const [showNew,setShowNew]=useState(false);
  const [nf,setNf]=useState({username:"",name:"",email:"",role:"rrvv",password:"",password2:""});
  const [nErr,setNErr]=useState("");
  const [showEdit,setShowEdit]=useState(false);
  const [editTarget,setEditTarget]=useState(null); const [eForm,setEForm]=useState({});
  const [showReset,setShowReset]=useState(null); // usuario objetivo del reset
  const [rp,setRp]=useState(""); const [rp2,setRp2]=useState(""); const [rErr,setRErr]=useState("");
  const [confirmDel,setConfirmDel]=useState(null); // usuario a eliminar
  const [busy,setBusy]=useState(false);
  const [toast,setToast]=useState(null);
  const toast2=(msg,type="success")=>{setToast({msg,type});setTimeout(()=>setToast(null),5000);};
  // Credenciales del admin en sesión (solo en memoria, nunca persistidas):
  // el servidor las exige para autorizar cada acción administrativa.
  const adminCreds={username:currentUser.username,password:currentUser._pw};

  const createUser=async()=>{
    if(busy) return;
    const username=nf.username.trim();
    if(!username||!nf.name.trim())        return setNErr("Usuario y nombre son obligatorios.");
    if(!/^[a-zA-Z0-9._-]{3,30}$/.test(username)) return setNErr("Usuario: 3–30 caracteres, solo letras, números, punto, guion o guion bajo.");
    if(nf.password.length<8)              return setNErr("La contraseña inicial debe tener al menos 8 caracteres.");
    if(nf.password!==nf.password2)        return setNErr("Las contraseñas no coinciden.");
    if(users.find(x=>x.username===username)) return setNErr("Ese usuario ya existe.");
    setNErr(""); setBusy(true);
    try{
      const nuevo=await db.users.create(adminCreds,{username,password:nf.password,role:nf.role,name:nf.name.trim(),email:nf.email.trim()});
      setUsers(us=>[...us,nuevo]);
      setShowNew(false); setNf({username:"",name:"",email:"",role:"rrvv",password:"",password2:""});
      toast2(`✅ Usuario "${username}" creado. Deberá cambiar su contraseña en el primer ingreso.`);
    }catch(e){ setNErr("Error: "+e.message); }
    finally{ setBusy(false); }
  };

  const openEdit=(u)=>{ setEditTarget(u); setEForm({name:u.name,email:u.email||"",role:u.role}); setShowEdit(true); };
  const saveEdit=async()=>{
    if(busy) return;
    setBusy(true);
    try{
      const upd=await db.users.adminUpdate(adminCreds,editTarget.id,eForm);
      setUsers(us=>us.map(u=>u.id===editTarget.id?upd:u));
      setShowEdit(false); toast2("Usuario actualizado.");
    }catch(e){ toast2("Error: "+e.message,"error"); }
    finally{ setBusy(false); }
  };

  const doReset=async()=>{
    if(busy) return;
    if(rp.length<8)  return setRErr("La contraseña temporal debe tener al menos 8 caracteres.");
    if(rp!==rp2)     return setRErr("Las contraseñas no coinciden.");
    setRErr(""); setBusy(true);
    try{
      await db.users.resetPassword(adminCreds,showReset.id,rp);
      setUsers(us=>us.map(u=>u.id===showReset.id?{...u,mustChangePassword:true}:u));
      toast2(`🔑 Contraseña temporal asignada a "${showReset.username}". Deberá cambiarla al ingresar.`);
      setShowReset(null); setRp(""); setRp2("");
    }catch(e){ setRErr("Error: "+e.message); }
    finally{ setBusy(false); }
  };

  const toggle=async(u)=>{
    if(busy||u.id===currentUser.id) return;
    setBusy(true);
    try{
      await db.users.setActive(adminCreds,u.id,!u.active);
      setUsers(us=>us.map(x=>x.id===u.id?{...x,active:!x.active}:x));
      toast2(u.active?`⛔ Acceso desactivado para "${u.username}".`:`✅ Acceso reactivado para "${u.username}".`);
    }catch(e){ toast2("Error: "+e.message,"error"); }
    finally{ setBusy(false); }
  };

  const doDelete=async()=>{
    if(busy||!confirmDel) return;
    setBusy(true);
    try{
      await db.users.deleteUser(adminCreds,confirmDel.id);
      setUsers(us=>us.filter(x=>x.id!==confirmDel.id));
      toast2(`🗑️ Usuario "${confirmDel.username}" eliminado.`);
      setConfirmDel(null);
    }catch(e){ toast2("Error: "+e.message,"error"); }
    finally{ setBusy(false); }
  };

  return (
    <div style={s.page}>
      {toast&&<div style={{position:"fixed",top:16,right:16,zIndex:200,background:toast.type==="error"?C.danger:C.success,color:"#fff",padding:"10px 18px",borderRadius:8,maxWidth:400,fontSize:13}}>{toast.msg}</div>}
      <div style={s.card}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={s.title}>👥 Usuarios</div>
          <button style={s.btn()} onClick={()=>{setShowNew(true);setNErr("");}}>+ Crear usuario</button>
        </div>
        <div style={{background:"#eff6ff",border:`1px solid #bfdbfe`,borderRadius:6,padding:10,marginBottom:14,fontSize:12,color:"#1e40af"}}>
          🔒 Las contraseñas se guardan cifradas y <strong>nadie puede verlas</strong>, ni siquiera el administrador.
          Puedes asignar una contraseña temporal con "Resetear clave": el usuario estará obligado a cambiarla en su siguiente ingreso.
        </div>
        <div style={{...s.row,marginBottom:14}}>{ROLES.map(r=><div key={r.value} style={{background:"#f9fafb",borderRadius:6,padding:"6px 10px",borderLeft:`4px solid ${r.color}`,flex:"1 1 110px"}}><div style={{fontWeight:"bold",color:r.color,fontSize:11}}>{r.label}</div><div style={{color:C.gray,fontSize:10}}>{r.desc}</div></div>)}</div>
        <table style={s.tbl}>
          <thead><tr>{["Nombre","Usuario","Rol","Estado","Clave","Acciones"].map(h=><th key={h} style={s.th}>{h}</th>)}</tr></thead>
          <tbody>{users.map(u=>(
            <tr key={u.id} style={{opacity:u.active?1:.55}}>
              <td style={s.td}><strong>{u.name}</strong></td>
              <td style={s.td}><code style={{background:"#f3f4f6",padding:"2px 6px",borderRadius:3}}>{u.username}</code></td>
              <td style={s.td}><span style={s.bdg(rc(u.role))}>{ROLES.find(r=>r.value===u.role)?.label}</span></td>
              <td style={s.td}><span style={s.bdg(u.active?C.success:C.gray)}>{u.active?"Activo":"Inactivo"}</span></td>
              <td style={s.td}>{u.mustChangePassword?<span style={s.bdg(C.warning)}>Temporal — pend. cambio</span>:<span style={s.bdg(C.success)}>Definida por el usuario</span>}</td>
              <td style={s.td}><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                <button style={s.btn(C.accent,true)} onClick={()=>openEdit(u)}>Editar</button>
                <button style={s.btn(C.warning,true)} onClick={()=>{setShowReset(u);setRp("");setRp2("");setRErr("");}}>Resetear clave</button>
                {u.id!==currentUser.id&&<button style={s.btn(u.active?C.danger:C.success,true)} onClick={()=>toggle(u)}>{u.active?"Desactivar":"Activar"}</button>}
                {u.id!==currentUser.id&&<button style={s.btn(C.danger,true)} onClick={()=>setConfirmDel(u)}>Eliminar</button>}
              </div></td>
            </tr>
          ))}</tbody>
        </table>
      </div>

      {showNew&&(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100}}>
        <div style={{background:"#fff",borderRadius:8,padding:24,width:420,boxShadow:"0 4px 20px rgba(0,0,0,.2)"}}>
          <div style={{fontWeight:"bold",fontSize:15,color:C.primary,marginBottom:12}}>👤 Crear Usuario</div>
          <div style={s.row}>
            <div style={{flex:"1 1 160px"}}><label style={s.lbl}>Usuario (login) *</label>
              <input style={{...s.inp,marginBottom:10}} value={nf.username} autoComplete="off" onChange={e=>setNf(f=>({...f,username:e.target.value}))}/></div>
            <div style={{flex:"1 1 160px"}}><label style={s.lbl}>Nombre completo *</label>
              <input style={{...s.inp,marginBottom:10}} value={nf.name} onChange={e=>setNf(f=>({...f,name:e.target.value}))}/></div>
          </div>
          <label style={s.lbl}>Correo</label>
          <input style={{...s.inp,marginBottom:10}} type="email" value={nf.email} onChange={e=>setNf(f=>({...f,email:e.target.value}))}/>
          <label style={s.lbl}>Rol *</label>
          <select style={{...s.inp,marginBottom:10}} value={nf.role} onChange={e=>setNf(f=>({...f,role:e.target.value}))}>{ROLES.map(r=><option key={r.value} value={r.value}>{r.label}</option>)}</select>
          <div style={s.row}>
            <div style={{flex:"1 1 160px"}}><label style={s.lbl}>Contraseña inicial * (mín. 8)</label>
              <input style={{...s.inp,marginBottom:10}} type="password" autoComplete="new-password" value={nf.password} onChange={e=>setNf(f=>({...f,password:e.target.value}))}/></div>
            <div style={{flex:"1 1 160px"}}><label style={s.lbl}>Confirmar contraseña *</label>
              <input style={{...s.inp,marginBottom:10}} type="password" autoComplete="new-password" value={nf.password2} onChange={e=>setNf(f=>({...f,password2:e.target.value}))}/></div>
          </div>
          <div style={{fontSize:11,color:C.gray,marginBottom:10}}>ℹ️ Entrega esta contraseña inicial al usuario por un medio seguro. El sistema le exigirá cambiarla en su primer ingreso y quedará cifrada: nadie podrá verla.</div>
          {nErr&&<div style={{color:C.danger,fontSize:12,marginBottom:8}}>{nErr}</div>}
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <button style={s.bOut()} onClick={()=>setShowNew(false)}>Cancelar</button>
            <button style={{...s.btn(C.success),opacity:busy?0.6:1}} onClick={createUser} disabled={busy}>{busy?"⏳ Creando...":"✅ Crear usuario"}</button>
          </div>
        </div>
      </div>)}

      {showEdit&&(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100}}>
        <div style={{background:"#fff",borderRadius:8,padding:24,width:380,boxShadow:"0 4px 20px rgba(0,0,0,.2)"}}>
          <div style={{fontWeight:"bold",fontSize:15,color:C.primary,marginBottom:14}}>Editar Usuario — <code>{editTarget?.username}</code></div>
          {[["name","Nombre"],["email","Correo"]].map(([k,l])=>(<div key={k}><label style={s.lbl}>{l}</label><input style={{...s.inp,marginBottom:10}} value={eForm[k]||""} onChange={e=>setEForm(f=>({...f,[k]:e.target.value}))}/></div>))}
          <label style={s.lbl}>Rol</label>
          <select style={{...s.inp,marginBottom:14}} value={eForm.role} onChange={e=>setEForm(f=>({...f,role:e.target.value}))}>{ROLES.map(r=><option key={r.value} value={r.value}>{r.label}</option>)}</select>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <button style={s.bOut()} onClick={()=>setShowEdit(false)}>Cancelar</button>
            <button style={{...s.btn(),opacity:busy?0.6:1}} onClick={saveEdit} disabled={busy}>{busy?"⏳...":"💾 Guardar"}</button>
          </div>
        </div>
      </div>)}

      {showReset&&(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100}}>
        <div style={{background:"#fff",borderRadius:8,padding:24,width:400,boxShadow:"0 4px 20px rgba(0,0,0,.2)"}}>
          <div style={{fontWeight:"bold",fontSize:15,color:C.warning,marginBottom:8}}>🔑 Resetear contraseña — <code>{showReset.username}</code></div>
          <div style={{fontSize:12,color:C.gray,marginBottom:12}}>
            Asignarás una contraseña temporal para <strong>{showReset.name}</strong>. La contraseña actual dejará de funcionar
            y el usuario deberá definir una nueva en su siguiente ingreso.
          </div>
          <label style={s.lbl}>Contraseña temporal * (mín. 8)</label>
          <input style={{...s.inp,marginBottom:10}} type="password" autoComplete="new-password" value={rp} onChange={e=>setRp(e.target.value)}/>
          <label style={s.lbl}>Confirmar contraseña temporal *</label>
          <input style={{...s.inp,marginBottom:10}} type="password" autoComplete="new-password" value={rp2} onChange={e=>setRp2(e.target.value)}/>
          {rErr&&<div style={{color:C.danger,fontSize:12,marginBottom:8}}>{rErr}</div>}
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <button style={s.bOut()} onClick={()=>setShowReset(null)}>Cancelar</button>
            <button style={{...s.btn(C.warning),opacity:busy?0.6:1}} onClick={doReset} disabled={busy}>{busy?"⏳...":"🔑 Asignar temporal"}</button>
          </div>
        </div>
      </div>)}

      {confirmDel&&(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.45)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100}}>
        <div style={{background:"#fff",borderRadius:10,padding:28,width:360,boxShadow:"0 8px 32px rgba(0,0,0,.25)",textAlign:"center"}}>
          <div style={{fontSize:36,marginBottom:8}}>⚠️</div>
          <div style={{fontWeight:"bold",fontSize:15,color:C.danger,marginBottom:8}}>¿Eliminar usuario?</div>
          <div style={{fontSize:13,color:C.gray,marginBottom:10}}>
            Se eliminará permanentemente la cuenta de<br/><strong style={{color:C.primary}}>{confirmDel.name}</strong> (<code style={{background:"#f3f4f6",padding:"1px 5px",borderRadius:3}}>{confirmDel.username}</code>).
          </div>
          <div style={{fontSize:12,color:"#92400e",background:"#fffbeb",border:`1px solid #fde68a`,borderRadius:6,padding:"8px 12px",marginBottom:18}}>
            Las notas de devolución asociadas a este usuario no se borrarán, pero ya no podrá ingresar al sistema.
          </div>
          <div style={{display:"flex",gap:10,justifyContent:"center"}}>
            <button style={s.bOut()} onClick={()=>setConfirmDel(null)}>Cancelar</button>
            <button style={{...s.btn(C.danger),opacity:busy?0.6:1}} onClick={doDelete} disabled={busy}>{busy?"⏳ Eliminando...":"🗑️ Sí, eliminar"}</button>
          </div>
        </div>
      </div>)}
    </div>
  );
}

// ── STATS ─────────────────────────────────────────────────────────────────────
function Stats({notas,user}) {
  const mine=visibleNotas(notas,user);
  const cnt=st=>mine.filter(n=>n.estado===st).length;
  const ALL=[
    {k:"en_bodega",      l:"En Bodega",       c:STC.en_bodega},
    {k:"corregida",      l:"Corregidas",       c:STC.corregida},
    {k:"en_calidad",     l:"En Calidad",       c:STC.en_calidad},
    {k:"en_facturacion", l:"En Facturación",   c:STC.en_facturacion},
    {k:"enviada_sap",    l:"Enviadas SAP",     c:STC.enviada_sap},
    {k:"aprobada_sap",   l:"Aprobadas SAP ✓",  c:STC.aprobada_sap},
  ];
  const visible=ROLE_STATES[user.role]||[];
  const shown=ALL.filter(st=>visible.includes(st.k));
  return (
    <div style={{marginBottom:20}}>
      <div style={{fontWeight:"bold",color:C.primary,marginBottom:10,fontSize:14}}>📊 Resumen — {mine.length} nota(s)</div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
        {shown.map(({k,l,c})=>(
          <div key={k} style={{background:"#fff",borderRadius:8,boxShadow:"0 1px 4px rgba(0,0,0,.1)",padding:"12px 16px",borderLeft:`4px solid ${c}`,minWidth:110,flex:"1 1 100px"}}>
            <div style={{fontSize:26,fontWeight:"bold",color:c}}>{cnt(k)}</div>
            <div style={{fontSize:11,color:C.gray,marginTop:2}}>{l}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── EXPORT ────────────────────────────────────────────────────────────────────
function exportCSV(notas) {
  const rows=[["NDV","TipoProducto","Ciudad","Cliente","Cód.Cliente","Fecha","Tipo","Motivo","RRVV","Cód.Prod","Descripción","Porc.15%","Med.Vital","Cantidad","Lote","F.Venc","Factura","Destino","Stock","Destrucción","Estado"]];
  notas.filter(n=>["enviada_sap","aprobada_sap"].includes(n.estado)).forEach(n=>{
    const f=n.registroFinal||n.modActual||n.form;
    const tp=n.tipoProducto==="controlado"?"Controlado":"Normal";
    const cd=n.ciudad==="quito"?"Quito":"Guayaquil";
    f.lineas.filter(l=>l.nombre).forEach(l=>{
      rows.push([n.ndv,tp,cd,f.nombreCliente,f.codigoCliente,fmtD(f.fecha),f.tipoDevolucion,f.descripcionMotivo,n.rrvvNombre,l.codigo,l.nombre,l.porc15==="si"?"Sí":"No",l.medVital==="si"?"Sí":"No",l.cantidad,l.lote,fmtD(l.fechaVenc),l.facturaNo,l.destino,l.cantStock,l.cantDestruccion,STL[n.estado]]);
    });
  });
  const csv=rows.map(r=>r.map(c=>`"${String(c||"").replace(/"/g,'""')}"`).join(",")).join("\n");
  const a=document.createElement("a");a.href="data:text/csv;charset=utf-8,\uFEFF"+encodeURIComponent(csv);a.download="devoluciones_sap.csv";a.click();
}

// ── HEADER ────────────────────────────────────────────────────────────────────
// Extraído a nivel de módulo: antes se definía dentro de App() en cada render,
// lo que provocaba que React lo desmontara/remontara constantemente.
function Header({user,setView,notas,onLogout}) {
  return (
    <div style={s.hdr}>
      <div style={{fontWeight:"bold",fontSize:16,letterSpacing:1}}>FRESENIUS KABI</div>
      <div style={{flex:1,fontSize:12}}>Sistema de Devoluciones</div>
      <div style={{fontSize:12,display:"flex",alignItems:"center",gap:6}}>👤 {user.name} <span style={s.bdg(rc(user.role))}>{ROLES.find(r=>r.value===user.role)?.label}</span></div>
      {user.role==="admin"&&<><button style={s.btn("#1e40af")} onClick={()=>setView("maestros")}>🗂️ Maestros</button><button style={s.btn("#1e3a6e")} onClick={()=>setView("usuarios")}>👥 Usuarios</button><button style={s.btn(C.success)} onClick={()=>exportCSV(notas)}>⬇ Exportar SAP</button></>}
      {user.role==="facturador"&&<button style={s.btn(C.success)} onClick={()=>exportCSV(notas)}>⬇ Exportar SAP</button>}
      <button style={{...s.btn("#ffffff33"),marginLeft:4}} onClick={onLogout}>Salir</button>
    </div>
  );
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [users,setUsers]       = useState([]);
  const [motivos,setMotivos]   = useState([]);
  const [plotes,setPlotes]     = useState([]);
  const [facturas,setFacturas] = useState([]);
  const [user,setUser]   = useState(null);
  const [notas,setNotas] = useState([]);
  const [view,setView]   = useState("lista");
  const [tab,setTab]     = useState("");
  const [selId,setSelId] = useState(null);
  const [loading,setLoading] = useState(true);
  const [dbError,setDbError] = useState(null);

  // ── Carga inicial desde Supabase ─────────────────────────────────────────
  useEffect(()=>{
    (async()=>{
      try{
        const [us,mo,pl,fa,no]=await Promise.all([
          db.users.list(),
          db.motivos.list(),
          db.plotes.list(),
          db.facturas.list(),
          db.notas.list(),
        ]);
        // Supabase es la única fuente de verdad para usuarios (vista pública sin contraseñas).
        // El usuario admin inicial se crea ejecutando security_setup.sql en Supabase.
        setUsers(us);
        setMotivos(mo); setPlotes(pl); setFacturas(fa);
        setNotas(no);
      }catch(e){
        setDbError(e.message||"Error al conectar con Supabase");
      }finally{
        setLoading(false);
      }
    })();
  },[]);

  const canCreate=user?.role==="rrvv";
  const [refreshing,setRefreshing]=useState(false);

  // Recarga la lista de notas desde la base — clave con varios usuarios trabajando
  // a la vez: sin esto, un usuario no vería notas creadas o movidas por otros.
  const reloadNotas=async()=>{
    if(refreshing) return;
    setRefreshing(true);
    try{ setNotas(await db.notas.list()); }
    catch(e){ notify("Error al actualizar: "+e.message); }
    finally{ setRefreshing(false); }
  };

  // Abre el detalle con la versión FRESCA de la nota desde la base, no la copia
  // local (que puede estar vieja si otro usuario ya la modificó).
  const openNota=async(id)=>{
    try{
      const fresh=await db.notas.get(id);
      setNotas(n=>n.map(x=>x.id===id?fresh:x));
    }catch{/* si falla, se abre con la copia local */}
    setSelId(id); setView("detalle");
  };

  // Al iniciar sesión, recargar notas para arrancar con datos actuales
  // (la carga inicial pudo ocurrir mucho antes del login).
  const handleLogin=async(u)=>{
    setUser(u);
    try{ setNotas(await db.notas.list()); }catch{}
  };

  const roleStates=user?(ROLE_STATES[user.role]||Object.keys(STC)):[];
  const NAV=roleStates.map(k=>({k, l:getTabLabel(k,user?.role)}));
  // activeTab: si "tab" ya no existe en las pestañas del rol, usa la primera disponible.
  const activeTab=NAV.some(t=>t.k===tab)?tab:(NAV[0]?.k||"");

  const filteredNotas=useMemo(()=>{
    if(!user) return [];
    let list=visibleNotas(notas,user);
    if(activeTab) list=list.filter(n=>n.estado===activeTab);
    return [...list].sort((a,b)=>b.id-a.id);
  },[notas,user,activeTab]);

  if(loading) return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}}>
      <div style={{fontSize:36}}>⏳</div>
      <div style={{fontWeight:"bold",color:C.primary,fontSize:16}}>Conectando con Supabase...</div>
    </div>
  );
  if(dbError) return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{...s.card,maxWidth:480,textAlign:"center"}}>
        <div style={{fontSize:36,marginBottom:12}}>❌</div>
        <div style={{fontWeight:"bold",color:C.danger,fontSize:16,marginBottom:8}}>Error de conexión</div>
        <div style={{fontSize:13,color:C.gray,marginBottom:16}}>{dbError}</div>
        <div style={{fontSize:12,color:C.gray,background:"#f3f4f6",borderRadius:6,padding:12,textAlign:"left"}}>
          Verifica las variables de entorno en StackBlitz:<br/>
          <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code>
        </div>
        <button style={{...s.btn(),marginTop:16}} onClick={()=>window.location.reload()}>🔄 Reintentar</button>
      </div>
    </div>
  );
  if(!user) return <><ToastHost/><Login onLogin={handleLogin}/></>;

  const logout=()=>{ setUser(null); setView("lista"); setTab(""); };

  if(view==="nueva") return <div style={s.app}><ToastHost/><Header user={user} setView={setView} notas={notas} onLogout={logout}/><NotaForm user={user} users={users} motivos={motivos} plotes={plotes} facturas={facturas} setNotas={setNotas} onBack={()=>setView("lista")}/></div>;
  if(view==="detalle"&&selId){ const nota=notas.find(n=>n.id===selId); if(nota) return <div style={s.app}><ToastHost/><Header user={user} setView={setView} notas={notas} onLogout={logout}/><NotaDetail nota={nota} user={user} setNotas={setNotas} plotes={plotes} facturas={facturas} onBack={()=>setView("lista")}/></div>; }
  if(view==="maestros"&&user.role==="admin") return <div style={s.app}><ToastHost/><Header user={user} setView={setView} notas={notas} onLogout={logout}/><div style={s.nav}><button style={s.nBtn(false)} onClick={()=>setView("lista")}>← Notas</button><button style={s.nBtn(true)}>🗂️ Maestros</button></div><DatosMaestros motivos={motivos} setMotivos={setMotivos} plotes={plotes} setPlotes={setPlotes} facturas={facturas} setFacturas={setFacturas}/></div>;
  if(view==="usuarios"&&user.role==="admin") return <div style={s.app}><ToastHost/><Header user={user} setView={setView} notas={notas} onLogout={logout}/><div style={s.nav}><button style={s.nBtn(false)} onClick={()=>setView("lista")}>← Notas</button><button style={s.nBtn(true)}>👥 Usuarios</button></div><UserManager users={users} setUsers={setUsers} currentUser={user}/></div>;

  return (
    <div style={s.app}><ToastHost/>
      <Header user={user} setView={setView} notas={notas} onLogout={logout}/>
      <div style={s.nav}>{NAV.map(t=><button key={t.k} style={s.nBtn(activeTab===t.k)} onClick={()=>setTab(t.k)}>{t.l}</button>)}</div>
      <div style={s.page}>
        <Stats notas={notas} user={user}/>
        <div style={s.card}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={s.title}>📄 Notas de Devolución</div>
            <div style={{display:"flex",gap:8}}>
              <button style={{...s.bOut(),opacity:refreshing?0.6:1}} onClick={reloadNotas} disabled={refreshing}>{refreshing?"⏳":"🔄 Actualizar"}</button>
              {canCreate&&<button style={s.btn()} onClick={()=>setView("nueva")}>+ Nueva Nota</button>}
            </div>
          </div>
          {filteredNotas.length===0?(
            <div style={{textAlign:"center",padding:40,color:C.gray}}>No hay notas en esta categoría.{canCreate&&<div style={{marginTop:8}}><button style={s.btn()} onClick={()=>setView("nueva")}>Crear primera nota</button></div>}</div>
          ):(
            <div style={{overflowX:"auto"}}>
              <table style={s.tbl}>
                <thead><tr>{["Nº Nota","Cliente","Fecha","Ciudad",isBodegueroRole(user.role)?"Vendedor":"RRVV","Creada por","Estado",""].map(h=><th key={h} style={s.th}>{h}</th>)}</tr></thead>
                <tbody>{filteredNotas.map(n=>(
                  <tr key={n.id}>
                    <td style={{...s.td,fontWeight:"bold",color:C.primary}}>{n.ndv}</td>
                    <td style={s.td}>{n.form.nombreCliente}</td>
                    <td style={s.td}>{fmtD(n.form.fecha)}</td>
                    <td style={s.td}><span style={s.bdg(n.ciudad==="quito"?C.accent:"#2563eb")}>{n.ciudad==="quito"?"Quito":"Guayaquil"}</span></td>
                    <td style={s.td}>{isBodegueroRole(user.role)?(()=>{
                        const facUsadas=new Set(n.form.lineas.map(l=>l.facturaNo).filter(Boolean));
                        const vends=[...new Set(facturas.filter(fc=>fc.codCliente===n.form.codigoCliente&&facUsadas.has(fc.noFactura)).map(fc=>fc.vendedor).filter(Boolean))];
                        return vends.length>0?vends.join(", "):n.rrvvNombre;
                      })():n.rrvvNombre}</td>
                    <td style={s.td}>{n.creadoPorNombre}</td>
                    <td style={s.td}><span style={s.bdg(STC[n.estado]||C.gray)}>{STL[n.estado]||TAB_LABELS[n.estado]||n.estado}</span></td>
                    <td style={s.td}><button style={s.btn(C.accent,true)} onClick={()=>openNota(n.id)}>Ver</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
