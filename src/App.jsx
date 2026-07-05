import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import { db } from "./supabase";

// ── ROLES ─────────────────────────────────────────────────────────────────────
const ROLES = [
  { value:"admin",      label:"Administrador",         desc:"Acceso total + gestión de usuarios",      color:"#dc2626" },
  { value:"rrvv",       label:"RRVV",                  desc:"Crea notas y confirma/rechaza correcciones", color:"#003087" },
  { value:"asistente",  label:"Asistente",              desc:"Crea notas a nombre de un RRVV",          color:"#7c3aed" },
  { value:"bodeguero",  label:"Bodeguero",              desc:"Revisa, registra facturas y aprueba",     color:"#0891b2" },
  { value:"inspector",  label:"Inspector de Calidad",   desc:"Define destinos Stock/Destrucción",       color:"#0d9488" },
  { value:"facturador", label:"Facturador",             desc:"Corrige facturas y exporta a SAP",        color:"#d97706" },
  { value:"gerente",    label:"Gerente de Operaciones", desc:"Confirma aprobación en SAP",              color:"#16a34a" },
];

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
// rrvv/asistente: solo En Bodega, Corregidas y Aprobadas en SAP.
//   La visibilidad es por propietario (ver visibleNotas): cada RRVV ve solo las notas
//   asignadas a él (asignadoA) y cada Asistente solo las que él creó (creadoPor),
//   por lo que con varios usuarios cada uno queda aislado del resto.
//   Nota: mientras una nota está En Calidad / En Facturación / Enviada a SAP no aparece
//   en ninguna de sus 3 carpetas; reaparece al llegar a "Aprobada en SAP".
const ROLE_STATES = {
  admin:      ["en_bodega","corregida","en_calidad","en_facturacion","enviada_sap","aprobada_sap"],
  rrvv:       ["en_bodega","corregida","aprobada_sap"],
  asistente:  ["en_bodega","corregida","aprobada_sap"],
  bodeguero:  ["en_bodega","corregida","en_calidad","en_facturacion","aprobada_sap"],
  inspector:  ["en_calidad"],
  facturador: ["en_facturacion","enviada_sap","aprobada_sap"],
  gerente:    ["enviada_sap","aprobada_sap"],
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
  if(k==="corregida" && role==="bodeguero") return "🔄 Rechazadas por RRVV";
  if(k==="en_bodega" && role==="rrvv")      return "📦 En Bodega";
  if(k==="en_bodega" && role==="asistente") return "📦 En Bodega";
  return TAB_LABELS[k] || k;
};

// ── INIT DATA ─────────────────────────────────────────────────────────────────
const INIT_USERS = [
  {id:1,username:"admin",     password:"admin123",  role:"admin",      name:"Administrador",   email:"admin@fk.com",  active:true,confirmed:true},
  {id:2,username:"carlos",    password:"rrvv123",   role:"rrvv",       name:"Carlos Pérez",    email:"carlos@fk.com", active:true,confirmed:true},
  {id:3,username:"ana",       password:"asist123",  role:"asistente",  name:"Ana Asistente",   email:"ana@fk.com",    active:true,confirmed:true},
  {id:4,username:"juan",      password:"bodega123", role:"bodeguero",  name:"Juan Bodega",     email:"juan@fk.com",   active:true,confirmed:true},
  {id:5,username:"inspector", password:"cal123",    role:"inspector",  name:"Pedro Calidad",   email:"pedro@fk.com",  active:true,confirmed:true},
  {id:6,username:"factura",   password:"fac123",    role:"facturador", name:"Luis Facturador", email:"luis@fk.com",   active:true,confirmed:true},
  {id:7,username:"gerente",   password:"ger123",    role:"gerente",    name:"Sofia Gerente",   email:"sofia@fk.com",  active:true,confirmed:true},
];
// Maestro único Producto-Lote.
// Clave de deduplicación: lote + codigo (un mismo nº de lote puede existir en distintos materiales).


// Facturas demo: relacionan cliente → material → lote → factura
// ── HELPERS ───────────────────────────────────────────────────────────────────
const mkL    = ()=>({codigo:"",nombre:"",porc15:null,medVital:null,cantidad:"",lote:"",fechaVenc:"",facturaNo:"",destino:"",cantStock:"",cantDestruccion:""});
const pad    = (arr)=>{ const r=[...arr]; while(r.length<10) r.push(mkL()); return r.slice(0,10); };
const mkForm = ()=>({fecha:"",codigoCliente:"",nombreCliente:"",tipoDevolucion:"",codigoMotivo:"",descripcionMotivo:"",nc:false,canje:false,observacion:"",noBultos:"",lineas:pad([])});
const fmtD   = (iso)=>{ if(!iso) return ""; const p=iso.split("-"); if(p.length!==3) return iso; return `${p[2]}/${p[1]}/${p[0]}`; };
const genCode= ()=>Math.random().toString(36).substring(2,10).toUpperCase();
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
  if(user.role==="asistente") return notas.filter(n=>n.creadoPor===user.id);
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

function PredictiveInput({value,onChange,suggestions=[],placeholder,style,disabled}) {
  const [open,setOpen]=useState(false);
  const [localVal,setLocalVal]=useState(value||"");
  const skipBlur=useRef(false);
  useEffect(()=>{ setLocalVal(value||""); },[value]);
  const filtered=(suggestions||[]).filter(x=>x.toLowerCase().includes((localVal||"").toLowerCase())).slice(0,10);
  const handleChange=(v)=>{ setLocalVal(v); onChange(v); setOpen(true); };
  const handleSelect=(x)=>{ skipBlur.current=true; setLocalVal(x); onChange(x); setOpen(false); setTimeout(()=>{ skipBlur.current=false; },300); };
  return (
    <div style={{position:"relative",display:"inline-block",width:style?.width||"100%",verticalAlign:"top"}}>
      <input style={{...style,width:"100%",boxSizing:"border-box"}} value={localVal} placeholder={placeholder} disabled={disabled}
        autoComplete="off" onChange={e=>handleChange(e.target.value)}
        onFocus={()=>setOpen(true)} onBlur={()=>{ if(!skipBlur.current) setOpen(false); }}/>
      {open&&filtered.length>0&&!disabled&&(
        <div style={{position:"absolute",zIndex:1000,background:"#fff",border:`1px solid ${C.accent}`,borderRadius:6,boxShadow:"0 4px 16px rgba(0,0,0,.15)",maxHeight:220,overflowY:"auto",width:"max-content",minWidth:"100%",top:"calc(100% + 2px)",left:0}}>
          {filtered.map((x,i)=>(
            <div key={i} style={{padding:"7px 12px",cursor:"pointer",fontSize:12,borderBottom:`1px solid ${C.light}`,background:"#fff",whiteSpace:"nowrap"}}
              onMouseDown={e=>{ e.preventDefault(); handleSelect(x); }}
              onMouseEnter={e=>e.currentTarget.style.background="#eff6ff"}
              onMouseLeave={e=>e.currentTarget.style.background="#fff"}>{x}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── CLIENT PICKER (autocompletado con selección obligatoria de la lista) ──────
// A diferencia de PredictiveInput, este NO permite texto libre: si lo escrito
// no coincide EXACTO con una opción, el campo queda "sin cliente" (no dispara
// carga de facturas/productos) y se marca en rojo hasta elegir una opción real.
function ClientPicker({value,onChange,options,placeholder,style}) {
  // options: [{cod, label}]
  const [open,setOpen]=useState(false);
  const [text,setText]=useState("");
  const skipBlur=useRef(false);

  // Sincroniza el texto mostrado con el valor seleccionado (código) desde afuera
  useEffect(()=>{
    const sel=options.find(o=>o.cod===value);
    setText(sel?sel.label:"");
  },[value,options]);

  const norm=(v)=>(v||"").toLowerCase();
  const filtered=text
    ? options.filter(o=>norm(o.label).includes(norm(text))||norm(o.cod).includes(norm(text))).slice(0,15)
    : options.slice(0,15);

  const isValidText = options.some(o=>o.label===text);

  const handleSelect=(o)=>{
    skipBlur.current=true;
    setText(o.label);
    onChange(o.cod);
    setOpen(false);
    setTimeout(()=>{ skipBlur.current=false; },300);
  };

  const handleBlur=()=>{
    if(skipBlur.current) return;
    setOpen(false);
    // Si lo escrito no coincide exactamente con una opción válida, se limpia
    // la selección para no arrastrar un cliente "a medias" sin facturas asociadas.
    if(!isValidText){
      onChange("");
      setText("");
    }
  };

  return (
    <div style={{position:"relative",width:style?.width||"100%"}}>
      <input
        style={{...style,width:"100%",boxSizing:"border-box",border:`1px solid ${value?C.accent:(text?C.danger:C.light)}`}}
        value={text}
        placeholder={placeholder}
        autoComplete="off"
        onChange={e=>{ setText(e.target.value); onChange(""); setOpen(true); }}
        onFocus={()=>setOpen(true)}
        onBlur={handleBlur}
      />
      {open&&filtered.length>0&&(
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
      {open&&filtered.length===0&&(
        <div style={{position:"absolute",zIndex:1000,background:"#fff",border:`1px solid ${C.light}`,borderRadius:6,padding:"7px 12px",fontSize:12,color:C.gray,top:"calc(100% + 2px)",left:0,width:"max-content"}}>
          Sin coincidencias
        </div>
      )}
      {text&&!value&&!open&&(
        <div style={{fontSize:11,color:C.danger,marginTop:2}}>⚠ Debes elegir un cliente de la lista.</div>
      )}
    </div>
  );
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

// Fila memoizada: solo se re-renderiza la fila que cambia, no las 10.
// Fila memoizada: solo se re-renderiza la fila que cambia al escribir.
const ProductRow = memo(function ProductRow({l,i,editable,calEditable,facEditable,onChangeLine,plotes=[],facturas=[],codigoCliente=""}) {
  // Escalonado basado en facturas del cliente seleccionado:
  // 1) Códigos de materiales vendidos al cliente
  const facCliente=codigoCliente ? facturas.filter(f=>f.codCliente===codigoCliente) : [];
  const codigosSug=[...new Set(facCliente.map(f=>f.codMaterial))].sort();
  // 2) Nombres del código elegido (del maestro plotes, filtrado por lo vendido al cliente)
  const codsDelCliente=new Set(facCliente.map(f=>f.codMaterial));
  const nombresSug=[...new Set(
    plotes.filter(x=>codsDelCliente.has(x.codigo)&&(!l.codigo||x.codigo===l.codigo)).map(x=>x.nombre)
  )].sort();
  // 3) Lotes: los que aparecen en facturas del cliente para ese código (deduplicados)
  const lotesEnFactura=[...new Set(facCliente.filter(f=>f.codMaterial===l.codigo).map(f=>f.lote).filter(Boolean))];
  // 4) Facturas del cliente para ese código+lote específico
  const facturasSug=[...new Set(
    facCliente.filter(f=>f.codMaterial===l.codigo&&(!l.lote||f.lote===l.lote)).map(f=>f.noFactura)
  )];
  return (
    <tr style={{background:i%2===0?"#f9fafb":"#fff"}}>
      <td style={s.td}>{i+1}</td>
      {editable?(
        <>
          <td style={s.td}>
            <PredictiveInput style={{...s.inp,width:85}} value={l.codigo}
              placeholder={codigoCliente?"Código...":"— Elige cliente —"}
              disabled={!codigoCliente}
              suggestions={codigosSug}
              onChange={v=>{ const pl=plotes.find(x=>x.codigo===v); onChangeLine(i,{codigo:v,nombre:pl?pl.nombre:"",lote:"",fechaVenc:"",facturaNo:""}); }}/>
          </td>
          <td style={s.td}>
            <PredictiveInput style={{...s.inp,width:170}} value={l.nombre}
              placeholder={codigoCliente?"Nombre material...":"— Elige cliente —"}
              disabled={!codigoCliente}
              suggestions={nombresSug}
              onChange={v=>{ const pl=plotes.find(x=>(!l.codigo||x.codigo===l.codigo)&&x.nombre===v); onChangeLine(i,{nombre:v,codigo:pl?pl.codigo:l.codigo,lote:"",fechaVenc:"",facturaNo:""}); }}/>
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
  return (
    <tbody>
      {lineas.map((l,i)=>(
        <ProductRow key={i} l={l} i={i} editable={editable} calEditable={calEditable} facEditable={facEditable} onChangeLine={onChangeLine} plotes={plotes} facturas={facturas} codigoCliente={codigoCliente}/>
      ))}
    </tbody>
  );
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
function Login({users,onLogin,invites,onActivate}) {
  const [mode,setMode]=useState("login");
  const [u,setU]=useState(""); const [p,setP]=useState(""); const [err,setErr]=useState("");
  const [code,setCode]=useState(""); const [invite,setInvite]=useState(null);
  const [af,setAf]=useState({username:"",password:"",password2:""}); const [aerr,setAerr]=useState("");
  const doLogin=()=>{ const usr=users.find(x=>x.username===u&&x.password===p&&x.active&&x.confirmed); if(usr) onLogin(usr); else setErr("Usuario/contraseña incorrectos."); };
  const doCode=()=>{ const inv=invites.find(i=>i.code===code.trim().toUpperCase()&&i.status==="pending"); if(!inv) return setAerr("Código inválido."); setInvite(inv); setAerr(""); };
  const doActivate=()=>{ if(!af.username||!af.password) return setAerr("Completa todos los campos."); if(af.password!==af.password2) return setAerr("Contraseñas no coinciden."); if(users.find(x=>x.username===af.username)) return setAerr("Usuario ya existe."); onActivate(invite,af.username,af.password); setMode("login"); setCode(""); setInvite(null); };
  return (
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{...s.card,width:370,textAlign:"center"}}>
        <div style={{color:C.primary,fontWeight:"bold",fontSize:22,marginBottom:4}}>FRESENIUS KABI</div>
        <div style={{color:C.gray,fontSize:13,marginBottom:16}}>Sistema de Gestión de Devoluciones</div>
        <div style={{display:"flex",borderRadius:6,overflow:"hidden",border:`1px solid ${C.light}`,marginBottom:20}}>
          {[["login","🔐 Ingresar"],["activate","✉️ Activar cuenta"]].map(([m,l])=>(
            <button key={m} onClick={()=>{setMode(m);setErr("");setAerr("");setInvite(null);}} style={{flex:1,padding:8,border:"none",background:mode===m?C.primary:"#fff",color:mode===m?"#fff":C.gray,cursor:"pointer",fontSize:12,fontWeight:mode===m?"bold":"normal"}}>{l}</button>
          ))}
        </div>
        {mode==="login"?(
          <><label style={s.lbl}>Usuario</label><input style={{...s.inp,marginBottom:10}} value={u} onChange={e=>setU(e.target.value)}/>
          <label style={s.lbl}>Contraseña</label><input style={{...s.inp,marginBottom:14}} type="password" value={p} onChange={e=>setP(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doLogin()}/>
          {err&&<div style={{color:C.danger,fontSize:12,marginBottom:8}}>{err}</div>}
          <button style={{...s.btn(),width:"100%"}} onClick={doLogin}>Ingresar</button>
          <div style={{marginTop:12,fontSize:11,color:C.gray,lineHeight:2}}>admin/admin123 · carlos/rrvv123 · ana/asist123<br/>juan/bodega123 · inspector/cal123 · factura/fac123 · gerente/ger123</div></>
        ):!invite?(
          <><div style={{fontSize:13,color:C.gray,marginBottom:12}}>Ingresa tu código de invitación.</div>
          <input style={{...s.inp,marginBottom:10,textTransform:"uppercase",letterSpacing:2,textAlign:"center",fontSize:15}} value={code} onChange={e=>setCode(e.target.value)} placeholder="XXXXXXXX"/>
          {aerr&&<div style={{color:C.danger,fontSize:12,marginBottom:8}}>{aerr}</div>}
          <button style={{...s.btn(),width:"100%"}} onClick={doCode}>Verificar</button></>
        ):(
          <><div style={{background:"#f0fdf4",border:`1px solid #bbf7d0`,borderRadius:6,padding:10,marginBottom:12,fontSize:12}}>✅ Bienvenido/a <strong>{invite.name}</strong><br/>Rol: <span style={s.bdg(rc(invite.role))}>{ROLES.find(r=>r.value===invite.role)?.label}</span></div>
          {[["username","Usuario"],["password","Contraseña"],["password2","Confirmar contraseña"]].map(([k,l])=>(
            <div key={k}><label style={s.lbl}>{l}</label><input style={{...s.inp,marginBottom:10}} type={k!=="username"?"password":"text"} value={af[k]} onChange={e=>setAf(f=>({...f,[k]:e.target.value}))}/></div>
          ))}
          {aerr&&<div style={{color:C.danger,fontSize:12,marginBottom:8}}>{aerr}</div>}
          <button style={{...s.btn(C.success),width:"100%"}} onClick={doActivate}>✅ Activar cuenta</button>
          <button style={{...s.bOut(),width:"100%",marginTop:8}} onClick={()=>setInvite(null)}>← Cambiar código</button></>
        )}
      </div>
    </div>
  );
}

// ── NOTA FORM ─────────────────────────────────────────────────────────────────
function NotaForm({user,users,motivos,plotes,facturas,setNotas,onBack}) {
  const canAssign=user.role==="asistente";
  const rrvvList=users.filter(u=>u.role==="rrvv"&&u.active);
  const hoy=new Date().toISOString().split("T")[0];
  const [form,setForm]=useState({...mkForm(),fecha:hoy});
  const [asig,setAsig]=useState(canAssign?"":String(user.id));
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
            <div style={{fontWeight:"bold",color:C.primary,fontSize:13}}>Se asignará al crear</div>
          </div>
        </div>

        {canAssign&&(
          <div style={{...s.card,background:"#eef2ff",marginBottom:14}}>
            <div style={{fontWeight:"bold",color:C.purple,marginBottom:8}}>👤 Crear a nombre de RRVV</div>
            <select style={{...s.inp,maxWidth:300}} value={asig} onChange={e=>setAsig(e.target.value)}>
              <option value="">Seleccionar RRVV...</option>
              {rrvvList.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
        )}

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
          <div style={{flex:"0 0 140px"}}><label style={s.lbl}>Cód. Motivo</label>
            <PredictiveInput style={s.inp} value={form.codigoMotivo} placeholder="VEN" suggestions={motivos.map(m=>m.codigo)} onChange={v=>{ const m=motivos.find(x=>x.codigo===v); sf("codigoMotivo",v); if(m) sf("descripcionMotivo",m.descripcion); }}/></div>
          <div style={{flex:"2 1 160px"}}><label style={s.lbl}>Descripción Motivo</label>
            <PredictiveInput style={s.inp} value={form.descripcionMotivo} placeholder="Seleccionar..." suggestions={motivos.map(m=>m.descripcion)} onChange={v=>{ const m=motivos.find(x=>x.descripcion===v); sf("descripcionMotivo",v); if(m) sf("codigoMotivo",m.codigo); }}/></div>
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
  const workForm=nota.modActual||nota.form;
  const [mf,setMf]=useState(cloneForm(workForm));
  const [com,setCom]=useState("");
  const [motivoRechazo,setMotivoRechazo]=useState("");
  const [showRechazo,setShowRechazo]=useState(false);
  const rol=user.role;

  const changeLine=useCallback((i,patch)=>setMf(f=>{ const ls=[...f.lineas]; ls[i]={...ls[i],...patch}; return{...f,lineas:ls}; }),[]);
  const push=(a)=>({accion:`${a}${com?": "+com:""}`,usuario:user.name,fecha:new Date().toLocaleString()});
  const upd=async(patch)=>{
    try{
      await db.notas.update(nota.id,patch);
      setNotas(n=>n.map(x=>x.id===nota.id?{...x,...patch}:x));
    }catch(e){ notify("Error al actualizar nota: "+e.message); }
  };

  const isBod    = rol==="bodeguero";
  const isRRVV   = (rol==="rrvv"&&user.id===nota.asignadoA)||rol==="admin";
  const isCal    = rol==="inspector";
  const isFac    = rol==="facturador";
  const isGer    = rol==="gerente";

  const canBodEdit    = isBod && nota.estado==="en_bodega";
  const canBodAprobar = isBod && nota.estado==="en_bodega";
  const canBodCorregir= isBod && nota.estado==="en_bodega";
  const canRRVVConfirm= isRRVV && nota.estado==="corregida";
  const canCalAprobar = isCal && nota.estado==="en_calidad";
  const canFacEdit    = isFac && nota.estado==="en_facturacion";
  const canFacExportar= isFac && nota.estado==="en_facturacion";
  const canGerConfirm = isGer && nota.estado==="enviada_sap";

  const isEditing    = canBodEdit||canBodCorregir;
  const isCalEditing = canCalAprobar;
  const isFacEditing = canFacEdit;

  const detectChanges=(orig,mod)=>{
    const ch=[];
    orig.lineas.forEach((ol,i)=>{
      const ml=mod.lineas[i];
      if(!ol.nombre&&!ml.nombre) return;
      const name=ml.nombre||ol.nombre||`Línea ${i+1}`;
      if(ol.codigo!==ml.codigo) ch.push(`L${i+1} código: ${ol.codigo||"—"}→${ml.codigo||"—"}`);
      if(ol.nombre!==ml.nombre) ch.push(`L${i+1} (${name}) nombre: "${ol.nombre}"→"${ml.nombre}"`);
      if(ol.cantidad!==ml.cantidad) ch.push(`L${i+1} (${name}) cantidad: ${ol.cantidad||"—"}→${ml.cantidad||"—"}`);
      if(ol.lote!==ml.lote) ch.push(`L${i+1} (${name}) lote: ${ol.lote||"—"}→${ml.lote||"—"}`);
      if(ol.fechaVenc!==ml.fechaVenc) ch.push(`L${i+1} (${name}) f.venc: ${fmtD(ol.fechaVenc)||"—"}→${fmtD(ml.fechaVenc)||"—"}`);
      if(ol.facturaNo!==ml.facturaNo) ch.push(`L${i+1} (${name}) factura: ${ol.facturaNo||"—"}→${ml.facturaNo||"—"}`);
    });
    return ch;
  };

  const f=nota.form;
  const dispForm=isEditing?mf:(nota.modActual||nota.form);

  // Alertas de estado — sin HTML inyectado (el motivoRechazo del usuario se renderiza como texto plano)
  const alertas={
    en_bodega: nota.motivoRechazo
      ? {bg:"#fef2f2",border:"#fecaca",txt:"#991b1b",jsx:<span>🔴 <strong>RRVV rechazó la corrección anterior:</strong> "{nota.motivoRechazo}". Revisa y realiza una nueva corrección o aprueba directamente.</span>}
      : {bg:"#fffbeb",border:"#fde68a",txt:"#92400e",jsx:<span>⚠️ Revisa los datos, registra las facturas por línea. <b>Corregir</b> regresa al RRVV con detalle de cambios. <b>Aprobar</b> envía a Inspector de Calidad.</span>},
    corregida:{bg:"#eff6ff",border:"#bfdbfe",txt:"#1e40af",jsx:<span>ℹ️ El bodeguero realizó correcciones. Revisa los cambios y <b>Confirma</b> para que regrese a bodega, o <b>Rechaza</b> indicando el motivo.</span>},
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
              {user.role==="bodeguero"&&(()=>{
                const f=nota.form;
                const facturasUsadas=new Set(f.lineas.map(l=>l.facturaNo).filter(Boolean));
                const vendedores=[...new Set(
                  facturas.filter(fc=>fc.codCliente===f.codigoCliente&&facturasUsadas.has(fc.noFactura)).map(fc=>fc.vendedor).filter(Boolean)
                )];
                return vendedores.length>0?<span style={{marginLeft:8}}>· Vendedor: <strong style={{color:C.accent}}>{vendedores.join(", ")}</strong></span>:null;
              })()}
            </div>
          </div>
          <span style={s.bdg(STC[nota.estado]||C.gray)}>{STL[nota.estado]||nota.estado}</span>
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
              onChangeLine={changeLine} plotes={plotes}/>
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

            {canBodCorregir&&<button style={s.btn(C.warning)} onClick={()=>{
              const changes=detectChanges(workForm,mf);
              const log=changes.length>0
                ? `Bodeguero corrigió → pendiente confirmación RRVV | ${changes.join(" | ")}`
                : "Bodeguero corrigió → pendiente confirmación RRVV (sin cambios en materiales)";
              upd({estado:"corregida",modActual:cloneForm(mf),motivoRechazo:null,historial:[...nota.historial,push(log)]});onBack();
            }}>✏️ Corregir → Enviar a RRVV</button>}

            {canBodAprobar&&<button style={s.btn(STC.en_bodega)} onClick={()=>{
              upd({estado:"en_calidad",modActual:cloneForm(mf),motivoRechazo:null,historial:[...nota.historial,push("Bodeguero aprobó → Inspector de Calidad")]});onBack();
            }}>✅ Aprobar → Calidad</button>}

            {canRRVVConfirm&&!showRechazo&&(
              <>
                <button style={s.btn(C.success)} onClick={()=>{
                  upd({estado:"en_bodega",historial:[...nota.historial,push("RRVV confirmó la corrección → regresa a bodega")]});onBack();
                }}>✔ Confirmar corrección</button>
                <button style={s.btn(C.danger)} onClick={()=>setShowRechazo(true)}>✖ Rechazar corrección</button>
              </>
            )}

            {canRRVVConfirm&&showRechazo&&(
              <div style={{width:"100%",background:"#fef2f2",border:`1px solid #fecaca`,borderRadius:8,padding:12,marginTop:4}}>
                <div style={{fontWeight:"bold",color:C.danger,marginBottom:8,fontSize:13}}>✖ Indicar motivo de rechazo</div>
                <textarea style={{...s.inp,height:70,resize:"vertical",marginBottom:10}} value={motivoRechazo} onChange={e=>setMotivoRechazo(e.target.value)} placeholder="Describe por qué rechazas esta corrección..."/>
                <div style={{display:"flex",gap:8}}>
                  <button style={s.btn(C.danger)} onClick={()=>{
                    if(!motivoRechazo.trim()) return notify("Debes indicar el motivo del rechazo.","warn");
                    upd({estado:"en_bodega",motivoRechazo:motivoRechazo.trim(),modActual:null,historial:[...nota.historial,{accion:`RRVV rechazó corrección: ${motivoRechazo.trim()}`,usuario:user.name,fecha:new Date().toLocaleString()}]});
                    onBack();
                  }}>Enviar rechazo</button>
                  <button style={s.bOut()} onClick={()=>setShowRechazo(false)}>Cancelar</button>
                </div>
              </div>
            )}

            {canCalAprobar&&<button style={s.btn(STC.en_calidad)} onClick={()=>{
              const errores=[];
              mf.lineas.forEach((l,i)=>{
                if(!l.nombre&&!l.codigo) return;
                const cant=parseFloat(l.cantidad)||0;
                const sum=(parseFloat(l.cantStock)||0)+(parseFloat(l.cantDestruccion)||0);
                if(sum!==cant) errores.push(`Línea ${i+1} (${l.nombre||l.codigo}): ${sum}≠${cant}`);
              });
              if(errores.length>0){ notify(`❌ Und. Stock / Und. Destruc. deben cuadrar:\n${errores.join("\n")}`,"warn"); return; }
              upd({estado:"en_facturacion",modActual:cloneForm(mf),historial:[...nota.historial,push("Inspector aprobó con destinos → Facturador")]});onBack();
            }}>✅ Aprobar → Facturador</button>}

            {canFacExportar&&<button style={s.btn(STC.en_facturacion)} onClick={()=>{
              upd({estado:"enviada_sap",registroFinal:cloneForm(mf),modActual:cloneForm(mf),historial:[...nota.historial,push("Facturador exportó a SAP — Excel generado")]});onBack();
            }}>📤 Exportar a SAP</button>}

            {canGerConfirm&&<button style={s.btn(STC.aprobada_sap)} onClick={()=>{
              upd({estado:"aprobada_sap",historial:[...nota.historial,push("Gerente confirmó aprobación en SAP ✓")]});onBack();
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

  // Procesa filas (array de arrays, fila 0 = encabezados) y carga en UN solo setState.
  const processRows=async(rowsAoa,importTab)=>{
    const Mm=MASTERS[importTab];
    if(!rowsAoa||rowsAoa.length<2){ setImportResult({ok:0,errors:["Archivo vacío o sin filas de datos."]}); return; }
    const header=rowsAoa[0].map(h=>String(h).replace(/"/g,"").trim().toUpperCase());
    const idx=Mm.cols.map(c=>header.indexOf(c));
    const missing=Mm.cols.filter((c,i)=>idx[i]===-1);
    if(missing.length){ setImportResult({ok:0,errors:[`Columnas faltantes: ${missing.join(", ")}. La primera fila debe tener exactamente: ${Mm.cols.join(", ")}. (Usa la plantilla descargada.)`]}); return; }
    const setD=stores[importTab][1]; const d=stores[importTab][0];
    const seen=new Set(d.map(x=>Mm.keyOf(x)));
    const errors=[]; const newItems=[]; let seq=0;
    rowsAoa.slice(1).forEach((cols,li)=>{
      if(!cols||cols.every(c=>String(c==null?"":c).trim()==="")) return;
      const rec={}; Mm.fields.forEach(([fk],i)=>{ rec[fk]=String(cols[idx[i]]==null?"":cols[idx[i]]).replace(/"/g,"").trim(); });
      // Solo validar campos obligatorios (marcados con " *" en su label)
      const requiredFields=Mm.fields.filter(([,label])=>label.includes(" *")).map(([fk])=>fk);
      const missingFields=requiredFields.filter(fk=>!rec[fk]);
      if(missingFields.length){ errors.push(`Fila ${li+2}: campos obligatorios vacíos: ${missingFields.join(", ")}.`); return; }
      if(Mm.dateField){ const iso=toISO(rec[Mm.dateField]); if(!/^\d{4}-\d{2}-\d{2}$/.test(iso)){ errors.push(`Fila ${li+2}: fecha inválida "${rec[Mm.dateField]}" (usa AAAA-MM-DD o DD/MM/AAAA).`); return; } rec[Mm.dateField]=iso; }
      const k=Mm.keyOf(rec);
      if(seen.has(k)){ errors.push(`Fila ${li+2}: duplicado (${k}).`); return; }
      seen.add(k); newItems.push({...rec}); seq++;
    });
    if(newItems.length){
      try{
        const inserted=await db[importTab].insertMany(newItems);
        setD(arr=>[...arr,...(inserted||[])]);
      }catch(e){ errors.push("Error al guardar en BD: "+e.message); }
    }
    setImportResult({ok:newItems.length,errors,total:rowsAoa.length-1});
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
              <button style={s.btn("#166534")} onClick={downloadTemplate}>⬇️ Descargar plantilla</button>
              <label style={{...s.btn("#0d9488"),cursor:"pointer",display:"inline-flex",alignItems:"center"}}>📤 Subir archivo<input type="file" accept=".xlsx,.xls,.csv,.txt" style={{display:"none"}} onChange={handleFile}/></label>
              {data.length>0&&<button style={s.btn(C.danger)} onClick={()=>setConfirmDelAll(true)}>🗑️ Eliminar todos</button>}
            </div>
          </div>
          {importResult&&(
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

// ── EMAIL CONFIG + USER MANAGER ───────────────────────────────────────────────
function EmailConfig({emailConfig,setEmailConfig}) {
  const [cfg,setCfg]=useState({...emailConfig}); const [saved,setSaved]=useState(false);
  const save=()=>{setEmailConfig({...cfg});setSaved(true);setTimeout(()=>setSaved(false),2000);};
  return (
    <div style={s.card}>
      <div style={s.title}>⚙️ Configuración EmailJS</div>
      <div style={s.row}>
        {[["serviceId","Service ID","service_xxx"],["templateId","Template ID","template_xxx"],["publicKey","Public Key","xxxxxxxx"]].map(([k,l,ph])=>(
          <div key={k} style={{flex:"1 1 160px"}}><label style={s.lbl}>{l}</label><input style={{...s.inp,marginBottom:10}} value={cfg[k]} onChange={e=>setCfg(c=>({...c,[k]:e.target.value}))} placeholder={ph}/></div>
        ))}
      </div>
      <button style={s.btn(saved?C.success:C.primary)} onClick={save}>{saved?"✅ Guardado":"💾 Guardar"}</button>
    </div>
  );
}

function UserManager({users,setUsers,invites,setInvites,currentUser,emailConfig,setEmailConfig}) {
  const [tab,setTab]=useState("usuarios"); const [showInv,setShowInv]=useState(false); const [showEdit,setShowEdit]=useState(false);
  const [editTarget,setEditTarget]=useState(null); const [inv,setInv]=useState({name:"",email:"",role:"rrvv"}); const [eForm,setEForm]=useState({});
  const [sending,setSending]=useState(false); const [toast,setToast]=useState(null);
  const toast2=(msg,type="success")=>{setToast({msg,type});setTimeout(()=>setToast(null),4000);};
  const sendInvite=async()=>{
    if(!inv.name.trim()||!inv.email.trim()) return toast2("Completa nombre y correo.","error");
    const {serviceId,templateId,publicKey}=emailConfig; const code=genCode(); const roleLabel=ROLES.find(r=>r.value===inv.role)?.label||inv.role;
    const newInv={id:Date.now(),code,name:inv.name,email:inv.email,role:inv.role,status:"pending",sentAt:new Date().toLocaleString()};
    if(serviceId&&templateId&&publicKey){ setSending(true); try{ const res=await fetch("https://api.emailjs.com/api/v1.0/email/send",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({service_id:serviceId.trim(),template_id:templateId.trim(),user_id:publicKey.trim(),template_params:{to_email:inv.email.trim(),to_name:inv.name.trim(),role_label:roleLabel,invite_code:code,invite_link:window.location.href}})}); if(!res.ok) throw new Error(await res.text()); toast2(`✉️ Correo enviado a ${inv.email}`); }catch(e){ toast2(`⚠️ ${e.message}. Código: ${code}`,"warn"); } setSending(false); }
    else{ toast2(`📋 Sin EmailJS. Código: ${code}`,"warn"); }
    try{ const saved=await db.invites.insert(newInv); setInvites(x=>[...x,saved]); }catch{ setInvites(x=>[...x,newInv]); }
    setInv({name:"",email:"",role:"rrvv"}); setShowInv(false);
  };
  const openEdit=(u)=>{setEditTarget(u);setEForm({name:u.name,email:u.email||"",role:u.role,active:u.active});setShowEdit(true);};
  const saveEdit=async()=>{ try{ await db.users.update(editTarget.id,eForm); setUsers(us=>us.map(u=>u.id===editTarget.id?{...u,...eForm}:u)); setShowEdit(false); toast2("Actualizado."); }catch(e){ toast2("Error: "+e.message,"error"); } };
  const toggle=async(id)=>{ if(id===currentUser.id)return; const u=users.find(x=>x.id===id); if(!u)return; try{ await db.users.update(id,{active:!u.active}); setUsers(us=>us.map(x=>x.id===id?{...x,active:!x.active}:x)); }catch(e){ toast2("Error: "+e.message,"error"); } };
  return (
    <div style={s.page}>
      {toast&&<div style={{position:"fixed",top:16,right:16,zIndex:200,background:toast.type==="error"?C.danger:toast.type==="warn"?C.warning:C.success,color:"#fff",padding:"10px 18px",borderRadius:8,maxWidth:380,fontSize:13}}>{toast.msg}</div>}
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
        {[["usuarios","👥 Usuarios"],["invitaciones","✉️ Invitaciones"],["config","⚙️ Correo"]].map(([k,l])=><button key={k} style={s.btn(tab===k?C.primary:"#e5e7eb")} onClick={()=>setTab(k)}><span style={{color:tab===k?"#fff":C.gray}}>{l}</span></button>)}
      </div>
      {tab==="usuarios"&&(
        <div style={s.card}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={s.title}>👥 Usuarios</div><button style={s.btn()} onClick={()=>setShowInv(true)}>+ Invitar</button></div>
          <div style={{...s.row,marginBottom:14}}>{ROLES.map(r=><div key={r.value} style={{background:"#f9fafb",borderRadius:6,padding:"6px 10px",borderLeft:`4px solid ${r.color}`,flex:"1 1 110px"}}><div style={{fontWeight:"bold",color:r.color,fontSize:11}}>{r.label}</div><div style={{color:C.gray,fontSize:10}}>{r.desc}</div></div>)}</div>
          <table style={s.tbl}>
            <thead><tr>{["Nombre","Usuario","Rol","Estado","Acciones"].map(h=><th key={h} style={s.th}>{h}</th>)}</tr></thead>
            <tbody>{users.map(u=>(
              <tr key={u.id} style={{opacity:u.active?1:.55}}>
                <td style={s.td}><strong>{u.name}</strong></td>
                <td style={s.td}><code style={{background:"#f3f4f6",padding:"2px 6px",borderRadius:3}}>{u.username}</code></td>
                <td style={s.td}><span style={s.bdg(rc(u.role))}>{ROLES.find(r=>r.value===u.role)?.label}</span></td>
                <td style={s.td}><span style={s.bdg(u.active?C.success:C.gray)}>{u.active?"Activo":"Inactivo"}</span></td>
                <td style={s.td}><div style={{display:"flex",gap:6}}><button style={s.btn(C.accent,true)} onClick={()=>openEdit(u)}>Editar</button>{u.id!==currentUser.id&&<button style={s.btn(u.active?C.danger:C.success,true)} onClick={()=>toggle(u.id)}>{u.active?"Desactivar":"Activar"}</button>}</div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {tab==="invitaciones"&&(
        <div style={s.card}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div style={s.title}>✉️ Invitaciones</div><button style={s.btn()} onClick={()=>setShowInv(true)}>+ Nueva</button></div>
          {invites.length===0?<div style={{textAlign:"center",padding:30,color:C.gray}}>No hay invitaciones.</div>:(
            <table style={s.tbl}><thead><tr>{["Nombre","Correo","Rol","Código","Estado","Enviada",""].map(h=><th key={h} style={s.th}>{h}</th>)}</tr></thead>
            <tbody>{invites.map(i=>(<tr key={i.id}><td style={s.td}>{i.name}</td><td style={s.td}>{i.email}</td><td style={s.td}><span style={s.bdg(rc(i.role))}>{ROLES.find(r=>r.value===i.role)?.label}</span></td><td style={s.td}><code style={{background:"#f3f4f6",padding:"2px 4px",borderRadius:3,letterSpacing:1}}>{i.code}</code></td><td style={s.td}><span style={s.bdg(i.status==="pending"?C.warning:i.status==="used"?C.success:C.gray)}>{i.status==="pending"?"Pendiente":i.status==="used"?"Activada":"Revocada"}</span></td><td style={s.td}>{i.sentAt}</td><td style={s.td}>{i.status==="pending"&&<button style={s.btn(C.danger,true)} onClick={async()=>{ try{ await db.invites.update(i.id,{status:"revoked"}); setInvites(x=>x.map(j=>j.id===i.id?{...j,status:"revoked"}:j)); }catch(e){ notify("Error: "+e.message); } }}>Revocar</button>}</td></tr>))}</tbody></table>
          )}
        </div>
      )}
      {tab==="config"&&<EmailConfig emailConfig={emailConfig} setEmailConfig={setEmailConfig}/>}
      {showInv&&(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100}}>
        <div style={{background:"#fff",borderRadius:8,padding:24,width:400,boxShadow:"0 4px 20px rgba(0,0,0,.2)"}}>
          <div style={{fontWeight:"bold",fontSize:15,color:C.primary,marginBottom:12}}>✉️ Invitar Usuario</div>
          <label style={s.lbl}>Nombre *</label><input style={{...s.inp,marginBottom:10}} value={inv.name} onChange={e=>setInv(f=>({...f,name:e.target.value}))}/>
          <label style={s.lbl}>Correo *</label><input style={{...s.inp,marginBottom:10}} type="email" value={inv.email} onChange={e=>setInv(f=>({...f,email:e.target.value}))}/>
          <label style={s.lbl}>Rol *</label><select style={{...s.inp,marginBottom:14}} value={inv.role} onChange={e=>setInv(f=>({...f,role:e.target.value}))}>{ROLES.map(r=><option key={r.value} value={r.value}>{r.label}</option>)}</select>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}><button style={s.bOut()} onClick={()=>setShowInv(false)}>Cancelar</button><button style={s.btn(C.success)} onClick={sendInvite} disabled={sending}>{sending?"Enviando...":"📨 Enviar"}</button></div>
        </div>
      </div>)}
      {showEdit&&(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100}}>
        <div style={{background:"#fff",borderRadius:8,padding:24,width:380,boxShadow:"0 4px 20px rgba(0,0,0,.2)"}}>
          <div style={{fontWeight:"bold",fontSize:15,color:C.primary,marginBottom:14}}>Editar Usuario</div>
          {[["name","Nombre"],["email","Correo"]].map(([k,l])=>(<div key={k}><label style={s.lbl}>{l}</label><input style={{...s.inp,marginBottom:10}} value={eForm[k]||""} onChange={e=>setEForm(f=>({...f,[k]:e.target.value}))}/></div>))}
          <label style={s.lbl}>Rol</label><select style={{...s.inp,marginBottom:10}} value={eForm.role} onChange={e=>setEForm(f=>({...f,role:e.target.value}))}>{ROLES.map(r=><option key={r.value} value={r.value}>{r.label}</option>)}</select>
          <label style={{display:"flex",alignItems:"center",gap:6,marginBottom:14,cursor:"pointer"}}><input type="checkbox" checked={!!eForm.active} onChange={e=>setEForm(f=>({...f,active:e.target.checked}))}/> Activo</label>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}><button style={s.bOut()} onClick={()=>setShowEdit(false)}>Cancelar</button><button style={s.btn()} onClick={saveEdit}>💾 Guardar</button></div>
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
  const rows=[["NDV","Cliente","Cód.Cliente","Fecha","Tipo","Motivo","RRVV","Cód.Prod","Descripción","Porc.15%","Med.Vital","Cantidad","Lote","F.Venc","Factura","Destino","Stock","Destrucción","Estado"]];
  notas.filter(n=>["enviada_sap","aprobada_sap"].includes(n.estado)).forEach(n=>{
    const f=n.registroFinal||n.modActual||n.form;
    f.lineas.filter(l=>l.nombre).forEach(l=>{
      rows.push([n.ndv,f.nombreCliente,f.codigoCliente,fmtD(f.fecha),f.tipoDevolucion,f.descripcionMotivo,n.rrvvNombre,l.codigo,l.nombre,l.porc15==="si"?"Sí":"No",l.medVital==="si"?"Sí":"No",l.cantidad,l.lote,fmtD(l.fechaVenc),l.facturaNo,l.destino,l.cantStock,l.cantDestruccion,STL[n.estado]]);
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
  const [invites,setInvites]   = useState([]);
  const [emailConfig,setEmailConfig] = useState({serviceId:"",templateId:"",publicKey:""});
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
        const [us,mo,pl,fa,no,inv]=await Promise.all([
          db.users.list(),
          db.motivos.list(),
          db.plotes.list(),
          db.facturas.list(),
          db.notas.list(),
          db.invites.list(),
        ]);
        // Supabase es la única fuente de verdad para usuarios.
        // Si la tabla está vacía (instalación nueva sin seed), usar INIT_USERS como fallback visual.
        setUsers(us.length>0?us:INIT_USERS);
        setMotivos(mo); setPlotes(pl); setFacturas(fa);
        setNotas(no); setInvites(inv);
      }catch(e){
        setDbError(e.message||"Error al conectar con Supabase");
      }finally{
        setLoading(false);
      }
    })();
  },[]);

  const canCreate=["rrvv","asistente"].includes(user?.role);
  const onActivate=async(invite,username,password)=>{
    try{
      const newUser=await db.users.insert({username,password,role:invite.role,name:invite.name,email:invite.email,active:true,confirmed:true});
      setUsers(us=>[...us,newUser]);
      await db.invites.update(invite.id,{status:"used"});
      setInvites(inv=>inv.map(i=>i.id===invite.id?{...i,status:"used"}:i));
    }catch(e){ notify("Error al activar cuenta: "+e.message); }
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
  if(!user) return <><ToastHost/><Login users={users} onLogin={setUser} invites={invites} onActivate={onActivate}/></>;

  const logout=()=>{ setUser(null); setView("lista"); setTab(""); };

  if(view==="nueva") return <div style={s.app}><ToastHost/><Header user={user} setView={setView} notas={notas} onLogout={logout}/><NotaForm user={user} users={users} motivos={motivos} plotes={plotes} facturas={facturas} setNotas={setNotas} onBack={()=>setView("lista")}/></div>;
  if(view==="detalle"&&selId){ const nota=notas.find(n=>n.id===selId); if(nota) return <div style={s.app}><ToastHost/><Header user={user} setView={setView} notas={notas} onLogout={logout}/><NotaDetail nota={nota} user={user} setNotas={setNotas} plotes={plotes} facturas={facturas} onBack={()=>setView("lista")}/></div>; }
  if(view==="maestros"&&user.role==="admin") return <div style={s.app}><ToastHost/><Header user={user} setView={setView} notas={notas} onLogout={logout}/><div style={s.nav}><button style={s.nBtn(false)} onClick={()=>setView("lista")}>← Notas</button><button style={s.nBtn(true)}>🗂️ Maestros</button></div><DatosMaestros motivos={motivos} setMotivos={setMotivos} plotes={plotes} setPlotes={setPlotes} facturas={facturas} setFacturas={setFacturas}/></div>;
  if(view==="usuarios"&&user.role==="admin") return <div style={s.app}><ToastHost/><Header user={user} setView={setView} notas={notas} onLogout={logout}/><div style={s.nav}><button style={s.nBtn(false)} onClick={()=>setView("lista")}>← Notas</button><button style={s.nBtn(true)}>👥 Usuarios</button></div><UserManager users={users} setUsers={setUsers} invites={invites} setInvites={setInvites} currentUser={user} emailConfig={emailConfig} setEmailConfig={setEmailConfig}/></div>;

  return (
    <div style={s.app}><ToastHost/>
      <Header user={user} setView={setView} notas={notas} onLogout={logout}/>
      <div style={s.nav}>{NAV.map(t=><button key={t.k} style={s.nBtn(activeTab===t.k)} onClick={()=>setTab(t.k)}>{t.l}</button>)}</div>
      <div style={s.page}>
        <Stats notas={notas} user={user}/>
        <div style={s.card}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={s.title}>📄 Notas de Devolución</div>
            {canCreate&&<button style={s.btn()} onClick={()=>setView("nueva")}>+ Nueva Nota</button>}
          </div>
          {filteredNotas.length===0?(
            <div style={{textAlign:"center",padding:40,color:C.gray}}>No hay notas en esta categoría.{canCreate&&<div style={{marginTop:8}}><button style={s.btn()} onClick={()=>setView("nueva")}>Crear primera nota</button></div>}</div>
          ):(
            <div style={{overflowX:"auto"}}>
              <table style={s.tbl}>
                <thead><tr>{["Nº Nota","Cliente","Fecha","Tipo",user.role==="bodeguero"?"Vendedor":"RRVV","Creada por","Estado",""].map(h=><th key={h} style={s.th}>{h}</th>)}</tr></thead>
                <tbody>{filteredNotas.map(n=>(
                  <tr key={n.id}>
                    <td style={{...s.td,fontWeight:"bold",color:C.primary}}>{n.ndv}</td>
                    <td style={s.td}>{n.form.nombreCliente}</td>
                    <td style={s.td}>{fmtD(n.form.fecha)}</td>
                    <td style={s.td}>{n.form.tipoDevolucion}</td>
                    <td style={s.td}>{user.role==="bodeguero"?(()=>{
                        const facUsadas=new Set(n.form.lineas.map(l=>l.facturaNo).filter(Boolean));
                        const vends=[...new Set(facturas.filter(fc=>fc.codCliente===n.form.codigoCliente&&facUsadas.has(fc.noFactura)).map(fc=>fc.vendedor).filter(Boolean))];
                        return vends.length>0?vends.join(", "):n.rrvvNombre;
                      })():n.rrvvNombre}</td>
                    <td style={s.td}>{n.creadoPorNombre}</td>
                    <td style={s.td}><span style={s.bdg(STC[n.estado]||C.gray)}>{STL[n.estado]||TAB_LABELS[n.estado]||n.estado}</span></td>
                    <td style={s.td}><button style={s.btn(C.accent,true)} onClick={()=>{setSelId(n.id);setView("detalle");}}>Ver</button></td>
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
