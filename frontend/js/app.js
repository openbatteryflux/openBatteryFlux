/* openBatteryFlux frontend.
   Everything runs after the cell library has been fetched from the API. */
(async function boot(){
try{
if(!(await OBF.startLibrary()))return;
const $=s=>document.querySelector(s);
const RM=matchMedia("(prefers-reduced-motion:reduce)").matches;
/* ---------- cell library (comes from the backend API) ---------- */
const CHN=OBF.library.names,CH=OBF.library.chemistries,CELLS=OBF.library.cells;
const keepCell=id=>CELLS[id]?id:"";
const HERO_CELLS=["molicel-inr-21700-p60c","tenpower-ifr26700-45he","highstar-nacr46145-15pr","toshiba-scib","ses-h10p"].map(keepCell).filter(Boolean);
const DEF=HERO_CELLS[0]||Object.keys(CELLS)[0];
let hCell=DEF,hc=0;
/* The physics and the optimiser live in js/solver.js, shared with the worker. */
const {ocv,conf,confP,profStats,sim,simP,vlLim,predict,predictT,nm,met,invOcv,rcSet,RCS,ocvx,rsx,socF,bvg,clp,rbv,pmax}=OBFSolver;
function heroBadge(){const hd=$("#hdemo");if(!hd)return;hd.textContent="";const dot=document.createElement("i");dot.className="live";dot.setAttribute("aria-hidden","true");hd.append(dot,CELLS[hCell].n+" · discharge")}heroBadge();
let CAL={};const cellOf=id=>SM.cal&&CAL[id]?{...CELLS[id],...CAL[id]}:CELLS[id];

const ECMN={R:"R₀ only: instant voltage drop, no relaxation.","1RC":"R₀ + one RC pair: the lumped library model.","2RC":"R₀ + two RC pairs: fast and slow polarisation.","3RC":"R₀ + three RC pairs: charge transfer, diffusion and slow relaxation."};let KECM="1RC";



function ticks(a,b){const r=(b-a)||1,w=r/5,p=Math.pow(10,Math.floor(Math.log10(w))),f=w/p,s=(f<1.5?1:f<3?2:f<7?5:10)*p,o=[];for(let v=Math.ceil(a/s)*s;v<=b+1e-9;v+=s)o.push(+v.toFixed(6));return o}
const ALL=Object.values(CELLS),mxE=Math.max(...ALL.map(c=>c.E)),mnP=Math.min(...ALL.map(c=>c.P)),mxP=Math.max(...ALL.map(c=>c.P)),mnA=Math.min(...ALL.map(c=>c.Ah)),mxA=Math.max(...ALL.map(c=>c.Ah)),CHS=Object.keys(CHN);
{const st=document.querySelectorAll(".hstats b[data-count]");if(st[0])st[0].dataset.count=ALL.length;if(st[1])st[1].dataset.count=CHS.length;if(st[2])st[2].dataset.count=new Set(ALL.map(c=>c.brand)).size}
const nz=(v,a,b)=>Math.max(4,(Math.log(v)-Math.log(a))/(Math.log(b)-Math.log(a))*100);
const cellOptions=sel=>CHS.map(g=>`<optgroup label="${CHN[g]}">`+Object.entries(CELLS).filter(([k,c])=>c.ch===g).map(([k,c])=>`<option value="${k}"${k===sel?" selected":""}>${c.n} · ${c.kind}</option>`).join("")+"</optgroup>").join("");
let CMP=[],SIM=[],LBSEL=[],VIEW="grid",KDS=[],KVi=0,KF=null,KSIGN=1,cmpBuilt=false;
/* Compare holds four cells, Simulate three (its layout, load split and
   voltage-limit overrides are built around three slots). */
const COMPARE_MAX=4,SIM_MAX=3;
/* ---------- hero demo ---------- */
let hMode="",hTgt=null;
function heroDyn(c,C,T){const bak=Object.assign({},SM);let o=null;try{Object.assign(SM,{sc:"drive",unit:"C",dir:1,mean:C,peak:Math.max(C*2.5,C*1.1),reps:3,T,soh:100,soc0:100,up:null,ecm:"1RC",rct:false});
const r=simP(c,buildProf()),s=Math.max(1,Math.ceil(r.t.length/400)),q=[],v=[],cf=[];let a=0;for(let i=0;i<r.t.length;i++){a+=r.I[i]/3600;if(i%s===0||i===r.t.length-1){q.push(a);v.push(r.V[i]);cf.push(r.cf[i])}}o={q,v,cf,Q:r.Q,E:r.E}}finally{Object.assign(SM,bak)}return o}
function hero(){const c=CELLS[hCell],C=+$("#hC").value,T=+$("#hT").value;const lb=document.querySelector('label[for="hC"] span');if(lb)lb.textContent=hMode==="dyn"?"Mean C-rate":"C-rate";$("#hCo").textContent=C.toFixed(1)+" C";$("#hTo").textContent=T+" °C";rp($("#hC"));rp($("#hT"));
const o=hMode==="dyn"?heroDyn(c,C,T):sim(c,{mode:"discharge",C,T,soh:100,soc0:100});if(!o||o.q.length<2)return;const bw=o.cf.map(x=>(1-x)*.25),first=!$("#hplot")._o;
const ylo=Math.max(1.0,c.Vmin-.2),yhi=Math.min(5.0,c.Vmax+.2);
plot($("#hplot"),{series:[{name:"Voltage",x:o.q,y:o.v,col:"var(--acc-d)",w:3.5,fmt:v=>v.toFixed(3)+" V",ext:o.cf.map(x=>x<.9?1:0),band:[o.v.map((v,i)=>v-bw[i]),o.v.map((v,i)=>v+bw[i])],anim:first}],xl:"Capacity (Ah)",yl:"Voltage (V)",H:220,nolegend:true,fx:v=>v.toFixed(2)+" Ah",ymin:ylo,ymax:yhi,al:"Live discharge curve"});
const mn=Math.min(...o.cf),el=$("#hSt");el.textContent=mn<.9?"Extrapolating":"Inside datasheet";el.className="st "+(mn<.9?"xo":"in");
tweenNum($('[data-hk="q"]'),o.Q,v=>v.toFixed(2)+" Ah");tweenNum($('[data-hk="e"]'),o.E,v=>v.toFixed(1)+" Wh");tweenNum($('[data-hk="c"]'),mn*100,v=>v.toFixed(0)+" %");
document.querySelectorAll("#hq button").forEach(b=>b.setAttribute("aria-pressed",hTgt?(b.dataset.m||"")===hTgt.m&&+b.dataset.c===hTgt.c&&+b.dataset.t===hTgt.t:(b.dataset.m||"")===hMode&&Math.abs(+b.dataset.c-C)<.01&&Math.abs(+b.dataset.t-T)<1))}
["hC","hT"].forEach(i=>$("#"+i).addEventListener("input",()=>{HA.user();window.hSw=performance.now()+250;hero()}));hero();
/* hero autoplay: Nominal -> Dynamic profile -> Cold -10 C -> Fast 3C, pauses on any interaction */
const HS=[{m:"",c:1,t:25},{m:"dyn",c:1,t:25},{m:"",c:1,t:-10},{m:"",c:3,t:25}];let hVis=true;
const HA=(()=>{let i=0,tm=0,raf=0,idle=0,run=false,last=0;const C=$("#hC"),T=$("#hT");
function go(s){window.hSw=performance.now()+1500;cancelAnimationFrame(raf);hMode=s.m;hTgt=s;const c0=+C.value,t0=+T.value,s0=performance.now(),D=1100;
const step=t=>{const k=Math.min(1,(t-s0)/D),e=k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2;if(t-last>45||k===1){C.value=(c0+(s.c-c0)*e).toFixed(2);T.value=Math.round(t0+(s.t-t0)*e);hero();last=t}if(k<1)raf=requestAnimationFrame(step)};raf=requestAnimationFrame(step)}
function tick(){if(!run)return;if(document.hidden||!hVis){tm=setTimeout(tick,800);return}i=(i+1)%HS.length;hc=(hc+1)%HERO_CELLS.length;hCell=HERO_CELLS[hc];heroBadge();go(HS[i]);tm=setTimeout(tick,6400)}
function start(){if(RM||run)return;run=true;clearTimeout(tm);tm=setTimeout(tick,3200)}
function stop(){run=false;clearTimeout(tm)}
return{start,stop,user(){cancelAnimationFrame(raf);hTgt=null;stop();clearTimeout(idle);idle=setTimeout(start,9000)},
hover(on){if(on){stop();clearTimeout(idle)}else{clearTimeout(idle);idle=setTimeout(start,2500)}},sync(m){i=Math.max(0,HS.findIndex(s=>s.m===m))}}})();
{const d=$(".nb-demo");if(d){if("IntersectionObserver"in window)new IntersectionObserver(es=>{hVis=es[0].isIntersecting}).observe(d);
d.addEventListener("pointerenter",e=>{if(e.pointerType==="mouse")HA.hover(true)});d.addEventListener("pointerleave",e=>{if(e.pointerType==="mouse")HA.hover(false)});d.addEventListener("focusin",()=>HA.user());HA.start()}}
/* ---------- account (sessions live on the server, see js/account.js) ---------- */
let currentUser=null;const getUser=async()=>{const u=await OBFAccount.user();currentUser=u;return u;};
const renderAuth=()=>OBFAccount.renderAuthBox();
function heroAuth(){const g=!currentUser;const lg=$("#leadGuest"),lu=$("#leadUser");if(lg)lg.hidden=g;if(lu)lu.hidden=!g;const b=$("#ctaSim");if(b)b.textContent=g?"Start simulating, free →":"Start simulating"}
const openAuth=t=>OBFAccount.openAuth(t);
/* ---------- donate / dialogs ---------- */
let DA={f:"once",a:15};
function donUpd(){$("#dgo").textContent=(DA.a?`Donate €${DA.a} ${DA.f==="once"?"once":"monthly"}`:"Choose your amount")+" ↗";document.querySelectorAll("#dfreq button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.f===DA.f));document.querySelectorAll("#damt button").forEach(b=>b.setAttribute("aria-pressed",+b.dataset.a===DA.a))}
$("#dfreq").onclick=e=>{if(e.target.dataset.f){DA.f=e.target.dataset.f;donUpd()}};$("#damt").onclick=e=>{if(e.target.dataset.a!==undefined){DA.a=+e.target.dataset.a;donUpd()}};donUpd();
document.addEventListener("click",e=>{if(e.target.closest("#dbtn,[data-open=don]")){e.preventDefault();$("#don").showModal()}const c=e.target.closest("[data-close]");if(c)c.closest("dialog").close()});
document.addEventListener("click",e=>{if(!e.target.closest(".faq"))document.querySelectorAll(".faq details[open]").forEach(d=>d.removeAttribute("open"))});
/* ---------- library ---------- */
const LS={q:"",ch:[],brand:"",fmt:"",sort:"E",dir:-1};
const mb=(l,w,t)=>`<div class="mb"><span>${l}</span><div><i style="width:${w}%"></i></div><b>${t}</b></div>`;
/* The stagger only makes sense for the cards on screen. Letting every one of a
   thousand cards keep its own animation delay queued up (45 s of delays in
   total) cost more than it showed, so the delay stops growing after the first
   screenful. */
function cellCard(k,c,i){const on=LBSEL.includes(k);return `<article class="card lc" data-id="${k}" style="--c:var(--c-${c.ch});animation-delay:${Math.min(i,24)*35}ms"><div class="ch"><span class="tag">${c.s}</span><span class="kind">${c.kind}</span><div class="ring" style="--p:${c.cov}"><b>${c.cov}%</b></div></div><h3>${c.n}</h3><p class="mt">${c.form} · ${c.m} g · ${f1c(c.dsC[1])} C max · ${c.dsT.join("–")} °C</p>${mb("Energy",c.E/mxE*100,c.E.toFixed(0)+" Wh/kg")}${mb("Power",nz(c.P,mnP,mxP),c.P.toFixed(0)+" W/kg")}${mb("Capacity",nz(c.Ah,mnA,mxA),c.Ah+" Ah")}<div class="acts"><button type="button" class="cb" data-lsel="${k}" aria-pressed="${on}">${on?"✓ Selected":"+ Select"}</button><button type="button" class="cb" data-detail="${k}">Details</button></div></article>`}
$("#lch").innerHTML=CHS.map(k=>`<button type="button" data-k="${k}" aria-pressed="false"><span style="color:var(--c-${k})">●</span> ${CHN[k]}</button>`).join("");
(function(){const un=a=>[...new Set(a)].sort();const br=un(ALL.map(c=>c.brand));const fm=un(ALL.map(c=>c.form));$("#lfbrand").innerHTML='<option value="">Any manufacturer</option>'+br.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("");$("#lfform").innerHTML='<option value="">Any form</option>'+fm.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("");})();
$("#pleg").innerHTML=CHS.map(k=>`<span><i style="background:var(--c-${k})"></i>${CHN[k]}</span>`).join("")+"<span>┄ iso-time</span><span>╌ Pareto frontier</span>";
let lqT=null;$("#lq").oninput=e=>{LS.q=e.target.value.toLowerCase();clearTimeout(lqT);lqT=setTimeout(libRender,150)};$("#lfbrand").onchange=e=>{LS.brand=e.target.value;libRender()};$("#lfform").onchange=e=>{LS.form=e.target.value;libRender()};
$("#lview").onclick=e=>{const v=e.target.dataset.v;if(v){VIEW=v;document.querySelectorAll("#lview button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.v===v));libRender()}};
$("#lch").onclick=e=>{const b=e.target.closest("button");if(!b)return;const k=b.dataset.k,i=LS.ch.indexOf(k);i<0?LS.ch.push(k):LS.ch.splice(i,1);libRender()};
function syncResetStates(){
  const V=id=>{const e=document.getElementById(id);return e?e.value:"";};
  const libOn=!!(LS.q||LS.brand||LS.ch.length||LS.form||LS.sort!=="E"||LS.dir!==-1);
  const lr=document.getElementById("lres");if(lr)lr.hidden=!libOn;
  const pickOn=!!(V("cpq")||V("cpbrand")||V("cpch")||V("cpform"));
  const pr=document.getElementById("cpreset");if(pr)pr.hidden=!pickOn;
}
function filterReset(id){
  if(id==="liball"){
    LS.q="";LS.brand="";LS.ch=[];LS.form="";LS.sort="E";LS.dir=-1;
    ["lq","lfbrand","lfform"].forEach(i=>{const e=document.getElementById(i);if(e)e.value="";});
    libRender();
  }else if(id==="pickall"){
    ["cpq","cpbrand","cpch","cpform"].forEach(i=>{const e=document.getElementById(i);if(e)e.value="";});
    renderPickList();
  }
}

function hull(P){P=P.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);if(P.length<3)return P;const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]),lo=[],up=[];for(const p of P){while(lo.length>1&&cr(lo[lo.length-2],lo[lo.length-1],p)<=0)lo.pop();lo.push(p)}for(const p of P.slice().reverse()){while(up.length>1&&cr(up[up.length-2],up[up.length-1],p)<=0)up.pop();up.push(p)}return lo.slice(0,-1).concat(up.slice(0,-1))}
function ragone(L,zst){const el=$("#plot");el._L=L;if(!el._ro&&window.ResizeObserver){el._ro=1;new ResizeObserver(()=>{const w=el.clientWidth;if(w>0&&Math.abs(w-(el._w||0))>8&&el._L)ragone(el._L,el._zs)}).observe(el)}
if(!el._zi){el._zi=1;
const lg=Math.log10,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const getWH=()=>{const W=Math.max(300,Math.round(el.clientWidth||820)),H=Math.round(Math.min(Math.max(W*.62,320),560));return{W,H,Lm:58,Rm:14,Tm:12,Bm:46}};
const px2e=(px,W,Lm,Rm,z)=>Math.pow(10,lg(z.x0)+(px-Lm)/(W-Lm-Rm)*(lg(z.x1)-lg(z.x0)));
const px2p=(py,H,Bm,Tm,z)=>Math.pow(10,lg(z.y0)+(H-Bm-py)/(H-Bm-Tm)*(lg(z.y1)-lg(z.y0)));
const constrain=z=>{z.x0=clamp(z.x0,20,490);z.x1=clamp(z.x1,Math.max(z.x0*1.05,30),700);z.y0=clamp(z.y0,10,3500);z.y1=clamp(z.y1,Math.max(z.y0*1.05,50),10000);return z};
const fitView=(Ls)=>{let e0=1e9,e1=0,p0=1e9,p1=0;Ls.forEach(([k,c])=>{e0=Math.min(e0,c.E);e1=Math.max(e1,c.E);p0=Math.min(p0,c.P);p1=Math.max(p1,c.P)});const pad=1.15;return constrain({x0:e0/pad,x1:e1*pad,y0:p0/pad,y1:p1*pad})};
const zoomAt=(cx,cy,fx,fy)=>{const{W,H,Lm,Rm,Tm,Bm}=getWH(),z=el._zs;const ex=px2e(cx,W,Lm,Rm,z),ep=px2p(cy,H,Bm,Tm,z),lx=lg(z.x1)-lg(z.x0),ly=lg(z.y1)-lg(z.y0),rx=(cx-Lm)/(W-Lm-Rm),ry=(H-Bm-cy)/(H-Bm-Tm);el._zs=constrain({x0:ex*Math.pow(10,-rx*lx/fx),x1:ex*Math.pow(10,(1-rx)*lx/fx),y0:ep*Math.pow(10,-ry*ly/fy),y1:ep*Math.pow(10,(1-ry)*ly/fy)});ragone(el._L,el._zs)};
const panBy=(dx,dy)=>{const{W,H,Lm,Rm,Tm,Bm}=getWH(),z=el._zs;const de=-dx/(W-Lm-Rm)*(lg(z.x1)-lg(z.x0)),dp=dy/(H-Bm-Tm)*(lg(z.y1)-lg(z.y0));el._zs=constrain({x0:Math.pow(10,lg(z.x0)+de),x1:Math.pow(10,lg(z.x1)+de),y0:Math.pow(10,lg(z.y0)-dp),y1:Math.pow(10,lg(z.y1)-dp)});ragone(el._L,el._zs)};
el.addEventListener("wheel",e=>{e.preventDefault();const r=el.getBoundingClientRect(),f=Math.pow(1.15,e.deltaY<0?1:-1);zoomAt(e.clientX-r.left,e.clientY-r.top,f,f)},{passive:false});
el.addEventListener("dblclick",()=>{el._zs=fitView(el._L);ragone(el._L,el._zs)});
let drag=null;el.addEventListener("pointerdown",e=>{if(e.button!==0||e.target.closest(".pt"))return;el.setPointerCapture(e.pointerId);drag={x:e.clientX,y:e.clientY}});
el.addEventListener("pointermove",e=>{if(!drag)return;panBy(e.clientX-drag.x,e.clientY-drag.y);drag={x:e.clientX,y:e.clientY}});
el.addEventListener("pointerup",()=>{drag=null});
let pinch=null;el.addEventListener("touchstart",e=>{if(e.touches.length===2){e.preventDefault();pinch={d:Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY),cx:(e.touches[0].clientX+e.touches[1].clientX)/2,cy:(e.touches[0].clientY+e.touches[1].clientY)/2}}},{passive:false});
el.addEventListener("touchmove",e=>{if(pinch&&e.touches.length===2){e.preventDefault();const r=el.getBoundingClientRect(),d2=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);zoomAt(pinch.cx-r.left,pinch.cy-r.top,d2/pinch.d,d2/pinch.d);pinch.d=d2}},{passive:false});
el.addEventListener("touchend",()=>{pinch=null});
if(!el._zs)el._zs=fitView(L);
}
const _z=zst||el._zs;el._zs=_z;
const W=Math.max(300,Math.round(el.clientWidth||820)),H=Math.round(Math.min(Math.max(W*.62,320),560)),Lm=58,Rm=14,Tm=12,Bm=46,x0=_z.x0,x1=_z.x1,y0=_z.y0,y1=_z.y1,lg=Math.log10;el._w=W;
const X=v=>Lm+(lg(v)-lg(x0))/(lg(x1)-lg(x0))*(W-Lm-Rm),Y=v=>H-Bm-(lg(v)-lg(y0))/(lg(y1)-lg(y0))*(H-Bm-Tm),f1=n=>n.toFixed(1);
let s=`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Ragone plot of the cell library"><defs><clipPath id="rc"><rect x="${Lm}" y="${Tm}" width="${W-Lm-Rm}" height="${H-Bm-Tm}"/></clipPath></defs>`;
const niceTicks=(lo,hi)=>{lo=Math.max(lo,1e-9);const t=[];let d=Math.pow(10,Math.floor(Math.log10(lo)));while(d<=hi*1.001){for(const m of [1,2,5]){const v=m*d;if(v>=lo&&v<=hi)t.push(v)}d*=10}return t};
const allTicks=(lo,hi)=>{lo=Math.max(lo,1e-9);const t=[];let d=Math.pow(10,Math.floor(Math.log10(lo)));while(d<=hi*1.001){for(let m=1;m<10;m++){const v=m*d;if(v>=lo&&v<=hi)t.push(v)}d*=10}return t};
const mjY=niceTicks(y0,y1),mjX=niceTicks(x0,x1),mnY=allTicks(y0,y1).filter(v=>!mjY.includes(v)),mnX=allTicks(x0,x1).filter(v=>!mjX.includes(v));
mnY.forEach(v=>s+=`<path class="gm" d="M${Lm} ${Math.round(Y(v))+.5}H${W-Rm}"/>`);mnX.forEach(v=>s+=`<path class="gm" d="M${Math.round(X(v))+.5} ${Tm}V${H-Bm}"/>`);
mjY.forEach(v=>s+=`<path class="gM" d="M${Lm} ${Math.round(Y(v))+.5}H${W-Rm}"/><path class="tk" d="M${Lm} ${Math.round(Y(v))+.5}h6M${W-Rm} ${Math.round(Y(v))+.5}h-6"/><text class="tl" x="${Lm-8}" y="${f1(Y(v)+4)}" text-anchor="end">${fmtT(v)}</text>`);
mjX.forEach(v=>s+=`<path class="gM" d="M${Math.round(X(v))+.5} ${Tm}V${H-Bm}"/><path class="tk" d="M${Math.round(X(v))+.5} ${H-Bm}v-6M${Math.round(X(v))+.5} ${Tm}v6"/><text class="tl" x="${f1(X(v))}" y="${H-Bm+17}" text-anchor="middle">${v}</text>`);
mnY.forEach(v=>s+=`<path class="tk" d="M${Lm} ${Math.round(Y(v))+.5}h3M${W-Rm} ${Math.round(Y(v))+.5}h-3"/>`);mnX.forEach(v=>s+=`<path class="tk" d="M${Math.round(X(v))+.5} ${H-Bm}v-3M${Math.round(X(v))+.5} ${Tm}v3"/>`);
s+=`<rect class="fr" x="${Lm+.5}" y="${Tm+.5}" width="${W-Lm-Rm}" height="${H-Bm-Tm}"/>`;
s+=`<path d="M${Lm} ${H-Bm}H${W-Rm}" stroke="var(--mut)" opacity=".5"/><text x="${(Lm+W-Rm)/2}" y="${H-6}" text-anchor="middle" font-size="12" fill="var(--mut)">Specific energy (Wh/kg)</text><text transform="translate(13 ${(Tm+H-Bm)/2}) rotate(-90)" text-anchor="middle" font-size="12" fill="var(--mut)">Specific power at max datasheet C-rate (W/kg)</text><g clip-path="url(#rc)">`;
const TL=[[1,"1 h"],[.25,"15 min"],[.1,"6 min"],[.05,"3 min"]];
for(const [t] of TL)s+=`<path d="M${f1(X(x0))} ${f1(Y(x0/t))}L${f1(X(x1))} ${f1(Y(x1/t))}" stroke="var(--mut)" stroke-dasharray="2 6" opacity=".55"/>`;
const pos={};L.forEach(([k,c])=>{pos[k]=[X(c.E),Y(c.P)]});
const sig=L.map(([k])=>k).join("|");
if(el._hsig!==sig){el._hsig=sig;el._hull={};L.forEach(([k,c])=>{const ch=c.ch;(el._hull[ch]=el._hull[ch]||[]).push([Math.log10(c.E),Math.log10(c.P)])});for(const ch in el._hull)el._hull[ch]=hull(el._hull[ch])}
const G={};L.forEach(([k,c])=>(G[c.ch]=G[c.ch]||[]).push(pos[k]));let hs="",lb="";
for(const ch in G){const P=G[ch],col=`var(--c-${ch})`,Hv=el._hull[ch];let sh;if(Hv&&Hv.length>=3)sh=`<polygon points="${Hv.map(p=>f1(X(Math.pow(10,p[0])))+","+f1(Y(Math.pow(10,p[1])))).join(" ")}" fill="${col}" stroke="${col}" stroke-width="26" stroke-linejoin="round"/>`;else if(P.length===2)sh=`<path d="M${f1(P[0][0])} ${f1(P[0][1])}L${f1(P[1][0])} ${f1(P[1][1])}" stroke="${col}" stroke-width="26" stroke-linecap="round"/>`;else sh=`<circle cx="${f1(P[0][0])}" cy="${f1(P[0][1])}" r="13" fill="${col}"/>`;
hs+=sh;const mx=P.reduce((a,p)=>a+p[0],0)/P.length,my=Math.min(...P.map(p=>p[1]))-20;lb+=`<text x="${f1(Math.min(W-Rm-24,Math.max(Lm+24,mx)))}" y="${f1(Math.max(Tm+10,my))}" text-anchor="middle" font-size="11" font-weight="700" fill="${col}" style="paint-order:stroke;stroke:var(--panel);stroke-width:3px">${CHN[ch]}</text>`}
s+=`<g opacity=".13" pointer-events="none">${hs}</g></g>`;
for(const [t,l] of TL){const xe=Math.min(x1*.98,y1*t*.97);s+=`<text x="${f1(X(xe)-4)}" y="${f1(Y(xe/t)-5)}" text-anchor="end" font-size="10" fill="var(--mut)">${l}</text>`}
s+=lb;
const fr=[];let best=-1;[...L].sort((a,b)=>b[1].E-a[1].E).forEach(([k,c])=>{if(c.P>best){fr.push(c);best=c.P}});fr.reverse();
if(fr.length>1)s+=`<path class="pf" d="${fr.map((c,i)=>(i?"L":"M")+f1(X(c.E))+","+f1(Y(c.P))).join("")}" fill="none" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="7 5" opacity=".55"/>`;
[...L].sort((a,b)=>b[1].Ah-a[1].Ah).forEach(([k,c],i)=>{s+=`<circle class="pt" data-id="${k}" tabindex="0" role="img" aria-label="${c.n}, ${c.E.toFixed(0)} Wh/kg, ${c.P.toFixed(0)} W/kg" cx="${f1(pos[k][0])}" cy="${f1(pos[k][1])}" r="${(5+Math.sqrt(c.Ah)*.9).toFixed(1)}" fill="color-mix(in srgb,var(--c-${c.ch}) 50%,var(--panel))" stroke="var(--c-${c.ch})" stroke-width="2" style="animation-delay:${Math.min(i*40,800)}ms"/>`});
el.innerHTML=s+'</svg>';el.style.cursor="grab"}
const HL={n:"Cell",kind:"Type",Ah:"Ah",g:"g",E:"Wh/kg",P:"W/kg",Cmax:"C max",cov:"Cov."};
function tblHead(){let h="<tr>";for(const k in HL){const on=LS.sort===k;h+=`<th data-sort="${k}" aria-sort="${on?(LS.dir<0?"descending":"ascending"):"none"}">${HL[k]}${on?(LS.dir<0?" ▾":" ▴"):""}</th>`;}return h+"<th></th></tr>";}
/* Building every one of a thousand cards up front was most of what opening the
   library cost, and the browser only paints a few dozen at a time anyway. The
   first screenful is built at once and the rest follow a page at a time from
   the button under the list, so the page is usable immediately. */
const LIB_PAGE=96;let libItems=[],libAt=0,libTable=false;
function libRow([k,c]){return `<tr data-id="${k}" style="--c:var(--c-${c.ch})"><td><span class="dot"></span>${c.n}</td><td>${c.kind}</td><td>${c.Ah}</td><td>${c.m}</td><td>${c.E.toFixed(0)}</td><td>${c.P.toFixed(0)}</td><td>${f1c(c.dsC[1])}</td><td>${c.cov}%</td><td><button type="button" class="cb" data-lsel="${k}" aria-pressed="${LBSEL.includes(k)}">${LBSEL.includes(k)?"✓":"+"}</button></td></tr>`}
function libFoot(){const box=$("#lmore");if(!box)return;const left=libItems.length-libAt;
box.innerHTML=left>0?`<button type="button" class="btn" data-libmore>Show ${Math.min(left,LIB_PAGE)} more · ${left} left</button>`:""}
function libMore(){const box=libTable?$("#llist tbody"):$("#llist .lgrid");if(!box)return;const part=libItems.slice(libAt,libAt+LIB_PAGE);if(!part.length)return;
box.insertAdjacentHTML("beforeend",part.map((e,j)=>libTable?libRow(e):cellCard(e[0],e[1],libAt+j)).join(""));libAt+=part.length;libFoot()}
/* The chart links to a card that may not have been built yet: build up to it
   in one insertion rather than a page at a time, which would re-lay out the
   grid once per page. */
function libShow(id){let el=document.querySelector(`#llist [data-id="${id}"]`);if(el)return el;
const idx=libItems.findIndex(e=>e[0]===id);if(idx<0)return null;
const box=libTable?$("#llist tbody"):$("#llist .lgrid");if(!box)return null;
const part=libItems.slice(libAt,Math.max(idx+1,libAt+LIB_PAGE));
box.insertAdjacentHTML("beforeend",part.map((e,j)=>libTable?libRow(e):cellCard(e[0],e[1],libAt+j)).join(""));libAt+=part.length;libFoot();
return document.querySelector(`#llist [data-id="${id}"]`)}
function list(L){const el=$("#llist");libItems=L;libAt=0;libTable=VIEW==="table";
if(!L.length){el.className="";el.innerHTML='<p class="sub">No cell matches this filter.</p>';return}
el.className="";
el.innerHTML=libTable?`<div class="card tbl"><table><thead>${tblHead()}</thead><tbody></tbody></table></div><div class="libmore" id="lmore"></div>`:`<div class="lgrid"></div><div class="libmore" id="lmore"></div>`;
libMore()}
function libRender(){document.querySelectorAll("#lch button").forEach(b=>b.setAttribute("aria-pressed",LS.ch.includes(b.dataset.k)));
const L=Object.entries(CELLS).filter(([k,c])=>(!LS.brand||c.brand===LS.brand)&&(!LS.form||c.form===LS.form)&&(!LS.ch.length||LS.ch.includes(c.ch))&&(!LS.q||(c.n+" "+c.brand+" "+c.s+" "+c.form+" "+c.kind).toLowerCase().includes(LS.q))),sorters={n:c=>c.n,kind:c=>c.kind||"",Ah:c=>c.Ah,g:c=>c.m,E:c=>c.E,P:c=>c.P,Cmax:c=>c.dsC[1],cov:c=>c.cov},gs=sorters[LS.sort]||sorters.E;
L.sort((a,b)=>{const x=gs(a[1]),y=gs(b[1]);return typeof x==="string"?(x<y?-1:x>y?1:0)*LS.dir:(x-y)*LS.dir});$("#lcount").textContent=L.length+" of "+ALL.length+" cells";ragone(L);list(L);syncResetStates()}
function hl(id,on){document.querySelectorAll(`[data-id="${id}"]`).forEach(e=>e.classList.toggle("hl",on))}
$("#plot").addEventListener("pointerover",e=>{const p=e.target.closest(".pt");if(!p)return;hl(p.dataset.id,true);const c=CELLS[p.dataset.id],r=p.getBoundingClientRect(),b=$("#plotc").getBoundingClientRect(),t=$("#tip");t.hidden=false;t.innerHTML=`<b>${c.n}</b> · ${c.kind}<br>${c.E.toFixed(0)} Wh/kg · ${c.P.toFixed(0)} W/kg<br>${c.m} g · ${f1c(c.dsC[1])} C max`;t.style.left=Math.max(8,Math.min(b.width-190,r.left-b.left+18))+"px";t.style.top=Math.max(8,r.top-b.top-12)+"px"});
$("#plot").addEventListener("pointerout",e=>{const p=e.target.closest(".pt");if(p){hl(p.dataset.id,false);$("#tip").hidden=true}});
$("#plot").addEventListener("click",e=>{const p=e.target.closest(".pt");if(p){const el=libShow(p.dataset.id);el&&el.scrollIntoView({behavior:"smooth",block:"center"})}});
/* ---------- cell detail modal ---------- */
function closeCellDetail(){$("#celldetail").hidden=true;document.body.classList.remove("pick-open")}
function cellDetail(k){const c=CELLS[k];if(!c)return;const el=$("#cdbody");if(!el)return;
const row=(l,v)=>v==null||v===""||v===0?`<div class="cd-row"><span>${l}</span><b>—</b></div>`:`<div class="cd-row"><span>${l}</span><b>${v}</b></div>`;
const d=c.dims||[],dims=d[3]?`Ø ${d[3]} × ${d[1]||d[0]} mm`:(d[0]&&d[1]?`${d[0]} × ${d[1]} × ${d[2]||"?"} mm`:null);
const chem=[c.cd,c.cathode,c.anode].filter(Boolean).join(" · ");
el.innerHTML=`<div class="cd-head" style="--c:var(--c-${c.ch})"><span class="tag">${c.s}</span><h2>${esc(c.n)}</h2><p>${esc(c.brand)} · ${esc(c.form)}${c.kind?" · "+esc(c.kind):""}${c.country?" · "+esc(c.country):""}${c.release?" · "+esc(c.release):""}</p></div>
<div class="cd-grid">${row("Capacity",c.Ah+" Ah")}${row("Mass",c.m+" g")}${row("Nominal voltage",c.V+" V")}${row("OCV (max)",c.Vocv?c.Vocv+" V":null)}${row("Cut-off voltage",c.Vcut?c.Vcut+" V":null)}${row("Max C-rate",f1c(c.dsC[1])+" C")}${row("Energy",c.Wh?c.Wh+" Wh":null)}${row("Specific energy",c.E.toFixed(0)+" Wh/kg")}${row("Specific power",c.P.toFixed(0)+" W/kg")}${row("Cycle life",c.cyc?c.cyc+" cycles":null)}${row("Internal resistance",c.ir?c.ir+" mΩ":null)}${row("Resistance factor",c.r0?c.r0.toFixed(3)+" Ω":null)}${row("Dimensions",dims)}${row("Volume",c.vol?c.vol+" cm³":null)}${row("Coverage",c.cov+" %")}</div>
${chem?`<div class="cd-sec"><h3>Chemistry</h3><p>${esc(chem)}</p></div>`:""}
<div class="cd-acts"><button type="button" class="btn p" data-lsel="${k}">${LBSEL.includes(k)?"✓ Selected":"+ Select for the bridge"}</button></div>`;
cellHit("view",k);OBFAccount.activity("view", null, k);
$("#celldetail").hidden=false;document.body.classList.add("pick-open")}
$("#llist").addEventListener("click",e=>{if(e.target.closest("[data-libmore]")){libMore();return}const b=e.target.closest("[data-detail]");if(b){cellDetail(b.dataset.detail);return}if(e.target.closest("[data-lsel],a,button"))return;const card=e.target.closest(".lc,tr[data-id]");if(card&&card.dataset.id)cellDetail(card.dataset.id)});
$("#celldetail").addEventListener("click",e=>{if(e.target.closest("[data-lsel]"))closeCellDetail()});
$("#cdx").onclick=closeCellDetail;$("#cdx2").onclick=closeCellDetail;
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("#celldetail").hidden)closeCellDetail()});
$("#llist").addEventListener("pointerover",e=>{const c=e.target.closest("[data-id]");c&&hl(c.dataset.id,true)});$("#llist").addEventListener("pointerout",e=>{const c=e.target.closest("[data-id]");c&&hl(c.dataset.id,false)});
$("#llist").addEventListener("click",e=>{const th=e.target.closest("th[data-sort]");if(!th)return;const k=th.dataset.sort;if(LS.sort===k)LS.dir*=-1;else{LS.sort=k;LS.dir=1}libRender()});
/* The library keeps one selection of up to four cells; the bridge row in the
   tray below sends that selection to any tool. */
function trayUpd(){$("#tray").hidden=!(LBSEL.length&&/^#\/library/.test(location.hash));if($("#tray").hidden)return;
$("#tin").innerHTML='<div class="bridge" data-bridge="library"></div>';bridgeFill($("#tin .bridge"));bridgeUpd()}
function syncSel(){document.querySelectorAll("[data-lsel]").forEach(b=>{const on=LBSEL.includes(b.dataset.lsel),tb=!!b.closest("td");b.setAttribute("aria-pressed",on);b.textContent=tb?(on?"✓":"+"):(on?"✓ Selected":"+ Select")});trayUpd()}
document.addEventListener("click",e=>{const b=e.target.closest("[data-lsel]");if(!b)return;const k=b.dataset.lsel,i=LBSEL.indexOf(k);
if(i>=0)LBSEL.splice(i,1);else if(LBSEL.length<COMPARE_MAX)LBSEL.push(k);
else{$("#tray").hidden=false;$("#tin").innerHTML="<b>Max "+COMPARE_MAX+" cells</b>";setTimeout(trayUpd,1400);return}syncSel()});
$("#tclr").onclick=()=>{LBSEL=[];syncSel()};
/* ---------- chart system (MATLAB-style axes) ---------- */
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;")}
function fmtT(v){const a=Math.abs(v);return a>=1000?+(v/1000).toFixed(1)+"k":String(+v.toFixed(a<1?3:a<10?2:1))}
const f1c=x=>String(Math.round(x*10)/10);   // 1.782 -> "1.8", 3.012 -> "3"
function niceStep(a,b,n){const r=(b-a)||1,w=r/n,p=Math.pow(10,Math.floor(Math.log10(w))),f=w/p;return(f<1.5?1:f<3?2:f<7?5:10)*p}
function axisTicks(a,b,n){const st=niceStep(a,b,n),p=Math.pow(10,Math.floor(Math.log10(st))),m=Math.round(st/p),nd=m===2?4:5,ms=st/nd,mj=[],mn=[];
for(let v=Math.ceil(a/st-1e-9)*st;v<=b+st*1e-9;v+=st)mj.push(+v.toFixed(10));
for(let v=Math.ceil(a/ms-1e-9)*ms;v<=b+ms*1e-9;v+=ms){const q=+v.toFixed(10);if(!mj.some(x=>Math.abs(x-q)<ms*.01))mn.push(q)}
return{mj,mn,dec:Math.max(0,-Math.floor(Math.log10(st)+1e-9))}}
function tl(v,d){return Math.abs(v)>=10000?(v/1000).toFixed(0)+"k":v.toFixed(Math.min(d,3))}
function mark(k,x,y,col,r){const f=n=>n.toFixed(1);if(k===undefined)return"";return k===0?`<circle cx="${f(x)}" cy="${f(y)}" r="${r}" fill="${col}" stroke="var(--panel)" stroke-width="1.2"/>`:k===1?`<rect x="${f(x-r)}" y="${f(y-r)}" width="${2*r}" height="${2*r}" fill="${col}" stroke="var(--panel)" stroke-width="1.2"/>`:`<path d="M${f(x)} ${f(y-r-1)}L${f(x+r+1)} ${f(y+r)}L${f(x-r-1)} ${f(y+r)}Z" fill="${col}" stroke="var(--panel)" stroke-width="1.2"/>`}
function plot(el,o){plotN(el,Object.assign({},o,{panels:[{series:o.series,yl:o.yl,ymin:o.ymin,ymax:o.ymax,ypad:o.ypad}],ph:o.H?o.H-56:undefined}))}
function plotN(el,o){el._o=o;
if(!el._init){el._init=1;el.classList.add("plt");el._cn="pc"+Math.random().toString(36).slice(2,7);
if(window.ResizeObserver)new ResizeObserver(()=>{const w=el.clientWidth;if(w>0&&Math.abs(w-(el._w||0))>8&&el._o)plotN(el,Object.assign({},el._o,{anim:false}))}).observe(el);
el.addEventListener("click",e=>{const b=e.target.closest("[data-lg]");if(!b)return;const nm=b.getAttribute("data-lg"),h=el._hid||(el._hid=new Set());h.has(nm)?h.delete(nm):h.add(nm);plotN(el,Object.assign({},el._o,{anim:false}))});
el.addEventListener("keydown",e=>{const b=e.target.closest("[data-lg]");if(!b||(e.key!=="Enter"&&e.key!==" "))return;e.preventDefault();b.dispatchEvent(new MouseEvent("click",{bubbles:true}))});
el.addEventListener("pointermove",e=>hov(el,e));el.addEventListener("pointerleave",()=>hov(el,null))}
const hid=el._hid||(el._hid=new Set()),PN=o.panels,n=PN.length,W=Math.max(300,Math.round(el.clientWidth||700)),L=64,R=16,B=46,gap=16,f=v=>v.toFixed(1),c5=v=>Math.round(v)+.5,vis=p=>p.series.filter(s=>!hid.has(s.name));
const ph=o.ph||(n===1?Math.round(Math.min(Math.max(W*.5,240),400)):Math.round(Math.min(Math.max(W*.27,150),200)));el._w=W;el._g=null;
/* legend layout */
const LI=[];let lx=L,lr=0;if(!o.nolegend)PN[0].series.forEach(s=>{const w=s.name.length*6.3+46;if(lx+w>W-R&&lx>L){lx=L;lr++}LI.push({s,x:lx,r:lr});lx+=w});
const T0=LI.length?12+(lr+1)*20:10,H=T0+n*ph+(n-1)*gap+B;
let legendStr="";LI.forEach(q=>{const yy=6+q.r*20+10,s=q.s,off=hid.has(s.name);legendStr+=`<g class="lgi${off?" off":""}" data-lg="${esc(s.name)}" role="button" tabindex="0" aria-pressed="${!off}" aria-label="${off?"Show":"Hide"} ${esc(s.name)}" style="cursor:pointer"><rect x="${f(q.x)}" y="${yy-10}" width="${f(s.name.length*6.3+42)}" height="20" fill="transparent"/><path d="M${f(q.x)} ${yy}h22" stroke="${s.col}" stroke-width="2.4"${s.dash?` stroke-dasharray="${s.dash}"`:""}/>${mark(s.mk,q.x+11,yy,s.col,3.5)}<text class="lt" x="${f(q.x+28)}" y="${yy+4}">${esc(s.name)}</text></g>`});
let x0=1/0,x1=-1/0,svg="";PN.forEach(p=>vis(p).forEach(s=>{for(let i=0;i<s.x.length;i++){const a=s.x[i];if(a<x0)x0=a;if(a>x1)x1=a}}));
if(isFinite(x0)){if(o.xmin!==undefined)x0=Math.min(x0,o.xmin);if(x1<=x0)x1=x0+1;x1+=(x1-x0)*.015;
const X=v=>L+(v-x0)/(x1-x0)*(W-L-R),xa=axisTicks(x0,x1,W<480?4:8),GP=[];
svg=`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="${o.nolegend?"img":"group"}" aria-label="${esc(o.al||"Chart")}"><defs>`+PN.map((p,i)=>`<clipPath id="${el._cn}${i}"><rect x="${L}" y="${T0+i*(ph+gap)}" width="${W-L-R}" height="${ph}"/></clipPath>`).join("")+"</defs>"+legendStr;
PN.forEach((p,i)=>{const top=T0+i*(ph+gap),bot=top+ph,vs=vis(p);let y0=1/0,y1=-1/0;
vs.forEach(s=>{for(let k=0;k<s.y.length;k++){const lo=s.band?s.band[0][k]:s.y[k],hi=s.band?s.band[1][k]:s.y[k];if(lo<y0)y0=lo;if(hi>y1)y1=hi}});if(!isFinite(y0)){y0=0;y1=1}
if(p.ymin!==undefined)y0=Math.min(y0,p.ymin);if(p.ymax!==undefined)y1=Math.max(y1,p.ymax);const pd=p.ypad===0?0:(y1-y0)*.08||1;y0-=pd;y1+=pd;
const Y=v=>bot-(v-y0)/(y1-y0)*ph,ya=axisTicks(y0,y1,Math.max(3,Math.round(ph/40)));
svg+=`<rect x="${L}" y="${top}" width="${W-L-R}" height="${ph}" fill="var(--panel)"/>`;
if(o.shade)vs.forEach(s=>{if(!s.ext)return;let a=-1;for(let k=0;k<=s.x.length;k++){const e=k<s.x.length&&s.ext[k];if(e&&a<0)a=k;if(!e&&a>=0){svg+=`<rect x="${f(X(s.x[a]))}" y="${top}" width="${f(Math.max(1,X(s.x[k-1])-X(s.x[a])))}" height="${ph}" fill="var(--warn)" opacity=".07"/>`;a=-1}}});
ya.mn.forEach(v=>svg+=`<path class="gm" d="M${L} ${c5(Y(v))}H${W-R}"/>`);xa.mn.forEach(v=>svg+=`<path class="gm" d="M${c5(X(v))} ${top}V${bot}"/>`);
ya.mj.forEach(v=>svg+=`<path class="gM" d="M${L} ${c5(Y(v))}H${W-R}"/>`);xa.mj.forEach(v=>svg+=`<path class="gM" d="M${c5(X(v))} ${top}V${bot}"/>`);
svg+=`<g clip-path="url(#${el._cn}${i})">`;
if(o.bandFirst)vs.forEach(r=>{if(!r.band)return;const m=r.x.length,st=Math.max(1,Math.ceil(m/(2*(W-L-R)))),ix=[];for(let k=0;k<m;k+=st)ix.push(k);if(ix[ix.length-1]!==m-1)ix.push(m-1);let up="",lo="";for(const k of ix){up+=`${f(X(r.x[k]))},${f(Y(r.band[1][k]))} `;lo=`${f(X(r.x[k]))},${f(Y(r.band[0][k]))} `+lo}svg+=`<polygon points="${up}${lo}" fill="${r.col}" opacity=".15"/>`});
vs.forEach(r=>{const m=r.x.length,st=Math.max(1,Math.ceil(m/(2*(W-L-R)))),an=r.anim&&o.anim!==false,ix=[];for(let k=0;k<m;k+=st)ix.push(k);if(ix[ix.length-1]!==m-1)ix.push(m-1);
if(r.band&&!o.bandFirst){let up="",lo="";for(const k of ix){up+=`${f(X(r.x[k]))},${f(Y(r.band[1][k]))} `;lo=`${f(X(r.x[k]))},${f(Y(r.band[0][k]))} `+lo}svg+=`<polygon${an?' class="fi"':""} points="${up}${lo}" fill="${r.extSame?r.col:"var(--warn)"}" opacity=".15"/>`}
const d=["",""];let pf=-1;for(let q=1;q<ix.length;q++){const k=ix[q],pk=ix[q-1],e=r.ext&&r.ext[k]?1:0;d[e]+=(pf!==e?`M${f(X(r.x[pk]))},${f(Y(r.y[pk]))}`:"")+`L${f(X(r.x[k]))},${f(Y(r.y[k]))}`;pf=e}
const w=r.w||2.2,da=r.dash?` stroke-dasharray="${r.dash}"`:"";
if(d[0])svg+=`<path${an?' class="draw" pathLength="1"':""} d="${d[0]}" fill="none" stroke="${r.col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${da}/>`;
if(d[1])svg+=`<path class="ext${an?" fi":""}" d="${d[1]}" fill="none" stroke="${r.extSame?r.col:"var(--warn)"}" stroke-width="${w}" stroke-linecap="round"/>`;
if(r.mk!==undefined){const k=m-1;svg+=mark(r.mk,X(r.x[k]),Y(r.y[k]),r.col,4)}});
svg+="</g>";
svg+=`<rect class="fr" x="${c5(L)}" y="${c5(top)}" width="${Math.round(W-L-R)}" height="${ph}"/>`;
ya.mj.forEach(v=>{const y=c5(Y(v));svg+=`<path class="tk" d="M${L} ${y}h6M${W-R} ${y}h-6"/><text class="tl" x="${L-8}" y="${f(Y(v)+4)}" text-anchor="end">${tl(v,ya.dec)}</text>`});
ya.mn.forEach(v=>{const y=c5(Y(v));svg+=`<path class="tk" d="M${L} ${y}h3M${W-R} ${y}h-3"/>`});
xa.mj.forEach(v=>{const x=c5(X(v));svg+=`<path class="tk" d="M${x} ${bot}v-6M${x} ${top}v6"/>`;if(i===n-1)svg+=`<text class="tl" x="${f(X(v))}" y="${bot+17}" text-anchor="middle">${tl(v,xa.dec)}</text>`});
xa.mn.forEach(v=>{const x=c5(X(v));svg+=`<path class="tk" d="M${x} ${bot}v-3M${x} ${top}v3"/>`});
svg+=`<text class="al" transform="translate(14 ${f((top+bot)/2)}) rotate(-90)" text-anchor="middle">${esc(p.yl||"")}</text>`;GP.push({Y,series:vs,name:p.yl})});
svg+=`<text class="al" x="${f((L+W-R)/2)}" y="${H-8}" text-anchor="middle">${esc(o.xl||"")}</text><line class="xh" y1="${T0}" y2="${H-B}" stroke="var(--ink)" opacity=".4" visibility="hidden"/>`;
GP.forEach(g=>g.series.forEach(s=>{svg+=`<circle class="xd" r="4.5" fill="${s.col}" stroke="var(--panel)" stroke-width="2" visibility="hidden"/>`}));svg+="</svg>";
el._g={X,x0,x1,L,R,W,H,T0,B,fx:o.fx,panels:GP}}
else if(PN[0].series.length){const HH=T0+150;
 svg=`<svg viewBox="0 0 ${W} ${HH}" width="${W}" height="${HH}" role="${o.nolegend?"img":"group"}" aria-label="${esc(o.al||"Chart")}"><defs></defs>`+legendStr+`<rect x="${c5(L)}" y="${c5(T0)}" width="${Math.round(W-L-R)}" height="110" fill="none" stroke="var(--line)" stroke-dasharray="5 6" rx="10"/><text x="${f((L+W-R)/2)}" y="${T0+52}" text-anchor="middle" font-size="13" fill="var(--mut)">All series are hidden.</text><text x="${f((L+W-R)/2)}" y="${T0+74}" text-anchor="middle" font-size="12" fill="var(--acc-t)">Click a legend entry above to bring it back.</text></svg>`}
else svg='<p class="sub" style="padding:28px 0;text-align:center">No data.</p>';
el.innerHTML=svg+(o.note?`<p class="pnote">${o.note}</p>`:"")+'<div class="ptip" hidden></div>'}
function hov(el,e){const g=el._g,tip=el.querySelector(".ptip");if(!g||!tip)return;const svg=el.querySelector("svg"),xh=el.querySelector(".xh"),ds=el.querySelectorAll(".xd");
const off=()=>{tip.hidden=true;if(xh)xh.setAttribute("visibility","hidden");ds.forEach(d=>d.setAttribute("visibility","hidden"))};if(!e||!svg)return off();
const r=svg.getBoundingClientRect(),px=(e.clientX-r.left)*(g.W/(r.width||g.W));if(px<g.L||px>g.W-g.R)return off();
const xv=g.x0+(px-g.L)/(g.W-g.L-g.R)*(g.x1-g.x0);let h="",di=0;
g.panels.forEach(p=>{if(g.panels.length>1)h+=`<div class="th">${esc(p.name||"")}</div>`;
p.series.forEach(s=>{let lo=0,hi=s.x.length-1;while(hi-lo>1){const m=(lo+hi)>>1;s.x[m]<xv?lo=m:hi=m}const j=Math.abs(s.x[lo]-xv)<=Math.abs(s.x[hi]-xv)?lo:hi,d=ds[di++];
if(d){d.setAttribute("cx",g.X(s.x[j]));d.setAttribute("cy",p.Y(s.y[j]));d.setAttribute("visibility","visible")}
h+=`<div><i style="background:${s.col}"></i>${esc(s.name)}: <b style="display:inline">${(s.fmt||fmtT)(s.y[j])}</b>${s.ext&&s.ext[j]?" · extrapolated":""}</div>`})});
xh.setAttribute("x1",px);xh.setAttribute("x2",px);xh.setAttribute("visibility","visible");tip.innerHTML=`<b>${(g.fx||fmtT)(xv)}</b>${h}`;tip.hidden=false;
const tw=tip.offsetWidth||170;let left=px+14;if(left+tw>g.W-4)left=px-tw-14;tip.style.left=Math.max(4,left)+"px";tip.style.top=(g.T0+6)+"px"}
/* ---------- simulator v2: up to 3 cells, load profiles ---------- */
const SM={ecm:"1RC",rct:false,cells:["","",""],vlo:[null,null,null],vhi:[null,null,null],sc:"custom",unit:"C",dir:1,mean:.8,peak:2.5,reps:1,T:25,soh:100,soc0:100,cal:false,cust:false,up:null,sig:{I:1,C:0,P:0,V:1,T:1,SOC:0}};
OBFSolver.bind({SM,CELLS,CH,CAL});

/* ---------- solver worker ----------
   Simulation, comparison, calibration and validation run here so a long fit
   never freezes the page. The numbers themselves come from js/solver.js,
   which the worker loads too: one copy of the maths for both threads. */
const Solver=(()=>{
  /* One worker would serialise everything: a minute-long calibration would hold
     up every slider move in the simulator. Interactive work and heavy work get
     a thread each. */
  function channel(){
    let w=null,n=0;const jobs=new Map();
    function fail(err){jobs.forEach(j=>j.reject(err));jobs.clear()}
    function ensure(){
      if(w)return w;
      const url=new URL("js/solver-worker.js",document.baseURI).href;
      w=new Worker(url);
      w.onmessage=e=>{const m=e.data||{},j=jobs.get(m.id);if(!j)return;jobs.delete(m.id);m.ok?j.resolve(m.result):j.reject(new Error(m.error||"The solver failed."))};
      w.onerror=e=>{fail(new Error(e.message||"The solver worker could not start."));w=null};
      return w;
    }
    return {run(task,args){return new Promise((resolve,reject)=>{const id=++n;jobs.set(id,{resolve,reject});try{ensure().postMessage({id,task,args})}catch(err){jobs.delete(id);reject(err)}})}};
  }
  const quick=channel(),heavy=channel();
  return {run:(task,args)=>(task==="fit"||task==="validate"?heavy:quick).run(task,args)};
})();
/* A tool asks for new numbers while the last request is still running: only the
   newest answer is drawn. */
const latest={};
function fresh(key){latest[key]=(latest[key]||0)+1;const t=latest[key];return ()=>latest[key]===t}
const solverErr=(key,where,err)=>console.error(where,err);
function simEmptyState(){
  const hasCell=SM.cells.some(Boolean);
  const hasProf=buildProf()!=null;
  const ready=hasCell&&hasProf;
  document.querySelectorAll("#sres .phd").forEach(p=>{p.hidden=!ready});
  const c=document.getElementById("chart");if(c)c.hidden=!ready;
  const e=document.getElementById("sexp");if(e)e.hidden=!ready;
  const st=document.getElementById("stab");if(st)st.hidden=!ready;
  const sm=document.getElementById("smsg");if(sm)sm.hidden=!ready;
  const m=document.getElementById("sempty");if(m){
    m.hidden=ready;
    if(!ready){
      const t=m.querySelector("h3"),p=m.querySelector("p");
      if(t)t.textContent=hasCell?"Pick a scenario":"Pick cells to simulate";
      if(p)p.textContent=hasCell
        ?"Choose a profile type below or upload a CSV load profile, then the simulation appears here."
        :"Choose at least one cell in the list on the left, or send cells from the library.";
    }
  }
}
const SCN={custom:"Custom upload",const:"Constant load",pulse:"Pulse train",drive:"Drive cycle (synthetic)",stair:"Staircase (rate test)"};
const UR={C:{mean:[.05,6,.05],peak:[.1,10,.05],d:2},A:{mean:[.1,60,.1],peak:[.1,150,.5],d:1},W:{mean:[1,600,1],peak:[1,1500,1],d:0}};
const RR={const:[1,1,1],pulse:[0,60,1],drive:[0,12,1],stair:[2,10,1],custom:[0,20,1]},RL={pulse:"Pulses",drive:"Cycles",stair:"Steps",custom:"Repeats"};
const SG={I:{n:"Current",u:"A",d:1},C:{n:"C-rate",u:"C",d:1},P:{n:"Power",u:"W",d:1},V:{n:"Voltage",u:"V",d:3},T:{n:"Temperature",u:"°C",d:1},SOC:{n:"SOC",u:"%",d:1}},SGO=["I","C","P","V","T","SOC"];
const SP=[["EV highway pull",{cells:["nmc-21700-e","nca-21700-e",""],sc:"drive",unit:"C",dir:1,mean:.8,peak:2.2,reps:3,T:25,soh:95,soc0:100}],
["Cold winter commute",{cells:["nmc-21700-e","lfp-26650",""],sc:"drive",unit:"C",dir:1,mean:.5,peak:1.5,reps:3,T:-10,soh:90,soc0:100}],
["Drone burst pulses",{cells:["nca-21700-e","nmc-18650-p",""],sc:"pulse",unit:"C",dir:1,mean:1.5,peak:4,reps:0,T:30,soh:100,soc0:100}],
["Fast charge",{cells:["lfp-26650","lto-18650",""],sc:"const",unit:"C",dir:-1,mean:2,peak:2,reps:1,T:15,soh:100,soc0:10}],
["Constant power 5 W",{cells:["nmc-21700-e","lfp-26650","na-18650"],sc:"const",unit:"W",dir:1,mean:5,peak:5,reps:1,T:25,soh:100,soc0:100}],
["Rate capability",{cells:["nmc-21700-e","nmc-21700-p",""],sc:"stair",unit:"C",dir:1,mean:.5,peak:3,reps:6,T:25,soh:100,soc0:100}]];
/* presets name library cells: drop any that are no longer in the database */
SP.forEach(p=>{p[1].cells=p[1].cells.map(keepCell);if(!p[1].cells.some(Boolean))p[1].cells[0]=DEF});
let SMR=null,simBuilt=false;
const amax=a=>{let m=-1/0;for(let i=0;i<a.length;i++)if(a[i]>m)m=a[i];return m},amin=a=>{let m=1/0;for(let i=0;i<a.length;i++)if(a[i]<m)m=a[i];return m};
function copyTxt(t){const a=document.createElement("textarea");a.value=t;a.style.cssText="position:fixed;opacity:0";document.body.appendChild(a);a.select();let ok=false;try{ok=document.execCommand("copy")}catch(e){}a.remove();try{const p=navigator.clipboard.writeText(t);p&&p.catch&&p.catch(()=>{})}catch(e){}return ok}
function download(name,text,type){try{const b=new Blob([text],{type:type||"text/csv;charset=utf-8"}),u=URL.createObjectURL(b),a=document.createElement("a");a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000);return true}catch(e){return false}}
function tweenNum(el,to,fmt){if(!el)return;const from=+(el.dataset.v||0);el.dataset.v=to;if(RM||from===to){el.textContent=fmt(to);return}cancelAnimationFrame(el._raf);const t0=performance.now(),D=520,e=x=>1-Math.pow(1-x,3);const step=t=>{const k=Math.min(1,(t-t0)/D);el.textContent=fmt(from+(to-from)*e(k));if(k<1)el._raf=requestAnimationFrame(step)};el._raf=requestAnimationFrame(step)}
function lcg(s){return()=>(s=(s*16807)%2147483647)/2147483647}
function driveSeg(mean,peak){const r=lcg(11),w=[];for(let i=0;i<40;i++){const a=r(),b=r();w.push(a<.15?-.35:Math.pow(b,1.6))}const wm=Math.max(...w),z=w.map(x=>x/wm),m0=z.reduce((a,b)=>a+b,0)/40,pk=Math.max(peak,mean*1.02),k=(pk-mean)/(1-m0);return z.map(x=>[30,k*(x-1)+pk])}
function buildProf(){const{sc,mean,peak,dir}=SM;let seg,R=SM.reps;const pk=Math.max(peak,mean*1.02);
if(sc==="const"){seg=[[72000,mean]];R=1}
else if(sc==="pulse"){const tp=30,tr=Math.round(tp*(pk/mean-1));seg=[[tp,pk]];if(tr>0)seg.push([tr,0])}
else if(sc==="drive")seg=driveSeg(mean,peak);
else if(sc==="stair"){const n=Math.max(2,R);seg=[];for(let i=0;i<n;i++)seg.push([300,mean+(pk-mean)*i/(n-1)],[120,0]);R=1}
else if(sc==="custom"&&SM.up)seg=SM.up.seg;else return null;
const t=[],u=[];let a=0;for(const[d,l]of seg){t.push(a);u.push(l*dir*(sc==="custom"&&SM.up&&SM.up.neg?-1:1));a+=d}return{t,u,period:a,reps:R}}



/* ---------- per-cell voltage window ---------- */



function vlPanel(){const el=$("#svl"),open=$("#svlt").getAttribute("aria-pressed")==="true",act=SM.cells.some((id,i)=>id&&(SM.vlo[i]!=null||SM.vhi[i]!=null));$("#svlt").classList.toggle("on",act);$("#svlt").textContent=act?"Voltage limits (custom)":"Customise voltage limits";el.hidden=!open;if(!open)return;
el.innerHTML='<p class="note" style="font-size:12px;color:var(--mut);margin:0 0 8px">Set a voltage window for each cell. Narrowing it ends runs sooner. Widening it past the datasheet adds capacity by extrapolation, lowers the confidence and ages a real cell faster. Limits are capped per chemistry.</p>'+SM.cells.map((id,i)=>{if(!id)return"";const c=CELLS[id],L=vlLim(c,SM.vlo[i],SM.vhi[i]),sp=L.hiAbs-L.loAbs,pc=v=>((v-L.loAbs)/sp*100).toFixed(1),ov=L.Vmax>c.Vmax+1e-6,un=L.Vmin<c.Vmin-1e-6,cu=SM.vlo[i]!=null||SM.vhi[i]!=null;
return `<div class="vl-row" style="--vlc:${SCOL[i]}"><div class="vl-cell"><i></i><b>${esc(c.n)}</b></div><div class="vl-in"><label>V<sub>min</sub><input type="number" class="vli" data-i="${i}" data-k="lo" step="0.05" min="${L.loAbs}" max="${(L.Vmax-.1).toFixed(2)}" value="${L.Vmin.toFixed(2)}"></label><label>V<sub>max</sub><input type="number" class="vli" data-i="${i}" data-k="hi" step="0.05" min="${(L.Vmin+.1).toFixed(2)}" max="${L.hiAbs}" value="${L.Vmax.toFixed(2)}"></label>${cu?`<button type="button" class="lnk vl-rst" data-i="${i}">Reset</button>`:""}</div>
<div class="vl-bar"><span class="ds" style="left:${pc(c.Vmin)}%;right:${(100-pc(c.Vmax)).toFixed(1)}%"></span><span class="sel" style="left:${pc(L.Vmin)}%;right:${(100-pc(L.Vmax)).toFixed(1)}%"></span></div><div class="vl-sc"><small>${L.loAbs.toFixed(2)} V</small><small>datasheet ${c.Vmin} to ${c.Vmax} V</small><small>${L.hiAbs.toFixed(2)} V</small></div>
${ov||un?`<p class="vl-warn">${ov?`${(L.Vmax-c.Vmax).toFixed(2)} V above the datasheet: about +${(L.gH*(L.Vmax-c.Vmax)*100).toFixed(0)} % capacity if the cell reaches it, and a cycle life of roughly ×${Math.pow(.5,(L.Vmax-c.Vmax)/.1).toFixed(2)} (rule of thumb). `:""}${un?`${(c.Vmin-L.Vmin).toFixed(2)} V below the datasheet: about +${(L.gL*(c.Vmin-L.Vmin)*100).toFixed(0)} % capacity, with a risk of irreversible damage. `:""}</p>`:""}</div>`}).join("")}
function simInputs(){const P=buildProf();if(!P)return null;return{prof:P,cfg:{unit:SM.unit,soh:SM.soh,ecm:SM.ecm,rct:!!SM.rct,soc0:SM.soc0,T:SM.T},entries:SM.cells.map((id,i)=>{if(!id)return null;const c=cellOf(id);return{i,id,cell:c,vl:vlLim(c,SM.vlo[i],SM.vhi[i])}}).filter(Boolean)}}
async function simRender(anim){const q=simInputs(),ok=fresh("sim");let R=null,err=null;
if(q){try{const res=await Solver.run("simulate",q);R=q.entries.map(e=>{const g=res.find(x=>x.i===e.i);return{id:e.id,i:e.i,c:e.cell,P:q.prof,vl:e.vl,o:g&&g.o}})}catch(e){err=e;console.error("Simulation failed:",e)}}
if(!ok())return;SMR=R;
if(err){$("#chart").innerHTML='<p class="warn" style="padding:40px 0;text-align:center">The solver failed: '+esc(err.message)+'</p>';$("#stab").innerHTML="";$("#smsg").innerHTML="";return}
simDraw(R,anim)}
function simDraw(R,anim){R=R||[];const el=$("#chart"),empty=m=>{el.innerHTML=`<p class="warn" style="padding:40px 0;text-align:center">${m}</p>`;$("#stab").innerHTML="";$("#smsg").innerHTML=""};
if(!R||!R.length)return empty("Load a profile or choose a scenario.");if(R.every(r=>r.o.t.length<2))return empty("No data: the starting state is already at a limit. Check the start SOC and the direction.");
const span=Math.max(...R.map(r=>r.o.t.length?r.o.t[r.o.t.length-1]:0)),tu=span<=300?["s",1]:span<=7200?["min",60]:["h",3600],single=R.length===1;
const panels=SGO.filter(k=>SM.sig[k]).map(k=>{const g=SG[k];return{name:g.n,yl:g.n+" ("+g.u+")",ymin:k==="SOC"?Math.min(0,Math.floor(Math.min(...R.map(r=>amin(r.o.soc)))*20)*5):undefined,ymax:k==="SOC"?Math.max(100,Math.ceil(Math.max(...R.map(r=>amax(r.o.soc)))*20)*5):undefined,ypad:k==="SOC"?0:undefined,
series:R.map(r=>{const o=r.o,y=k==="I"?o.I:k==="C"?o.I.map(i=>i/r.c.Ah):k==="P"?o.P:k==="V"?o.V:k==="T"?o.T:o.soc.map(v=>v*100);
return{name:r.c.n+(SM.cal&&CAL[r.id]?" (calibrated)":""),x:o.t.map(t=>t/tu[1]),y,col:SCOL[r.i],w:2.2,mk:r.i,fmt:v=>(k==="C"||k==="I")?f1c(v)+" "+g.u:v.toFixed(g.d)+" "+g.u,ext:o.cf.map(c=>c<.9?1:0),extSame:true,anim,band:k==="V"&&o.cf.some(c=>c<1)?[o.V.map((v,i)=>v-(1-o.cf[i])*.25),o.V.map((v,i)=>v+(1-o.cf[i])*.25)]:null}})}});
plotN(el,{panels,xl:"Time ("+tu[0]+")",fx:v=>v.toFixed(tu[0]==="s"?0:1)+" "+tu[0],al:"Simulation results",anim,bandFirst:true,note:"Dotted segments: extrapolated beyond the datasheet. Shaded bands: voltage uncertainty of each cell, shown where it exists. Click a legend entry to hide a cell."});
const M=[["Net capacity","Ah",r=>r.o.Q,2,0],["Energy","Wh",r=>r.o.E,1,0],["Specific energy","Wh/kg",r=>r.o.E/r.c.m*1000,0,SM.dir>0?1:0],["Min. voltage","V",r=>amin(r.o.V),2,SM.dir>0?1:0],["Peak temperature","°C",r=>amax(r.o.T),1,-1],["Duration","min",r=>r.o.t.length/60,1,0],["Min. confidence","%",r=>amin(r.o.cf)*100,0,1]];
$("#stab").innerHTML=`<table><thead><tr><th>Metric</th>${R.map(r=>`<th style="color:${SCOL[r.i]}">${["●","■","▲"][r.i]} ${r.c.n}</th>`).join("")}</tr></thead><tbody>${cmpChemRow(R)}${M.map(m=>{const v=R.map(r=>m[2](r)),b=m[4]===0||R.length<2?null:(m[4]>0?Math.max(...v):Math.min(...v));return `<tr><td>${m[0]} <small style="color:var(--mut)">${m[1]}</small></td>${v.map(x=>`<td${x===b?' class="best"':""}>${x.toFixed(m[3])}</td>`).join("")}</tr>`}).join("")}<tr><td>Stopped by</td>${R.map(r=>`<td>${r.o.why}</td>`).join("")}</tr></tbody></table><div class="ctabfoot"><button type="button" class="dlb" id="stabcs">Download table (CSV)</button></div>`;
const ms=R.map(r=>{const c=r.c,pc=Math.max(amax(r.o.I),-amin(r.o.I))/c.Ah,rs=[];if(pc>c.dsC[1])rs.push(`peak ${pc.toFixed(1)} C is above the datasheet maximum of ${f1c(c.dsC[1])} C`);if(SM.T<c.dsT[0]||SM.T>c.dsT[1])rs.push(`ambient ${SM.T} °C is outside the datasheet range of ${c.dsT.join(" to ")} °C`);if(SM.soh<95)rs.push(`SOH ${SM.soh} % is not covered by a fresh-cell datasheet`);{const vh=amax(r.o.V),vo=amin(r.o.V);if(vh>c.Vmax+.005)rs.push(`voltage reaches ${vh.toFixed(2)} V, ${(vh-c.Vmax).toFixed(2)} V above the datasheet limit of ${c.Vmax} V (rule of thumb: each +0.1 V roughly halves cycle life, here about ×${Math.pow(.5,(vh-c.Vmax)/.1).toFixed(2)})`);if(vo<c.Vmin-.005)rs.push(`voltage drops to ${vo.toFixed(2)} V, ${(c.Vmin-vo).toFixed(2)} V below the datasheet limit of ${c.Vmin} V (risk of copper dissolution and irreversible capacity loss)`)}
return `<li class="${rs.length?"warn":"ok"}"><b>${r.c.n}</b>: ${rs.length?"extrapolating: "+rs.join("; "):"inside the datasheet envelope"}. Peak current ${amax(r.o.I).toFixed(1)} A.${r.vl&&(r.vl.Vmin!==c.Vmin||r.vl.Vmax!==c.Vmax)?` Voltage window ${r.vl.Vmin.toFixed(2)} to ${r.vl.Vmax.toFixed(2)} V (datasheet ${c.Vmin} to ${c.Vmax} V).`:""}</li>`});
$("#smsg").innerHTML="<h2>Reading the results</h2><ul>"+ms.join("")+"</ul><p class=\"note\" style=\"font-size:12px;color:var(--mut);margin:6px 0 0\">"+(SM.unit==="C"?"C-rate scenario: each cell receives its own current (C-rate × capacity).":SM.unit==="W"?"Power scenario: I = P / V, so the current rises as the voltage drops.":"Current scenario: every cell receives the same current in A.")+"</p>"}
function sl(id,r,v){const e=$("#"+id);e.min=r[0];e.max=r[1];e.step=r[2];e.value=v}
function simUI(){const U=SM.unit,ur=UR[U],cu=SM.sc==="custom",cs=SM.sc==="const",rr=RR[SM.sc];
document.querySelectorAll("#sdir button").forEach(b=>b.setAttribute("aria-pressed",+b.dataset.d===SM.dir));document.querySelectorAll("#sun button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.u===U));$("#scn").value=SM.sc;$("#spre").value=SM.pre!=null?String(SM.pre):"";const srst=$("#srst");if(srst)srst.hidden=SM.pre==null;
const sn=(v,r)=>+(Math.round(v/r[2])*r[2]).toFixed(3);SM.mean=sn(clp(SM.mean,ur.mean[0],ur.mean[1]),ur.mean);SM.peak=sn(clp(SM.peak,ur.peak[0],ur.peak[1]),ur.peak);SM.reps=clp(SM.reps,rr[0],rr[1]);
sl("sMean",ur.mean,SM.mean);sl("sPeak",ur.peak,SM.peak);sl("sReps",rr,SM.reps);$("#lMean").textContent=cs?"Level":"Average";$("#lReps").textContent=RL[SM.sc]||"Repetitions";
const fm=v=>(U==="C"||U==="A")?f1c(v)+" "+U:v.toFixed(ur.d)+" "+U;$("#oMean").textContent=fm(SM.mean);$("#oPeak").textContent=fm(SM.peak);$("#oReps").textContent=SM.reps===0?"until cutoff":SM.reps+" ×";
$("#gMean").hidden=cu;$("#gPeak").hidden=cs||cu;$("#gReps").hidden=cs;$("#gUp").hidden=!cu;if(cu){const hasUp=!!(SM.up&&SM.up.name);$("#sdropw").hidden=hasUp;$("#supw").hidden=!hasUp;if(hasUp){$("#supname").textContent="✓ "+esc(SM.up.name);$("#supneg").checked=!!SM.up.neg}}
sl("sT",[-20,55,1],SM.T);sl("sSoh",[60,100,1],SM.soh);sl("sSoc",[0,100,5],SM.soc0);$("#oT").textContent=SM.T+" °C";$("#oSoh").textContent=SM.soh+" %";$("#oSoc").textContent=SM.soc0+" %";
document.querySelectorAll("#scells .slotbtn").forEach((b,i)=>{const id=SM.cells[i];b.textContent=id?CELLS[id].n:"Choose a cell…";b.classList.toggle("empty",!id)});document.querySelectorAll("#scells .slotx").forEach((x,i)=>{x.hidden=!SM.cells[i]});
document.querySelectorAll("#ssig button").forEach(b=>b.setAttribute("aria-pressed",!!SM.sig[b.dataset.s]));$("#calrow").hidden=!SM.cells.some(id=>id&&CAL[id]);$("#usecal").checked=SM.cal;
const P=buildProf();$("#sinfo").innerHTML=P?(()=>{const s=profStats(P),f=v=>(U==="C"||U==="A")?f1c(v):v.toFixed(ur.d);return cs?`Constant ${f(s.mean)} ${U} until cutoff (${SM.dir>0?"discharge":"charge"})`:`One cycle ${(P.period/60).toFixed(P.period>=600?0:1)} min · average ${f(s.mean)} ${U} · max ${f(s.max)} ${U}${s.min<0?` · min ${f(s.min)} ${U}`:""} · total ${cs||P.reps===0?"until cutoff":(P.period*P.reps/60).toFixed(0)+" min"}`})():"Upload a CSV to define the profile.";ecmSync();vlPanel();rpAll();simEmptyState();bridgeUpd()}
function applyPre(i){const p=JSON.parse(JSON.stringify(SP[i][1]));const savedCells=SM.cells.slice();Object.assign(SM,p);SM.cells=savedCells;SM.pre=i;SM.cal=false;SM.cust=false;SM.sig={I:p.unit==="W"?0:1,C:0,P:p.unit==="W"?1:0,V:1,T:1,SOC:0}}
function parseLoad(txt){const L=txt.trim().split(/\r?\n/).filter(x=>x.trim());if(L.length<3)throw new Error("Need at least 3 rows.");const sep=L[0].includes(";")?";":L[0].includes("\t")?"\t":",",hd=L[0].split(sep).map(h=>h.trim().toLowerCase());let st=0,it,iv,un=null;
if(isNaN(parseFloat(hd[0]))){st=1;it=hd.findIndex(h=>h.includes("time")||h==="t"||h.startsWith("t_")||h.includes("sec"));iv=hd.findIndex((h,i)=>i!==it&&(/c.?rate|crate|pow|watt|curr|amp/.test(h)||/^[ip]\b|^[ip][(_]/.test(h)));if(iv<0)iv=hd.findIndex((h,i)=>i!==it);if(iv<0)throw new Error("Need a value column (current, C-rate or power).");
const vh=hd[iv];un=/c.?rate/.test(vh)?"C":/pow|watt|^p\b|^p[(_]|\(w\)|_w$/.test(vh)?"W":/curr|amp|^i\b|^i[(_]|\(a\)|_a$/.test(vh)?"A":null}else{it=hd.length<2?-1:0;iv=hd.length<2?0:1}
const rows=[];for(let k=st;k<L.length&&rows.length<50000;k++){const a=L[k].split(sep).map(parseFloat),v=a[iv],t=it<0?rows.length:a[it];if(isNaN(v)||isNaN(t))continue;rows.push([t,v])}
if(rows.length<3)throw new Error("Could not read enough numeric rows.");rows.sort((a,b)=>a[0]-b[0]);const dts=[];for(let i=1;i<rows.length;i++)dts.push(rows[i][0]-rows[i-1][0]);dts.sort((a,b)=>a-b);const md=Math.max(1,dts[dts.length>>1]||1);
return{seg:rows.map((r,i)=>[i+1<rows.length?Math.max(1,rows[i+1][0]-r[0]):md,r[1]]),unit:un}}
function loadLoad(txt,name){try{const r=parseLoad(txt);SM.up={seg:r.seg,name};SM.sc="custom";SM.reps=1;if(r.unit)SM.unit=r.unit;simUI();simRender(true)}catch(e){$("#sinfo").innerHTML='<span class="warn">'+esc(e.message)+"</span>"}}
function simInit(){if(simBuilt)return;simBuilt=true;
$("#scells").innerHTML=[0,1,2].map(i=>`<div class="slot" style="--sc:${SCOL[i]}"><i></i><button type="button" class="slotbtn empty" data-slotsim="${i}" aria-label="Choose cell ${i+1}">Choose a cell…</button><button type="button" class="slotx" data-clrsim="${i}" aria-label="Remove cell ${i+1}" hidden>${TRASH}</button></div>`).join("");
$("#scn").innerHTML=Object.entries(SCN).map(([k,v])=>`<option value="${k}">${v}</option>`).join("");$("#ssig").innerHTML=SGO.map(k=>`<button type="button" data-s="${k}">${SG[k].n}</button>`).join("");$("#spre").innerHTML='<option value="">Choose a demo…</option>'+SP.map((p,i)=>`<option value="${i}">${p[0]}</option>`).join("");
const rn=a=>{simUI();simRender(a)};
$("#scells").addEventListener("click",e=>{const r=e.target.closest("[data-clrsim]");if(r){setSimCell(+r.dataset.clrsim,"");return}const b=e.target.closest("[data-slotsim]");if(b)openCellPicker("sim",+b.dataset.slotsim)});
$("#scn").onchange=e=>{SM.sc=e.target.value;SM.reps={const:1,pulse:20,drive:3,stair:6,custom:1}[SM.sc];rn(true)};
$("#sdir").onclick=e=>{const d=+e.target.dataset.d;if(d){SM.dir=d;SM.soc0=d<0?10:100;rn(true)}};
$("#sun").onclick=e=>{const u=e.target.dataset.u;if(!u||u===SM.unit)return;const c=cellOf(SM.cells.find(Boolean)),vn=CH[c.ch].V,fac={C:{A:c.Ah,W:c.Ah*vn},A:{C:1/c.Ah,W:vn},W:{C:1/(c.Ah*vn),A:1/vn}}[SM.unit][u];SM.mean*=fac;SM.peak*=fac;SM.unit=u;if(!SM.cust){SM.sig.I=u==="W"?0:1;SM.sig.P=u==="W"?1:0}rn(true)};
[["sMean","mean"],["sPeak","peak"],["sReps","reps"],["sT","T"],["sSoh","soh"],["sSoc","soc0"]].forEach(([id,k])=>$("#"+id).addEventListener("input",e=>{SM[k]=+e.target.value;simUI();simRender(false)}));
$("#ssig").onclick=e=>{const k=e.target.dataset.s;if(!k)return;if(SM.sig[k]&&SGO.filter(x=>SM.sig[x]).length===1)return;SM.sig[k]=SM.sig[k]?0:1;SM.cust=true;rn(false)};
$("#spre").onchange=e=>{const i=e.target.value;if(i!==""){applyPre(+i);rn(true)}};$("#srst").onclick=()=>{SM.pre=null;$("#srst").hidden=true;$("#spre").value="";rn(true)};$("#usecal").onchange=e=>{SM.cal=e.target.checked;rn(false)};
const d=$("#sdrop");["dragover","dragenter"].forEach(ev=>d.addEventListener(ev,e=>{e.preventDefault();d.classList.add("on")}));["dragleave","drop"].forEach(ev=>d.addEventListener(ev,e=>{e.preventDefault();d.classList.remove("on")}));
const rd=f=>{const r=new FileReader();r.onload=()=>loadLoad(String(r.result),f.name);r.readAsText(f)};d.addEventListener("drop",e=>{const f=e.dataTransfer.files[0];f&&rd(f)});$("#sfile").onchange=e=>{const f=e.target.files[0];f&&rd(f)};$("#svlt").onclick=()=>{$("#svlt").setAttribute("aria-pressed",$("#svlt").getAttribute("aria-pressed")!=="true");vlPanel()};$("#svl").addEventListener("change",e=>{const t=e.target;if(t.classList.contains("vli")){const v=parseFloat(t.value);(t.dataset.k==="lo"?SM.vlo:SM.vhi)[+t.dataset.i]=isNaN(v)?null:v;rn(false)}});$("#svl").addEventListener("click",e=>{const b=e.target.closest(".vl-rst");if(b){SM.vlo[+b.dataset.i]=SM.vhi[+b.dataset.i]=null;rn(false)}});$("#supneg").onchange=e=>{if(SM.up){SM.up.neg=e.target.checked;rn(true)}};$("#srepl").onclick=()=>{SM.up=null;$("#sdropw").hidden=false;$("#supw").hidden=true;$("#sinfo").innerHTML="";simUI();simRender(true)};
$("#sex").onclick=()=>{SM.up={seg:driveSeg(.8,2.2),name:"example drive cycle (C-rate)"};SM.sc="custom";SM.reps=1;SM.unit="C";rn(true)};
$("#stpl").onclick=()=>{const ok=copyTxt("time_s,current_A\n0,0\n30,2.5\n60,5.0\n90,0\n120,-1.5\n");$("#sinfo").innerHTML=ok?'<span class="ok">Template copied.</span>':"Template: time_s,current_A rows, discharge positive."};
function simCSV(){if(!SMR)return"";let s="cell,time_s,current_A,voltage_V,temp_C,soc_pct,power_W\n";SMR.forEach(r=>{const o=r.o,st=Math.max(1,Math.ceil(o.t.length/2000));for(let i=0;i<o.t.length;i+=st)s+=[r.c.n,o.t[i],o.I[i].toFixed(3),o.V[i].toFixed(4),o.T[i].toFixed(2),(o.soc[i]*100).toFixed(2),o.P[i].toFixed(2)].join(",")+"\n"});return s}
$("#sxd").onclick=()=>{const s=simCSV();if(!s)return;download("openbatteryflux-simulation.csv",s);$("#sxm").textContent="CSV downloaded."}}
/* Download the results table exactly as it is shown, as a CSV file. */
function simDownloadTable(){const tbl=$("#stab").querySelector("table");if(!tbl)return false;
return download("obf-simulate-"+SM.sc+"-"+(SM.dir>0?"discharge":"charge")+".csv","\ufeff"+tblCSV(tbl)+"\n","text/csv;charset=utf-8")}
$("#stab").addEventListener("click",e=>{const b=e.target.closest("#stabcs");if(!b)return;if(simDownloadTable()){b.textContent="Downloaded ✓";setTimeout(()=>b.textContent="Download table (CSV)",1400)}});

/* ---------- cell picker: searchable cell popup (simulate + compare slots) ---------- */
const TRASH='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
let CPICK={kind:"sim",slot:0};
let KCELL=DEF,VCELL=DEF;
function cellMatches(c,q,brand,ch,form){
  if(brand&&c.brand!==brand)return false;
  if(ch&&c.ch!==ch)return false;
  if(form&&c.form!==form)return false;
  if(q){const hay=(c.n+" "+c.brand+" "+c.s+" "+c.form+" "+(c.kind||"")).toLowerCase();if(!hay.includes(q))return false;}
  return true;
}
function fillOpts(sel,items,anyLabel){sel.innerHTML='<option value="">'+esc(anyLabel||"Any")+'</option>'+items.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("");return sel;}
function cpItem(k){const c=CELLS[k];return `<button type="button" class="cp-item" style="--c:var(--c-${c.ch})" data-pick="${k}" role="option">
    <span class="dot">${esc(c.s.charAt(0))}</span>
    <span class="meta"><b>${esc(c.n)}</b><small>${esc(c.brand)} · ${esc(c.s)} · ${esc(c.form)} · ${esc(c.kind||"")} · ${c.Ah} Ah</small></span>
    <span class="stat"><b>${Math.round(c.E)}</b>Wh/kg</span>
  </button>`}
/* The five cells people open most often, from anonymous counters on the API:
   one count per cell (and per day, so the dashboard can rank a window), with no
   account, no visitor id and no address, so the shortcut works for every visitor
   and not only for those who allow the identified usage log. */
let POP=null,POPBUSY=false,POPAT=0;
/* Report one cell opened or loaded. Fire and forget: the ranking it feeds must
   never delay the page, and a failure must never be visible. */
function cellHit(kind,id){
  if(!id)return;
  try{fetch(OBF.apiUrl("/api/cells/hits"),{method:"POST",credentials:"omit",keepalive:true,
    headers:{"Content-Type":"application/json"},body:JSON.stringify({cell:String(id),kind:kind})}).catch(()=>{})}catch(e){}
}
/* Asked for at start-up and on every open, but reused for a minute: a ranking
   does not change often enough to cost a query each time. An empty answer is
   never kept, or one cold deployment would hide the shortcut for the visit. */
async function loadPopular(){
  if(POPBUSY)return;
  if(POP&&POP.length&&Date.now()-POPAT<60000)return;
  POPBUSY=true;
  try{const r=await fetch(OBF.apiUrl("/api/cells/popular?limit=5"),{headers:{Accept:"application/json"}});const d=r.ok?await r.json():null;POP=((d&&d.cells)||[]).filter(k=>CELLS[k]);POPAT=Date.now()}catch(e){POP=null}
  POPBUSY=false;
  const dlg=$("#cellpick");if(dlg&&!dlg.hidden)renderPickList();
}
function renderPickList(){
  const q=($("#cpq").value||"").trim().toLowerCase(),brand=$("#cpbrand").value,ch=$("#cpch").value,form=$("#cpform").value;
  const L=Object.keys(CELLS).filter(k=>cellMatches(CELLS[k],q,brand,ch,form));
  $("#cpcount").textContent=L.length+" of "+ALL.length+" cells";
  const el=$("#cpres");
  if(!L.length){el.innerHTML='<p class="cp-empty">No cell matches these filters.</p>';return}
  const active=!!(q||brand||ch||form);
  /* The most-used cells are pinned at the top and left out of the list below,
     so the same cell never appears twice in one view of the picker. */
  const pin=!active&&POP&&POP.length?POP:[];
  const rest=pin.length?L.filter(k=>!pin.includes(k)).sort((a,b)=>CELLS[a].n.localeCompare(CELLS[b].n)):L;
  const top=pin.length?`<div class="cp-sec" role="presentation"><span>Most used</span><small>opened most often here</small></div>`+pin.map(cpItem).join("")+`<div class="cp-sec" role="presentation"><span>All cells</span><small>${rest.length}</small></div>`:"";
  el.innerHTML=top+rest.map(cpItem).join("");
  syncResetStates();
}
function openCellPicker(kind,slot){
  CPICK={kind:kind||"sim",slot:+(slot||0),openedAt:Date.now()};
  $("#cps").textContent=({
    sim:"Run up to three cells through the same load profile. Search, filter and click a cell to add or replace it.",
    cmp:"Compare up to four cells under the same load. Search, filter and click a cell to add or replace it.",
    k:"Pick the reference cell used as the starting model for the calibration fit.",
    v:"Pick the library cell whose model you want to validate."
  })[CPICK.kind]||"Pick a cell.";
  if(!$("#cpbrand").dataset.f){$("#cpbrand").dataset.f="1";
    fillOpts($("#cpbrand"),[...new Set(ALL.map(c=>c.brand))].sort(),"Any manufacturer");
    fillOpts($("#cpform"),[...new Set(ALL.map(c=>c.form))].sort(),"Any form");
  }
  $("#cpch").innerHTML='<option value="">Any chemistry</option>'+CHS.map(id=>`<option value="${id}">${esc(CHN[id])}</option>`).join("");
  $("#cpq").value="";$("#cpcount").textContent="";
  renderPickList();loadPopular();
  const dlg=$("#cellpick");if(dlg){dlg.hidden=false;document.documentElement.classList.add("pick-open")}
  setTimeout(()=>{const q=$("#cpq");if(q)q.focus()},40);
}
function closeCellPicker(){const d=$("#cellpick");if(d){d.hidden=true;document.documentElement.classList.remove("pick-open")}}
function confirmPick(id){
  if(id&&!CELLS[id])return;
  var toolMap={k:"calibrate",v:"validate",sim:"simulate",cmp:"compare"};
  if(id){cellHit("use",id);POPAT=0;OBFAccount.activity("use",toolMap[CPICK.kind]||CPICK.kind,id);}
  if(CPICK.kind==="k")setKCell(id);
  else if(CPICK.kind==="v")setVCell(id);
  else if(CPICK.kind==="sim")setSimCell(CPICK.slot,id);
  else setCmpSlot(CPICK.slot,id);
  closeCellPicker();
}
function setKCell(id){
  KCELL=id;
  const k=$("#kc");if(k)k.textContent=CELLS[id].n;
  if(KF&&KDS.length)$("#kst").innerHTML='<span class="ok">Reference cell changed: run the calibration again.</span>';
  bridgeUpd();
}
function setVCell(id){
  VCELL=id;
  const v=$("#vc");if(v)v.textContent=CELLS[id].n;
  /* Picking a library cell means "validate that library cell", so select the
     radio; valUI() otherwise keeps a calibrated model selected. */
  const r=$("#vsl");if(r){r.checked=true;const c=$("#vsc");if(c)c.checked=false;const l=$("#vlib");if(l)l.hidden=false}
  valDirty();bridgeUpd();
}
function setSimCell(i,id){
  SM.vlo[i]=SM.vhi[i]=null;
  if(id&&SM.cells.some((x,j)=>x===id&&j!==i)){const j=SM.cells.findIndex((x,k)=>k!==i&&x===id);SM.cells[j]=SM.cells[i]||""}
  SM.cells[i]=id;
  simUI();simRender(true);
}
function setCmpSlot(i,id){
  if(id&&CS.ids.some((x,j)=>x===id&&+j!==+i)){const j=CS.ids.findIndex((x,k)=>+k!==+i&&x===id);CS.ids[j]=CS.ids[i]||""}
  CS.ids[i]=id;cmpSync();cmpRun();
}
function wireCellPicker(){
  const dlg=$("#cellpick");if(!dlg||dlg._w)return;dlg._w=1;
  const x=$("#cpx");if(x)x.onclick=closeCellPicker;
  const c=$("#cpcancel");if(c)c.onclick=closeCellPicker;
  document.addEventListener("click",function(e){
    var pk=document.getElementById("cellpick");
    if(!pk||pk.hidden||!CPICK.openedAt)return;
    if(Date.now()-CPICK.openedAt<250)return;            // the click that opened it
    if(e.target.closest&&e.target.closest(".cellpop-panel"))return;
    closeCellPicker();
  });
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("#cellpick").hidden)closeCellPicker()});
  document.addEventListener("click",function(e){const r=e.target.closest&&e.target.closest("[data-reset]");if(r)filterReset(r.dataset.reset);});
  $("#cpq").addEventListener("input",renderPickList);
  ["cpbrand","cpch","cpfmt"].forEach(id=>{const s=$("#"+id);if(s)s.addEventListener("change",renderPickList)});
  $("#cpres").addEventListener("click",e=>{const b=e.target.closest("[data-pick]");if(b)confirmPick(b.dataset.pick)});
}

/* ---------- compare tool ---------- */
const CS={ids:["","","",""],C:1,T:25,soh:100,mode:"discharge",x:"q",y:"v",pw:10,Tl:100},SCOL=["var(--s1)","var(--s2)","var(--s3)","var(--s4)"];
const CX={q:"Delivered capacity (Ah)",pct:"Delivered capacity (% of rated)",wh:"Delivered energy (Wh/kg)"},CY={v:["Voltage","Voltage (V)"],T:["Temperature","Cell temperature (°C)"],R:["Resistance","DC resistance (mΩ)"],P:["Max power","Max power (W)"]};
function cmpBuild(){const sl=[["C","C-rate",.05,10,.05,v=>v+" C"],["T","Ambient",-20,55,1,v=>v+" °C"],["soh","State of health",60,100,1,v=>v+" %"],["pw","Pulse length",1,120,1,v=>v+" s"],["Tl","Cell temperature limit",30,100,1,v=>v+" °C"]];
$("#ccellslist").innerHTML=[0,1,2,3].map(i=>`<div class="slot" style="--sc:${SCOL[i]}"><i></i><button type="button" class="slotbtn empty" data-slotcmp="${i}" aria-label="Choose cell ${i+1}">Choose a cell…</button><button type="button" class="slotx" data-clrcmp="${i}" aria-label="Remove cell ${i+1}" hidden>${TRASH}</button></div>`).join("");$("#cctl").innerHTML=`<h2>2 · Operating point</h2><div class="seg" id="cm"><button type="button" data-cm="discharge">Discharge</button><button type="button" data-cm="charge">Charge</button></div>`+sl.map(a=>`<label class="row" for="cs_${a[0]}"><span>${a[1]}</span><output id="co_${a[0]}"></output></label><input id="cs_${a[0]}" data-cs="${a[0]}" type="range" min="${a[2]}" max="${a[3]}" step="${a[4]}">`).join("");
$("#cy").innerHTML=Object.entries(CY).map(([k,v])=>`<button type="button" data-y="${k}">${v[0]}</button>`).join("");$("#cx").innerHTML=Object.entries(CX).map(([k,v])=>`<button type="button" data-x="${k}">${k==="q"?"Ah":k==="pct"?"% rated":"Wh/kg"}</button>`).join("");
$("#cctl").addEventListener("input",e=>{const k=e.target.dataset.cs;if(k){CS[k]=+e.target.value;cmpSync();cmpRun()}});
$("#cctl").addEventListener("click",e=>{const m=e.target.dataset.cm;if(m){CS.mode=m;cmpSync();cmpRun()}});
$("#ccells").addEventListener("click",e=>{const r=e.target.closest("[data-clrcmp]");if(r){setCmpSlot(+r.dataset.clrcmp,"");return}const b=e.target.closest("[data-slotcmp]");if(b)openCellPicker("cmp",+b.dataset.slotcmp)});
$("#cy").onclick=e=>{if(e.target.dataset.y){CS.y=e.target.dataset.y;cmpSync();cmpRun()}};$("#cx").onclick=e=>{if(e.target.dataset.x){CS.x=e.target.dataset.x;cmpSync();cmpRun()}};
$("#ctab").addEventListener("click",e=>{const b=e.target.closest("#ctabcsv");if(!b)return;if(cmpDownloadTable()){b.textContent="Downloaded ✓";setTimeout(()=>{b.textContent="Download table (CSV)"},1400)}});cmpBuilt=true}
/* The chemistry of every cell in the comparison, as the table's first row. */
function cmpChemRow(R){return `<tr><td>Chemistry <small style="color:var(--mut)">cathode</small></td>${R.map(r=>`<td>${esc(r.c.s||"—")}</td>`).join("")}</tr>`}
/* Download the table exactly as it is shown, as a CSV file. */
/* A table's rows as CSV, trimmed and quoted: one implementation for every table export. */
function tblCSV(tbl){
const cell=t=>{const s=t.textContent.replace(/\s+/g," ").trim();return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
return [...tbl.querySelectorAll("tr")].map(tr=>[...tr.children].map(cell).join(",")).join("\n")}
function cmpDownloadTable(){
const tbl=$("#ctab").querySelector("table");if(!tbl)return false;
const what=CS.y==="R"?"resistance":CS.y==="P"?"power":CS.y==="T"?"temperature":"voltage";
return download("obf-compare-"+what+"-"+CS.C+"C-"+CS.T+"C.csv","\ufeff"+tblCSV(tbl)+"\n","text/csv;charset=utf-8")}
function cmpSync(){const u={C:" C",T:" °C",soh:" %",pw:" s",Tl:" °C"};["C","T","soh","pw","Tl"].forEach(k=>{$("#cs_"+k).value=CS[k];$("#co_"+k).textContent=CS[k]+u[k]});
$("#cx").hidden=CS.y==="R"||CS.y==="P";$("#cs_pw").hidden=$("#co_pw").parentElement.hidden=!$("#cx").hidden;$("#cs_C").hidden=$("#co_C").parentElement.hidden=CS.y==="P";$("#cs_Tl").hidden=$("#co_Tl").parentElement.hidden=CS.y!=="P";if(CS.Tl>=100)$("#co_Tl").textContent="no limit";document.querySelectorAll("#cm button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.cm===CS.mode));document.querySelectorAll("#cy button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.y===CS.y));document.querySelectorAll("#cx button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.x===CS.x));
document.querySelectorAll("#ccells .slotbtn").forEach((b,i)=>{const id=CS.ids[i];b.textContent=id?CELLS[id].n:"Choose a cell…";b.classList.toggle("empty",!id)});document.querySelectorAll("#ccells .slotx").forEach((x,i)=>{x.hidden=!CS.ids[i]});cmpEmptyState();bridgeUpd()}
function cmpErr(err){console.error("Comparison failed:",err);$("#cchart").innerHTML='<p class="warn">The solver failed: '+esc(err.message)+'</p>';$("#ctab").innerHTML="";$("#ctab").hidden=true;$("#cleg").innerHTML="";$("#cverd").hidden=true}
async function cmpRun(){if(CS.y==="R"||CS.y==="P")return cmpPow();const ok=fresh("cmp");
const entries=CS.ids.map((id,i)=>({id,i})).filter(e=>e.id).map(e=>({id:e.id,i:e.i,cell:CELLS[e.id],soc0:CS.mode==="charge"?10:100}));
let R=[];
if(entries.length){try{const res=await Solver.run("compare",{cfg:{mode:CS.mode,C:CS.C,T:CS.T,soh:CS.soh},entries});
R=res.map(x=>{const e=entries.find(y=>y.i===x.i);return{i:x.i,id:x.id,c:e.cell,o:x.o,wh:x.wh,col:SCOL[x.i],Q:x.Q,E:x.E,sE:x.sE,pA:x.pA,sP:x.sP,Tm:x.Tm,cf:x.cf,dur:x.dur,pct:x.pct}})}catch(err){if(ok())cmpErr(err);return}}
if(!ok())return;cmpDraw(R)}
function cmpDraw(R){if(!R.length){$("#cchart").innerHTML='<p class="sub">Select at least one cell.</p>';$("#ctab").innerHTML="";$("#ctab").hidden=true;$("#cleg").innerHTML="";$("#cverd").hidden=true;$("#cverdp").innerHTML="";return}
const dsh=["","","",""],uy=CS.y==="v"?" V":" °C",dy=CS.y==="v"?3:1;
plot($("#cchart"),{series:R.map(r=>({name:r.c.n,x:CS.x==="q"?r.o.q:CS.x==="pct"?r.o.q.map(q=>q/r.c.Ah*100):r.wh,y:CS.y==="v"?r.o.v:r.o.T,col:r.col,w:3,dash:dsh[CS.ids.indexOf(r.id)]||"",fmt:v=>v.toFixed(dy)+uy,ext:r.o.cf.map(c=>c<.9?1:0),extSame:true,band:CS.y==="v"&&r.o.cf.some(c=>c<1)?[r.o.v.map((v,i)=>v-(1-r.o.cf[i])*.25),r.o.v.map((v,i)=>v+(1-r.o.cf[i])*.25)]:null})),bandFirst:true,xl:CX[CS.x],yl:CY[CS.y][1],al:"Cell comparison chart",fx:v=>v.toFixed(2)+(CS.x==="q"?" Ah":CS.x==="pct"?" %":" Wh/kg"),note:"Dotted segments: values extrapolated beyond the cell's datasheet. Shaded bands: voltage uncertainty of each cell, widening along its own curve and shown only where it exists. The table's minimum confidence is the worst point of the run."});$("#cleg").innerHTML="";
const M=[["Delivered capacity","Ah",r=>r.Q,2,1],["Capacity vs rated","%",r=>r.pct,0,1],["Energy","Wh",r=>r.E,1,1],["Specific energy at this load","Wh/kg",r=>r.sE,0,1],["Average power","W",r=>r.pA,1,1],["Specific power at this load","W/kg",r=>r.sP,0,1],["Peak temperature","°C",r=>r.Tm,1,-1],["Duration","min",r=>r.dur,1,0],["Min. confidence","%",r=>r.cf,0,1]];
$("#ctab").innerHTML=`<table><thead><tr><th>Metric</th>${R.map(r=>`<th style="color:${r.col}">${["●","■","▲","◆"][r.i]} ${r.c.n}</th>`).join("")}</tr></thead><tbody>${cmpChemRow(R)}${M.map(m=>{const v=R.map(r=>m[2](r)),b=m[4]===0||R.length<2?null:(m[4]>0?Math.max(...v):Math.min(...v));return `<tr><td>${m[0]} <small style="color:var(--mut)">${m[1]}</small></td>${v.map(x=>`<td${x===b?' class="best"':""}>${x.toFixed(m[3])}</td>`).join("")}</tr>`}).join("")}</tbody></table><div class="ctabfoot"><button type="button" class="dlb" id="ctabcsv">Download table (CSV)</button></div>`;$("#ctab").hidden=false;
const top=(f,d)=>R.reduce((a,b)=>(d>0?f(b)>f(a):f(b)<f(a))?b:a);
$("#cverd").hidden=false;$("#cverdp").innerHTML=R.length<2?"Select a second cell to compare.":`At ${CS.C} C and ${CS.T} °C: highest specific energy <b>${top(r=>r.sE,1).c.n}</b> (${top(r=>r.sE,1).sE.toFixed(0)} Wh/kg), highest specific power <b>${top(r=>r.sP,1).c.n}</b> (${top(r=>r.sP,1).sP.toFixed(0)} W/kg), coolest <b>${top(r=>r.Tm,-1).c.n}</b> (+${(top(r=>r.Tm,-1).Tm-CS.T).toFixed(1)} K). Low-confidence cells are extrapolating beyond their datasheet.`}
/* ---------- resistance R(t, SOC, I, T) with Butler–Volmer, and max power ---------- */


async function cmpPow(){const isR=CS.y==="R",tl=!isR&&CS.Tl<100,ok=fresh("cmp");
const entries=CS.ids.map((id,i)=>({id,i})).filter(e=>e.id).map(e=>({id:e.id,i:e.i,cell:CELLS[e.id]}));
let R=[];
if(entries.length){try{const res=await Solver.run("power",{cfg:{mode:CS.mode,soh:CS.soh,isR,C:CS.C,T:CS.T,pw:CS.pw,Tl:CS.Tl},entries});
R=res.map(x=>{const e=entries.find(y=>y.i===x.i);return{c:e.cell,i:x.i,col:SCOL[x.i],nT:x.nT,d:x.d}})}catch(err){if(ok())cmpErr(err);return}}
if(!ok())return;cmpPowDraw(R,isR,tl)}
function cmpPowDraw(R,isR,tl){const ch=CS.mode==="charge",S=[...Array(101).keys()];if(!R.length){$("#cchart").innerHTML='<p class="sub">Select at least one cell.</p>';$("#ctab").innerHTML="";$("#ctab").hidden=true;$("#cleg").innerHTML="";$("#cverd").hidden=true;$("#cverdp").innerHTML="";return}
const u=isR?" mΩ":" W",dg=isR?2:0;
plot($("#cchart"),{series:R.map(r=>({name:r.c.n,x:S,y:r.d,col:r.col,w:3,dash:"",fmt:v=>v.toFixed(dg)+u})),xl:"State of charge (%)",yl:isR?`DC resistance at ${CS.C} C (mΩ)`:(ch?"Max charge power (W)":"Max discharge power (W)")+(tl?` · ≤ ${CS.Tl} °C`:""),al:isR?"Resistance versus SOC":"Maximum power versus SOC",fx:v=>v.toFixed(0)+" % SOC",
note:isR?"DC resistance at the chosen C-rate, pulse length, temperature and state of health, from each cell’s library 3RC split, including the current-dependent charge-transfer term. Library-derived values, not measured.":"Maximum power at the optimal current, limited by the cut-off voltage (discharge) or the upper voltage limit (charge)"+(tl?`, and by a cell temperature of ${CS.Tl} °C reached at the end of a ${CS.pw} s pulse from ${CS.T} °C`:". No thermal limit is applied")+"."});$("#cleg").innerHTML="";
$("#ctab").innerHTML=`<table><thead><tr><th>${isR?"DC resistance":"Max power"} <small>${isR?"mΩ":"W"}</small></th>${R.map(r=>`<th style="color:${r.col}">${["●","■","▲","◆"][r.i]} ${r.c.n}</th>`).join("")}</tr></thead><tbody>${cmpChemRow(R)}${[10,30,50,70,90].map(p=>{const v=R.map(r=>r.d[p]),b=R.length<2?null:(isR?Math.min(...v):Math.max(...v));return `<tr><td>at ${p} % SOC</td>${v.map(x=>`<td${x===b?' class="best"':""}>${x.toFixed(dg)}</td>`).join("")}</tr>`}).join("")}</tbody></table><div class="ctabfoot"><button type="button" class="dlb" id="ctabcsv">Download table (CSV)</button></div>`;$("#ctab").hidden=false;
const w=R.reduce((a,b)=>(isR?b.d[50]<a.d[50]:b.d[50]>a.d[50])?b:a);
$("#cverd").hidden=false;$("#cverdp").innerHTML=`${CS.T} °C, ${CS.soh} % SOH, ${CS.pw} s pulse${isR?`, ${CS.C} C`:`, ${ch?"charge":"discharge"}`}. At 50 % SOC the ${isR?"lowest resistance":"highest power"} is <b>${w.c.n}</b> (${w.d[50].toFixed(dg)}${u}).`+(tl?` The ${CS.Tl} °C limit binds before the voltage limit at ${w.nT} of 101 SOC points for ${w.c.n}.`:"")}
/* ---------- calibration tool ---------- */





function parseCSV(txt){const L=txt.trim().split(/\r?\n/).filter(x=>x.trim());if(L.length<20)throw new Error("Need at least 20 rows.");const sep=L[0].includes(";")?";":L[0].includes("\t")?"\t":",";let hd=L[0].split(sep).map(h=>h.trim().toLowerCase()),st=1;
let it,ic,iv,iT;if(isNaN(parseFloat(hd[0]))){const f=fn=>hd.findIndex(fn);it=f(h=>h.includes("time")||h==="t"||h.startsWith("t_")||h.includes("sec"));ic=f(h=>h.includes("curr")||h==="i"||h.startsWith("i(")||h.startsWith("i_"));iv=f(h=>h.includes("volt")||h==="v"||h.startsWith("v(")||h.startsWith("v_"));iT=f(h=>h.includes("temp"));}else{it=0;ic=1;iv=2;iT=hd.length>3?3:-1;st=0}
if(it<0||ic<0||iv<0)throw new Error("Columns needed: time, current, voltage (temperature optional).");
const rows=[];for(let k=st;k<L.length;k++){const a=L[k].split(sep).map(parseFloat);if(isNaN(a[it])||isNaN(a[ic])||isNaN(a[iv]))continue;rows.push([a[it],a[ic],a[iv],iT>=0&&!isNaN(a[iT])?a[iT]:null])}
if(rows.length<20)throw new Error("Could not read enough numeric rows.");rows.sort((a,b)=>a[0]-b[0]);const hasT=iT>=0&&rows.every(r=>r[3]!==null);
return{t:rows.map(r=>r[0]),i:rows.map(r=>r[1]),v:rows.map(r=>r[2]),T:hasT?rows.map(r=>r[3]):null}}
function profInfo(){$("#kfit").disabled=!KDS.length;$("#kvc").hidden=!KF;{const hT=KDS.some(d=>d.T);$("#f4t").disabled=!hT;if(!hT)$("#f4t").checked=false;$("#f4t").title=hT?"":"Load a profile with a temperature column to fit the thermal model"}const mm=a=>a.reduce((r,x)=>[Math.min(r[0],x),Math.max(r[1],x)],[Infinity,-Infinity]);
$("#kinfo").innerHTML=KDS.map((d,j)=>{const i=mm(d.i),v=mm(d.v),t=d.T?mm(d.T):null;return `<div class="prow"><div class="pt"><b title="${esc(d.name)}">${esc(d.name)}</b><button type="button" class="rm" data-rm="${j}" aria-label="Remove ${esc(d.name)}">✕</button></div><small>${d.t.length} samples · ${((d.t[d.t.length-1]-d.t[0])/60).toFixed(0)} min · I ${i[0].toFixed(1)} to ${i[1].toFixed(1)} A · V ${v[0].toFixed(2)} to ${v[1].toFixed(2)} V · ${t?"T "+t[0].toFixed(0)+" to "+t[1].toFixed(0)+" °C":"no temperature (25 °C assumed)"}</small><label class="cb1"><input type="checkbox" class="kneg" data-j="${j}" ${d.neg?"checked":""}><span>Charge current is positive</span></label><label class="so">SOC₀ %<input class="ks0" data-j="${j}" placeholder="auto" value="${d.soc0u||""}" inputmode="decimal"></label></div>`}).join("");
if(!KDS.length){$("#kres").innerHTML='<div class="card pnl" style="color:var(--mut)">Results appear here: fit quality, parameters, equations and BMS-ready export.</div>';return}
const PC=["var(--s1)","var(--s2)","var(--s3)","var(--acc-d)","var(--warn)","var(--mut)"];
$("#kres").innerHTML=`<div class="card pnl"><h2>Profile preview</h2><div id="kp0"></div><p class="note" style="margin:8px 0 0;font-size:13px;color:var(--mut)">${KDS.length} profile${KDS.length>1?"s":""} loaded. Press “Run calibration” to refit one model on all of them.</p></div>`;
plot($("#kp0"),{series:KDS.map((d,j)=>({name:d.name,x:d.t.map(x=>x/60),y:d.v,col:PC[j%6],w:1.8,fmt:v=>v.toFixed(3)+" V"})),xl:"Time (min)",yl:"Voltage (V)",H:280,nolegend:KDS.length<2,fx:v=>v.toFixed(1)+" min",al:"Measured voltage"})}
function loadProfile(txt,name){try{if(KDS.length>=6)throw new Error("Maximum 6 profiles: remove one first.");const d=parseCSV(txt);d.name=name;KDS.push(d);KF=null;$("#kerr").textContent="";profInfo()}catch(e){$("#kerr").textContent=name+": "+e.message}}
function readFile(f){const r=new FileReader();r.onload=()=>loadProfile(String(r.result),f.name);r.readAsText(f)}
function cmpEmptyState(){
  const has=CS.ids.some(Boolean);
  const w=document.getElementById("cwrap");if(w)w.hidden=!has;
  const m=document.getElementById("cmsg");if(m)m.hidden=has;
  const tt=document.getElementById("ctab");if(tt&&!has)tt.hidden=true;
  if(!has){const vd=document.getElementById("cverd");if(vd)vd.hidden=true;}
}
let demoN=0;
function demoProfile(){if(KDS.length>=6){$("#kerr").textContent="Maximum 6 profiles: remove one first.";return}const c=CELLS[KCELL],tr={r0:c.r0*1.4,rc:[[c.r1*.54,c.tau*.28],[c.r1*.72,c.tau*2.7]],Q:c.Ah*.95,B:c.B},nn=demoN++,Tb=[18,6,30][nn%3];let seed=7+13*nn;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
const n=3600,dt=2,t=[],I=[];let cur=0;for(let k=0;k<n;k++){t.push(k*dt);if(k<60)cur=0;else if(k%15===0)cur=(rnd()<.2?-.4:rnd()*1.8)*c.Ah*(rnd()<.25?0:1);I.push(cur)}
const tot=I.reduce((q,x)=>q+x*dt,0),sc=.6*tr.Q*3600/tot;for(let k=0;k<n;k++)I[k]*=sc;const r=predictT(c,tr,{t,i:I,soc0:.95},Tb,1.2,.9);
KDS.push({t,i:I.map(x=>+x.toFixed(3)),v:r.v.map(x=>+(x+(rnd()-.5)*.006).toFixed(4)),T:r.T.map(x=>+(x+(rnd()-.5)*.2).toFixed(2)),name:"demo profile "+(nn+1)+" (~"+Tb+" °C)"});KF=null;$("#kerr").textContent="";profInfo()}
let FITTING=false;
function runFit(){if(FITTING)return;if(!KDS.length){$("#kst").innerHTML='<span class="warn">Load a profile first.</span>';return}const id=KCELL,c=CELLS[id],n=RCS[KECM].length,P=KDS.length,O=3+P,TH=O+2*n,idx=[],rct=n>0&&$("#krct").checked,th=$("#f4t").checked&&KDS.some(d=>d.T),u0=[...document.querySelectorAll(".ks0")].map(x=>x.value.trim());
if($("#f0").checked)idx.push(0);if($("#f1").checked)for(let j=0;j<2*n;j++)idx.push(O+j);if($("#f2").checked)idx.push(1);if($("#f3").checked)idx.push(2);u0.forEach((x,j)=>{if(!x)idx.push(3+j)});if(th)idx.push(TH,TH+1);
if(!idx.length){$("#kst").innerHTML='<span class="warn">Select at least one parameter to fit.</span>';return}$("#kst").textContent="Fitting…";FITTING=true;$("#kfit").disabled=true;
Solver.run("fit",{cell:c,profs:KDS,ecm:KECM,rct,th,idx,u0}).then(F=>{FITTING=false;$("#kfit").disabled=!KDS.length;
KF={id,ecm:KECM,rct,th,TH,c,ds:F.ds,names:F.ds.map(d=>d.name),p0:F.p0,p1:F.p1,idx,v0:F.v0,v1:F.v1,tv0:F.tv0,tv1:F.tv1,m0:F.m0,m1:F.m1,mT0:F.mT0,mT1:F.mT1,mp0:F.mp0,mp1:F.mp1,Tr:F.Tr,Ir:F.Ir};KVi=0;$("#kvc").hidden=false;
$("#kst").innerHTML=`<span class="ok">Done (${KECM==="R"?"resistance only":KECM+(rct?" with R<sub>ct</sub>":"")}${th?", thermal":""}, ${P} profile${P>1?"s":""}, ${idx.length} parameters). RMSE ${(KF.m0.rmse*1e3).toFixed(1)} → ${(KF.m1.rmse*1e3).toFixed(1)} mV${th?`; temperature ${KF.mT0.rmse.toFixed(2)} → ${KF.mT1.rmse.toFixed(2)} K`:""}.</span>`;kRender()}).catch(err=>{FITTING=false;$("#kfit").disabled=!KDS.length;console.error("Calibration failed:",err);$("#kst").innerHTML='<span class="warn">The solver failed: '+esc(err.message)+'</span>'})}
function exportText(k,F0){const F=F0||KF,c=F.c,p=F.p1,o=c.ocv,f=x=>+(+x).toPrecision(6),soc=o.map((_,i)=>i/(o.length-1)),rc=p.rc,n=rc.length,N=Math.max(1,n),Rs=n?rc.map(b=>f(b[0])):[0],Ts=n?rc.map(b=>f(b[1])):[1],cf=x=>{const t=String(+(+x).toPrecision(6));return(/[.e]/i.test(t)?t:t+".0")+"f"};
if(k==="json")return JSON.stringify({generator:"openBatteryFlux",model:"ECM-"+F.ecm,reference_cell:F.id,chemistry:c.s,units:{Q:"Ah",R:"ohm",tau:"s",B:"K",V:"V"},parameters:{Q_Ah:f(p.Q),R0_25C_ohm:f(p.r0),B_K:f(p.B),rc_branches:rc.map((b,j)=>({R_25C_ohm:f(b[0]),tau_s:f(b[1]),role:F.rct&&j===0?"charge_transfer_butler_volmer":"diffusion"}))},ocv:{soc,V:o},temperature_model:{T_ref_K:298.15,capacity_derating_per_K:.008,capacity_floor:.45},soc_resistance_factor:{low_soc:{k:.6,s:.08},high_soc:{k:.35,s:.03}},thermal:{C_th_J_per_K:f(c.m*.9*(p.cth||1)),hA_W_per_K:f(c.hA*(p.hAs||1))},validity:{T_C:F.Tr.map(f),I_A:F.Ir.map(f),rmse_mV:F.m1?f(F.m1.rmse*1e3):null,profiles:F.ds?F.ds.length:0},validation:F.val||undefined},null,2);
if(k==="c")return ["/* openBatteryFlux ECM-"+F.ecm+" parameters (generated). I_A > 0 = discharge. */","#include <math.h>",`#define OBF_Q_AH ${cf(p.Q)}`,`#define OBF_R0_25_OHM ${cf(p.r0)}`,`#define OBF_B_K ${cf(p.B)}`,`#define OBF_NRC ${N}  /* RC branches: ${n} (an unused slot has R = 0) */`,`static const float OBF_R_25_OHM[OBF_NRC] = {${Rs.map(cf).join(", ")}};`,`static const float OBF_TAU_S[OBF_NRC] = {${Ts.map(cf).join(", ")}};`,`static const float OBF_OCV_V[101] = {${o.map(cf).join(", ")}};`,"typedef struct { float soc, v[OBF_NRC]; } obf_state_t;",
"static float obf_ocv(float soc){ if(soc<=0.0f) return OBF_OCV_V[0]; if(soc>=1.0f) return OBF_OCV_V[100]; float x=soc*100.0f; int i=(int)x; return OBF_OCV_V[i]+(OBF_OCV_V[i+1]-OBF_OCV_V[i])*(x-(float)i); }",
"/* Returns terminal voltage and advances the state by dt_s seconds. */","static float obf_step(obf_state_t *s, float I_A, float T_C, float dt_s){","  float k  = expf(OBF_B_K*(1.0f/(T_C+273.15f)-1.0f/298.15f));","  float q  = OBF_Q_AH*(T_C<25.0f ? fmaxf(0.45f,1.0f-0.008f*(25.0f-T_C)) : 1.0f);","  float v  = obf_ocv(s->soc) - I_A*OBF_R0_25_OHM*k*(1.0f+0.6f*expf(-s->soc/0.08f)+0.35f*expf(-(1.0f-s->soc)/0.03f));","  for(int j=0;j<OBF_NRC;j++){ float a=expf(-dt_s/OBF_TAU_S[j]); v -= s->v[j]; s->v[j]=s->v[j]*a+I_A*OBF_R_25_OHM[j]*k*(1.0f-a); }","  s->soc -= I_A*dt_s/(q*3600.0f);","  return v;","}"].join("\n");
if(k==="py")return ["# openBatteryFlux ECM-"+F.ecm+" parameters (generated). i_a > 0 = discharge.","import math",`PARAMS = dict(Q_Ah=${f(p.Q)}, R0_25C=${f(p.r0)}, B_K=${f(p.B)}, RC=[${rc.map((b,j)=>`(${Rs[j]}, ${Ts[j]})`).join(", ")}])`,"OCV_V = "+JSON.stringify(o),"def ocv(soc):","    x = min(max(soc,0.0),1.0)*100; i = min(int(x),99); return OCV_V[i]+(OCV_V[i+1]-OCV_V[i])*(x-i)","# state = {'soc': 1.0, 'v': [0.0]*len(PARAMS['RC'])}","def step(state, i_a, t_c, dt):","    P = PARAMS; k = math.exp(P['B_K']*(1/(t_c+273.15)-1/298.15))","    q = P['Q_Ah']*(max(0.45,1-0.008*(25-t_c)) if t_c<25 else 1)","    v = ocv(state['soc']) - i_a*P['R0_25C']*k*(1+0.6*math.exp(-state['soc']/0.08)+0.35*math.exp(-(1-state['soc'])/0.03))","    for j,(r,tau) in enumerate(P['RC']):","        a = math.exp(-dt/tau); v -= state['v'][j]; state['v'][j] = state['v'][j]*a + i_a*r*k*(1-a)","    state['soc'] -= i_a*dt/(q*3600)","    return v"].join("\n");
const r=["soc_pct,T_C,r0_mohm"+rc.map((_,j)=>",r"+(j+1)+"_mohm").join("")];for(let T=-20;T<=50;T+=10)for(let s=0;s<=100;s+=1){const kk=Math.exp(p.B*(1/(T+273.15)-1/298.15));r.push([s,T,(p.r0*kk*socF(s/100)*1e3).toFixed(3),...rc.map(b=>(b[0]*kk*1e3).toFixed(3))].join(","))}return r.join("\n")}
function kRender(){const F=KF,KV=Math.min(KVi,F.ds.length-1),D=F.ds[KV],t=D.t.map(x=>x/60),p0=F.p0,p1=F.p1,ms=x=>(x*1e3).toFixed(1),O=3+F.ds.length,fx=n=>F.idx.includes(n);
const K=[["RMSE before",ms(F.m0.rmse)+" mV"],["RMSE after",ms(F.m1.rmse)+" mV"],["MAE after",ms(F.m1.mae)+" mV"],["Max error",ms(F.m1.max)+" mV"],["R² after",F.m1.r2.toFixed(4)]];if(F.th)K.push(["Temp. RMSE before",F.mT0.rmse.toFixed(2)+" K"],["Temp. RMSE after",F.mT1.rmse.toFixed(2)+" K"]);
const sb=i=>"₁₂₃"[i],PR=[["R₀ @25 °C","mΩ",p0.r0*1e3,p1.r0*1e3,fx(0)]];p1.rc.forEach((b,j)=>{PR.push([`${F.rct&&!j?"R_ct":"R"+sb(j)} @25 °C`,"mΩ",p0.rc[j][0]*1e3,b[0]*1e3,fx(O+2*j)],[`${F.rct&&!j?"τ_ct":"τ"+sb(j)}`,"s",p0.rc[j][1],b[1],fx(O+1+2*j)])});PR.push(["Q (effective)","Ah",p0.Q,p1.Q,fx(1)],["B (Arrhenius)","K",p0.B,p1.B,fx(2)],...F.ds.map((d,j)=>["Initial SOC · "+d.name,"%",d.soc0*100,(d.soc0+(p1.dsv[j]||0))*100,fx(3+j)]));if(F.th)PR.push(["C_th","J/K",F.c.m*.9*p0.cth,F.c.m*.9*p1.cth,fx(F.TH)],["hA","W/K",F.c.hA*p0.hAs,F.c.hA*p1.hAs,fx(F.TH+1)]);
const rc=p1.rc,eq=`Model: ${F.ecm==="R"?"R₀ only (no RC branches)":"R₀ + "+rc.length+" RC branch"+(rc.length>1?"es":"")}\nSOC(t)   = SOC₀ − (1/3600)·∫ I dt / Q_eff(T)\nQ_eff(T) = Q · max(0.45, 1 − 0.008·(25 − T))   for T < 25 °C, else Q\nOCV(SOC) = 101-point (1 % step) linear LUT (${F.c.s} reference)\nR₀(T,SOC)= R₀,25 · exp[B(1/T − 1/298.15)] · (1 + 0.6·e^(−SOC/0.08) + 0.35·e^(−(1−SOC)/0.03))\n`+(rc.length?`Rₖ(T)    = Rₖ,25 · exp[B(1/T − 1/298.15)]      (k = 1…${rc.length})\nVₖ[i+1]  = Vₖ[i]·e^(−Δt/τₖ) + I[i]·Rₖ·(1 − e^(−Δt/τₖ))\n`:"")+`V[i]     = OCV(SOC[i]) − I[i]·R₀${rc.length?" − ΣVₖ[i]":""}        (I > 0: discharge)${F.rct?"\nBranch 1 is the charge-transfer RC (Butler–Volmer, α = 0.5): R₁(I) = R₁·asinh(x)/x, x = F·|I|·R₁/(2RT)":""}${F.th?"\nC_th·dT/dt = I²·(R₀ + ΣR_k) − hA·(T − T_amb),  T_amb = first measured temperature (C_th and hA fitted)":""}\n\nFitted: Q=${p1.Q.toFixed(3)} Ah · R₀,25=${(p1.r0*1e3).toFixed(2)} mΩ`+rc.map((b,j)=>` · R${sb(j)},25=${(b[0]*1e3).toFixed(2)} mΩ · τ${sb(j)}=${b[1].toFixed(1)} s`).join("")+` · B=${p1.B.toFixed(0)} K${F.th?` · C_th=${(F.c.m*.9*p1.cth).toFixed(1)} J/K · hA=${(F.c.hA*p1.hAs).toFixed(3)} W/K`:""}\nThe 0.008, 0.45, 0.6/0.08 and 0.35/0.03 factors are fixed heuristics, not fitted.`;
const PT=F.ds.length>1?`<div class="card pnl tbl"><div class="phd"><h2>Per-profile fit</h2></div><table><thead><tr><th>Profile</th><th>RMSE before</th><th>RMSE after</th></tr></thead><tbody>${F.names.map((n,j)=>`<tr><td>${esc(n)}</td><td>${ms(F.mp0[j].rmse)} mV</td><td><b>${ms(F.mp1[j].rmse)} mV</b></td></tr>`).join("")}</tbody></table></div>`:"",SEL=F.ds.length>1?`<select id="kvsel" aria-label="Profile shown">${F.names.map((n,j)=>`<option value="${j}"${j===KV?" selected":""}>${esc(n)}</option>`).join("")}</select>`:"";
$("#kres").innerHTML=`<div class="kpis">${K.map(k=>`<div class="kpi"><small>${k[0]}</small><b>${k[1]}</b></div>`).join("")}</div>
${PT}<div class="card pnl"><div class="phd"><h2>Voltage: measured vs model</h2>${SEL}<button type="button" class="dlb" data-dl="kp1" data-t="Voltage: measured vs model">Download image</button></div><div id="kp1"></div></div>
<div class="card pnl"><div class="phd"><h2>Voltage error (mV)</h2><button type="button" class="dlb" data-dl="kp2" data-t="Voltage error (mV)">Download image</button></div><div id="kp2"></div></div>${F.th&&D.T?`<div class="card pnl"><div class="phd"><h2>Cell temperature: measured vs thermal model</h2><button type="button" class="dlb" data-dl="kp3" data-t="Cell temperature: measured vs thermal model">Download image</button></div><div id="kp3"></div></div>`:""}
<div class="card pnl tbl"><table><thead><tr><th>Parameter</th><th>Unit</th><th>Library</th><th>Calibrated</th><th>Change</th></tr></thead><tbody>${PR.map(r=>`<tr><td>${r[0]}${r[4]?"":" <small style='color:var(--mut)'>(fixed)</small>"}</td><td>${r[1]}</td><td>${r[2].toFixed(3)}</td><td><b>${r[3].toFixed(3)}</b></td><td>${((r[3]/r[2]-1)*100).toFixed(1)} %</td></tr>`).join("")}</tbody></table></div>
<div class="card pnl"><h2>Model equations</h2><pre class="eq">${eq}</pre><p class="note" style="font-size:12px;color:var(--mut);margin:8px 0 0">Valid for T ${F.Tr[0].toFixed(0)} to ${F.Tr[1].toFixed(0)} °C and I ${F.Ir[0].toFixed(1)} to ${F.Ir[1].toFixed(1)} A (the range of your data). A single profile may not identify the RC parameters uniquely (more branches, weaker identification): use pulses and rests at several temperatures for robust values. No confidence intervals yet.</p></div>
<div class="card pnl"><h2>BMS-ready export</h2><div class="seg" id="kex"><button type="button" data-ex="json" aria-pressed="true">JSON</button><button type="button" data-ex="c">C header</button><button type="button" data-ex="py">Python</button><button type="button" data-ex="lut">R–T–SOC table (CSV)</button></div><textarea class="ex" id="kxt" readonly aria-label="Export"></textarea><div class="seg"><button type="button" class="bp" id="kcp">Copy to clipboard</button><button type="button" id="kdl">Download file</button><button type="button" id="kapply">Use in simulator</button></div><span id="kcm" style="font-size:13px"></span></div>`;
plot($("#kp1"),{series:[{name:"Measured",x:t,y:D.v,col:"var(--mut)",w:1.8,fmt:v=>v.toFixed(3)+" V"},{name:"Library parameters",x:t,y:F.v0[KV],col:"var(--warn)",w:2,dash:"6 5",fmt:v=>v.toFixed(3)+" V"},{name:"Calibrated",x:t,y:F.v1[KV],col:"var(--acc-d)",w:2.6,fmt:v=>v.toFixed(3)+" V"}],xl:"Time (min)",yl:"Voltage (V)",H:320,fx:v=>v.toFixed(1)+" min",al:"Measured vs model voltage"});
plot($("#kp2"),{series:[{name:"Library parameters",x:t,y:F.v0[KV].map((v,i)=>(v-D.v[i])*1e3),col:"var(--warn)",w:1.6,fmt:v=>v.toFixed(1)+" mV"},{name:"Calibrated",x:t,y:F.v1[KV].map((v,i)=>(v-D.v[i])*1e3),col:"var(--acc-d)",w:1.8,fmt:v=>v.toFixed(1)+" mV"}],xl:"Time (min)",yl:"Error (mV)",H:240,fx:v=>v.toFixed(1)+" min",al:"Voltage error",ymin:-10,ymax:10});if(F.th&&D.T)plot($("#kp3"),{series:[{name:"Measured",x:t,y:D.T,col:"var(--mut)",w:1.8,fmt:v=>v.toFixed(1)+" °C"},{name:"Library thermal",x:t,y:F.tv0[KV],col:"var(--warn)",w:2,dash:"6 5",fmt:v=>v.toFixed(1)+" °C"},{name:"Calibrated thermal",x:t,y:F.tv1[KV],col:"var(--acc-d)",w:2.6,fmt:v=>v.toFixed(1)+" °C"}],xl:"Time (min)",yl:"Cell temperature (°C)",H:240,fx:v=>v.toFixed(1)+" min",al:"Cell temperature"});
let KEX="json";const showEx=k=>{KEX=k;$("#kxt").value=exportText(k);document.querySelectorAll("#kex button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.ex===k))};showEx("json");
$("#kex").onclick=e=>{if(e.target.dataset.ex)showEx(e.target.dataset.ex)};
$("#kcp").onclick=()=>{const t=$("#kxt");t.select();let ok=false;try{ok=document.execCommand("copy")}catch(x){}try{const p=navigator.clipboard.writeText(t.value);p&&p.catch&&p.catch(()=>{})}catch(x){}$("#kcm").textContent=ok?"Copied.":"Selected: press Ctrl/Cmd+C."};
$("#kdl").onclick=()=>{const ext={json:"json",c:"h",py:"py",lut:"csv"}[KEX]||"txt";download("obf-"+F.id+"."+ext,$("#kxt").value,"text/plain;charset=utf-8");$("#kcm").textContent="File downloaded."};
$("#kvsel")&&($("#kvsel").onchange=e=>{KVi=+e.target.value;kRender()});
$("#kapply").onclick=()=>{SM.ecm=F.ecm||SM.ecm;SM.rct=!!F.rct;CAL[F.id]={r0:p1.r0,r1:p1.r1,tau:p1.tau,Ah:p1.Q,B:p1.B,rcC:{m:F.ecm,a:p1.rc},hAs:p1.hAs,cthS:p1.cth};SM.cal=true;SM.soh=100;location.hash="#/sim/"+F.id}}
function calInit(){const k=$("#kc");if(!k||k._p)return;k._p=1;k.textContent=CELLS[KCELL].n;k.onclick=()=>openCellPicker("k",0);const kh=$("#kch");if(kh)kh.onclick=()=>openCellPicker("k",0);const d=$("#drop");["dragover","dragenter"].forEach(ev=>d.addEventListener(ev,e=>{e.preventDefault();d.classList.add("on")}));["dragleave","drop"].forEach(ev=>d.addEventListener(ev,e=>{e.preventDefault();d.classList.remove("on")}));
d.addEventListener("drop",e=>{[...e.dataTransfer.files].forEach(readFile)});$("#kf").onchange=e=>{[...e.target.files].forEach(readFile);e.target.value=""};$("#kinfo").addEventListener("input",e=>{const j=e.target.dataset.j;if(j!==undefined)KDS[+j].soc0u=e.target.value});$("#kinfo").addEventListener("click",e=>{const b=e.target.closest("[data-rm]");if(b){KDS.splice(+b.dataset.rm,1);KF=null;profInfo()}});$("#kdemo").onclick=demoProfile;
$("#kinfo").addEventListener("change",e=>{if(e.target.classList.contains("kneg")){KDS[+e.target.dataset.j].neg=e.target.checked;KF=null;profInfo()}});$("#kfit").onclick=runFit}
/* ---------- headline typewriter ---------- */
(function(){const el=$("#tw"),T=["Simulate any cell from its datasheet","Turn a datasheet into a working model","Browse reference cells from NMC to Li-metal","Compare up to three cells under the same load","See exactly where the model extrapolates","Drive any cell with your own load profile","Pick a circuit model, from R only to 3RC","Model charge transfer with Butler–Volmer","Refit the circuit model on your measurements","Calibrate the thermal model from real data","Validate on data the model has never seen","Export parameters your BMS can run","Free, open source, yours to host and change"];
if(matchMedia("(prefers-reduced-motion:reduce)").matches){el.textContent=T[0];return}
let i=0,j=0,del=false;function tick(){const t=T[i];j+=del?-1:1;el.textContent=t.slice(0,j);let d=del?16:40;if(!del&&j===t.length){del=true;d=2400}else if(del&&j===0){del=false;i=(i+1)%T.length;d=350}setTimeout(tick,d)}tick()})();
/* ---------- theme, menu, polish ---------- */
function setTheme(t){document.documentElement.dataset.theme=t;$("#thm").setAttribute("aria-label",t==="dark"?"Switch to light theme":"Switch to dark theme");const m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="dark"?"#060A12":"#F5F8FB");try{localStorage.setItem("obf_theme",t)}catch(e){}if(window.__obfFx)window.__obfFx()}
let th0="light";try{th0=localStorage.getItem("obf_theme")||"light"}catch(e){}setTheme(th0);
$("#thm").onclick=()=>setTheme(document.documentElement.dataset.theme==="dark"?"light":"dark");
/* The account menu in the header toggles the same theme. */
window.OBF=window.OBF||{};
OBF.theme={get:()=>document.documentElement.dataset.theme||"light",set:setTheme,toggle:()=>setTheme(document.documentElement.dataset.theme==="dark"?"light":"dark")};
$("#mnu").onclick=()=>{const o=document.querySelector(".nav").classList.toggle("open");$("#mnu").setAttribute("aria-expanded",o)};
addEventListener("scroll",()=>document.querySelector(".nav").classList.toggle("sc",scrollY>8),{passive:true});
function rp(el){el.style.setProperty("--p",((el.value-el.min)/(el.max-el.min)*100)+"%")}
function rpAll(){document.querySelectorAll("input[type=range]").forEach(rp)}
document.addEventListener("input",e=>{if(e.target.type==="range")rp(e.target)});
$("#skip").onclick=e=>{e.preventDefault();const t=document.querySelector("#home:not([hidden]),.view:not([hidden])");if(t){t.tabIndex=-1;t.focus()}};
$("#hq").onclick=e=>{const b=e.target.closest("button");if(!b)return;HA.user();hMode=b.dataset.m||"";$("#hC").value=b.dataset.c;$("#hT").value=b.dataset.t;rpAll();hero()};
$("#ktpl").onclick=()=>{const t="time_s,current_A,voltage_V,temp_C\n0,0.0,4.102,24.8\n1,2.5,4.071,24.8\n2,2.5,4.066,24.9\n",a=document.createElement("textarea");a.value=t;a.style.cssText="position:fixed;opacity:0";document.body.appendChild(a);a.select();let ok=false;try{ok=document.execCommand("copy")}catch(x){}a.remove();try{const p=navigator.clipboard.writeText(t);p&&p.catch&&p.catch(()=>{})}catch(x){}$("#kinfo").innerHTML=`<span class="ok">${ok?"Template copied to clipboard.":"Template: see the format example above."}</span>`};
/* ---------- experience layer: motion that stays out of the way ---------- */
function replayHome(){const els=[$(".nb-copy"),$(".nb-demo")];els.forEach(el=>{if(!el)return;el.classList.remove("anim");void el.offsetWidth;el.classList.add("anim")})}
window.__replayHome=replayHome;
(function experience(){
  const hoverFine=()=>matchMedia("(hover:hover) and (pointer:fine)").matches;
  const statEls=[...document.querySelectorAll(".hstats b[data-count]")];
  if(RM)statEls.forEach(el=>el.textContent=el.dataset.count);
  else statEls.forEach((el,i)=>setTimeout(()=>tweenNum(el,+el.dataset.count,v=>String(Math.round(v))),650+i*95));

  /* scroll progress + nav shadow, one rAF per frame */
  const sp=$("#sp"),nav=document.querySelector(".nav");let scRaf=0;
  function progress(){scRaf=0;const max=document.documentElement.scrollHeight-innerHeight;const p=max>0?Math.min(1,Math.max(0,scrollY/max)):0;if(sp)sp.style.transform="scaleX("+p.toFixed(4)+")";nav.classList.toggle("sc",scrollY>8)}
  addEventListener("scroll",()=>{if(!scRaf)scRaf=requestAnimationFrame(progress)},{passive:true});
  addEventListener("resize",progress,{passive:true});progress();

  /* pointer-follow glow on cards */
  if(hoverFine()&&!RM){
    let pm=null,pmRaf=0;
    document.addEventListener("pointermove",e=>{pm=e;if(pmRaf)return;pmRaf=requestAnimationFrame(()=>{pmRaf=0;const c=pm.target&&pm.target.closest?pm.target.closest(".card"):null;if(!c)return;const r=c.getBoundingClientRect();c.style.setProperty("--mx",(pm.clientX-r.left).toFixed(0)+"px");c.style.setProperty("--my",(pm.clientY-r.top).toFixed(0)+"px")})},{passive:true});
  }

  /* gentle 3-D tilt on the live hero demo */
  const demo=$(".nb-demo");
  if(demo&&hoverFine()&&!RM){
    demo.addEventListener("pointermove",e=>{if(e.target.closest("input,button,#hplot,#hK")){demo.style.setProperty("--ry","0deg");demo.style.setProperty("--rx","0deg");return}const r=demo.getBoundingClientRect();const px=(e.clientX-r.left)/Math.max(1,r.width)-.5,py=(e.clientY-r.top)/Math.max(1,r.height)-.5;demo.style.setProperty("--ry",(px*4.5).toFixed(2)+"deg");demo.style.setProperty("--rx",(-py*3.5).toFixed(2)+"deg")});
    demo.addEventListener("pointerleave",()=>{demo.style.setProperty("--ry","0deg");demo.style.setProperty("--rx","0deg")});
  }

  if(RM)return;

  /* flowing current field behind the hero */
  const cv=$("#fx");if(!cv)return;const ctx=cv.getContext("2d");if(!ctx)return;
  let W=0,H=0,DPR=1,t=0,last=0,raf=0,running=false,visible=true;
  const C={a:"#0891B2",b:"#059669"};let parts=[];
  const css=v=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  function refresh(){C.a=css("--acc")||C.a;C.b=css("--acc2")||C.b}
  function seed(){const n=Math.max(26,Math.min(96,Math.round(W*H/15000)));parts=[];for(let i=0;i<n;i++)parts.push({x:Math.random()*W,y:Math.random()*H,r:.7+Math.random()*1.7,s:7+Math.random()*20,amp:5+Math.random()*20,ph:Math.random()*6.28,a:.12+Math.random()*.32,c:Math.random()<.5?0:1})}
  function resize(){const r=cv.getBoundingClientRect();if(r.width<10||r.height<10)return;W=r.width;H=r.height;DPR=Math.min(2,window.devicePixelRatio||1);cv.width=Math.round(W*DPR);cv.height=Math.round(H*DPR);ctx.setTransform(DPR,0,0,DPR,0,0);seed()}
  const PT={x:-999,y:-999,tx:-999,ty:-999};let sy=0;
  addEventListener("pointermove",e=>{PT.tx=e.clientX;PT.ty=e.clientY},{passive:true});addEventListener("scroll",()=>{sy=scrollY},{passive:true});
  const wv=(x,c)=>{const b=H*(.12+c*.19);return b+Math.sin(sy*.0014+c)*26+Math.sin(x*.006+t*(.28+c*.06)+c*1.7)*(9+c*4)+Math.sin(x*.017-t*.35+c)*3-26*Math.exp(-Math.pow(x-PT.x,2)/30000-Math.pow(b-PT.y,2)/24000)};
  function frame(ts){if(!running)return;const dt=Math.min(50,ts-last||16);last=ts;t+=dt/1000;PT.x+=(PT.tx-PT.x)*.09;PT.y+=(PT.ty-PT.y)*.09;ctx.clearRect(0,0,W,H);
    for(let c=0;c<5;c++){const k=c%2?C.b:C.a;ctx.strokeStyle=k;ctx.fillStyle=k;ctx.lineWidth=1.2;ctx.globalAlpha=.09+c*.012;ctx.beginPath();for(let x=-20;x<=W+20;x+=14){const y=wv(x,c);x===-20?ctx.moveTo(x,y):ctx.lineTo(x,y)}ctx.stroke();
      const px=(t*(70+c*24)+c*330)%(W+300)-150;for(let j=0;j<18;j++){const x=px-j*6;ctx.globalAlpha=.6*Math.pow(1-j/18,2);ctx.beginPath();ctx.arc(x,wv(x,c),2.8-j*.1,0,6.283);ctx.fill()}ctx.globalAlpha=.12;ctx.beginPath();ctx.arc(px,wv(px,c),10,0,6.283);ctx.fill()}
    for(const p of parts){p.x+=p.s*dt/1000;if(p.x>W+30){p.x=-30;p.y=Math.random()*H}const y=p.y+Math.sin(p.x*.009+t*.85+p.ph)*p.amp,dx=p.x-PT.x,dy=y-PT.y,d2=dx*dx+dy*dy,n=d2<26000?1-d2/26000:0;ctx.globalAlpha=Math.min(.9,p.a+n*.5);ctx.fillStyle=p.c?C.b:C.a;ctx.beginPath();ctx.arc(p.x-dx*n*.15,y-dy*n*.15,p.r+n*1.6,0,6.283);ctx.fill()}
    ctx.globalAlpha=1;raf=requestAnimationFrame(frame)}
  function start(){if(running)return;running=true;last=performance.now();raf=requestAnimationFrame(frame)}
  function stop(){running=false;cancelAnimationFrame(raf)}
  refresh();resize();
  if(window.ResizeObserver)new ResizeObserver(()=>{resize();if(visible&&!document.hidden)start()}).observe(cv);else addEventListener("resize",resize);
  if("IntersectionObserver" in window)new IntersectionObserver(es=>{visible=es[0].isIntersecting;visible&&!document.hidden?start():stop()},{threshold:0}).observe(cv);
  document.addEventListener("visibilitychange",()=>{document.hidden||!visible?stop():start()});
  window.__obfFx=()=>{refresh();};
  start();
})();
/* ---------- hero live sweep ---------- */
(function(){const cv=$("#hov"),w=$("#hplot");if(!cv||RM)return;const x=cv.getContext("2d");let vis=true,col="#0891B2",oc="#fff",ct=-1e4;window.hSw=performance.now()+700;
if("IntersectionObserver"in window)new IntersectionObserver(es=>{vis=es[0].isIntersecting}).observe(cv);
const ez=k=>k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2;
function fr(ts){requestAnimationFrame(fr);const g=w._g,o=w._o;if(!vis||document.hidden||!g||!o)return;
const s=o.panels[0].series[0],n=s.x.length,D=Math.min(2,devicePixelRatio||1),W=w.clientWidth,H=w.clientHeight;
if(cv.width!==Math.round(W*D)||cv.height!==Math.round(H*D)){cv.width=Math.round(W*D);cv.height=Math.round(H*D)}
x.setTransform(D,0,0,D,0,0);x.clearRect(0,0,W,H);
if(ts-ct>800){const cs=getComputedStyle(document.documentElement);col=cs.getPropertyValue("--acc").trim()||col;oc=cs.getPropertyValue("--onacc").trim()||oc;ct=ts}
const e=ts-(window.hSw||0),u=e<0?0:(e%5200)/5200,p=u<.8?ez(u/.8):1,f=p*(n-1),i=Math.floor(f),j=Math.min(n-1,i+1),a=f-i,Y=g.panels[0].Y,
px=k=>g.X(s.x[k]),py=k=>Y(s.y[k]),hx=px(i)+(px(j)-px(i))*a,hy=py(i)+(py(j)-py(i))*a,bot=g.H-g.B,fd=u>.9?1-(u-.9)*10:1;
const gr=x.createLinearGradient(0,g.T0,0,bot);gr.addColorStop(0,col+"66");gr.addColorStop(1,col+"00");
x.globalAlpha=fd;x.fillStyle=gr;x.beginPath();x.moveTo(px(0),bot);for(let k=0;k<=i;k++)x.lineTo(px(k),py(k));x.lineTo(hx,hy);x.lineTo(hx,bot);x.closePath();x.fill();
x.lineCap="round";x.strokeStyle=col;const m=Math.max(3,Math.round(n*.2));
for(let q=0;q<14;q++){const k0=Math.max(0,i-m+Math.round(m*q/14)),k1=Math.max(0,i-m+Math.round(m*(q+1)/14));x.globalAlpha=fd*(q+1)/14;x.lineWidth=2+q*.4;x.beginPath();x.moveTo(px(k0),py(k0));for(let k=k0+1;k<=Math.min(k1,i);k++)x.lineTo(px(k),py(k));if(q===13)x.lineTo(hx,hy);x.stroke()}
x.globalAlpha=fd*.4;x.setLineDash([3,4]);x.lineWidth=1;x.beginPath();x.moveTo(hx,hy);x.lineTo(hx,bot);x.stroke();x.setLineDash([]);
const pu=(Math.sin(ts/170)+1)/2;x.fillStyle=col;x.globalAlpha=fd*(.3-.2*pu);x.beginPath();x.arc(hx,hy,9+8*pu,0,6.283);x.fill();
x.globalAlpha=fd;x.fillStyle="#fff";x.lineWidth=3;x.beginPath();x.arc(hx,hy,5,0,6.283);x.fill();x.stroke();
x.globalAlpha=1}
requestAnimationFrame(fr)})();
wireCellPicker();
loadPopular();          /* ready before the first picker is opened */
/* ---------- bridge between tools ----------
   The tools hold a different number of cells: Compare up to four, Simulate up
   to three, Calibrate and Validate one each. The bridge row at the bottom of a
   tool's cell card sends what that tool has selected to another tool, and asks
   which cells to keep when the source holds more than the destination takes. */
const BRIDGE={compare:{name:"Compare",max:COMPARE_MAX},sim:{name:"Simulate",max:SIM_MAX},calibrate:{name:"Calibrate",max:1},validate:{name:"Validate",max:1},library:{name:"Library",max:COMPARE_MAX}};
const BRIDGE_TOOL={compare:"compare",sim:"simulate",calibrate:"calibrate",validate:"validate"};
/* The cells a tool currently holds, in the order it shows them. */
function bridgeSource(from){
  if(from==="library")return LBSEL.slice();
  if(from==="compare")return (cmpBuilt?CS.ids:CMP).filter(Boolean);
  if(from==="sim")return SM.cells.filter(Boolean);
  if(from==="calibrate")return KCELL?[KCELL]:[];
  if(from==="validate"){let cal=false;try{cal=!!valModel().cal}catch(e){}return cal&&KF&&KF.id?[KF.id]:(VCELL?[VCELL]:[])}
  return [];
}
function bridgeMsg(to,text){const el=document.querySelector('[data-bridge="'+to+'"] .bgmsg');if(el)el.textContent=text||""}
function bridgeUpd(){
  document.querySelectorAll("[data-bridge]").forEach(bar=>{
    const from=bar.dataset.bridge,B=BRIDGE[from];if(!B)return;
    const n=bridgeSource(from).length,cnt=bar.querySelector(".bgc");
    if(cnt)cnt.textContent=n?n+" of "+B.max+(B.max===1?" cell":" cells"):(B.max===1?"No cell yet":"No cells yet");
    bar.querySelectorAll("[data-bridge-to]").forEach(b=>{b.disabled=!n});
  });
}
/* Write the chosen cells into the destination tool and go there. */
function bridgeApply(to,ids){
  const list=[];ids.forEach(id=>{if(CELLS[id]&&!list.includes(id)&&list.length<BRIDGE[to].max)list.push(id)});
  if(!list.length)return 0;
  list.forEach(id=>{try{OBFAccount.activity("use",BRIDGE_TOOL[to],id)}catch(e){}});
  if(to==="compare"){
    CMP=list.slice();CS.ids=[...CMP,"","","",""].slice(0,COMPARE_MAX);
    if(cmpBuilt){cmpSync();if(location.hash==="#/compare")cmpRun()}
    if(location.hash!=="#/compare")location.hash="#/compare";
  }else if(to==="sim"){
    SIM=list.slice();SM.cells=[list[0]||"",list[1]||"",list[2]||""];SM.vlo=[null,null,null];SM.vhi=[null,null,null];
    syncSel();
    if(simBuilt)simUI();
    const h="#/sim/"+list.join("/");
    if(location.hash!==h)location.hash=h;else if(simBuilt)simRender(true);
  }else if(to==="calibrate"){
    setKCell(list[0]);
    if(location.hash!=="#/calibrate")location.hash="#/calibrate";
  }else{
    setVCell(list[0]);
    if(location.hash!=="#/validate")location.hash="#/validate";else{valUI();valDirty()}
  }
  return list.length;
}
function bridgeSend(from,to){
  if(!BRIDGE[to]||to===from)return;
  const ids=bridgeSource(from);
  if(!ids.length){bridgeMsg(from,"Pick a cell first.");return}
  const max=BRIDGE[to].max;
  if(ids.length>max){bridgeOpen(from,to,ids,max);return}
  const n=bridgeApply(to,ids);
  bridgeMsg(from,"");bridgeMsg(to,"Bridged from "+BRIDGE[from].name+": "+n+(n===1?" cell":" cells")+".");bridgeUpd();
}
/* Chooser used when the source has more cells than the destination accepts. */
let BPICK=null;
function bridgeOpen(from,to,ids,max){
  BPICK={from:from,to:to,ids:ids.slice(),max:max,sel:ids.slice(0,max)};
  $("#bpto").textContent=BRIDGE[to].name;
  $("#bps").textContent=BRIDGE[from].name+" holds "+ids.length+" cells and "+BRIDGE[to].name+" takes "+max+". Choose the "+(max===1?"cell":"cells")+" to send.";
  $("#bridgepick").hidden=false;document.documentElement.classList.add("pick-open");
  bridgeRows();
  setTimeout(()=>{const b=$("#bpsend");if(b&&!b.disabled)b.focus()},40);
}
function bridgeRows(){
  if(!BPICK)return;const ids=BPICK.ids,sel=BPICK.sel,max=BPICK.max;
  $("#bpres").innerHTML=ids.map(id=>{const c=CELLS[id],on=sel.includes(id),full=!on&&sel.length>=max&&max>1;
    return `<button type="button" class="bp-row" data-bp="${id}" aria-pressed="${on}"${full?' aria-disabled="true"':""} style="--c:var(--c-${c.ch})"><i></i><b>${esc(c.n)}</b><small>${esc(c.s)} · ${c.Ah} Ah</small><span class="bp-tick">${on?"✓":""}</span></button>`}).join("");
  $("#bpcount").textContent=sel.length+" of "+max+" selected";
  $("#bpsend").disabled=!sel.length;
  $("#bpsend").textContent=sel.length===1?"Send 1 cell":"Send "+sel.length+" cells";
}
function bridgeClose(){BPICK=null;const d=$("#bridgepick");if(d)d.hidden=true;document.documentElement.classList.remove("pick-open")}
function bridgeFill(bar){
  const from=bar.dataset.bridge;if(!BRIDGE[from]||bar._b)return;bar._b=1;
  bar.innerHTML='<span class="bgk">Bridge to</span><span class="bgb">'+Object.keys(BRIDGE).filter(t=>t!==from&&t!=="library").map(t=>`<button type="button" data-bridge-to="${t}" title="Send the selected cells to ${BRIDGE[t].name} (up to ${BRIDGE[t].max})">→ ${BRIDGE[t].name}</button>`).join("")+'</span><small class="bgc"></small><small class="bgmsg" role="status" aria-live="polite"></small>';
}
function bridgeInit(){
  document.querySelectorAll("[data-bridge]").forEach(bridgeFill);
  const dlg=$("#bridgepick");
  if(dlg&&!dlg._w){dlg._w=1;
    $("#bpx").onclick=bridgeClose;$("#bpcancel").onclick=bridgeClose;$("#bpx2").onclick=bridgeClose;
    $("#bpsend").onclick=()=>{if(!BPICK||!BPICK.sel.length)return;const from=BPICK.from,to=BPICK.to,sel=BPICK.sel.slice();const n=bridgeApply(to,sel);bridgeClose();bridgeMsg(from,"");bridgeMsg(to,"Bridged from "+BRIDGE[from].name+": "+n+(n===1?" cell":" cells")+".");bridgeUpd()};
    $("#bpres").addEventListener("click",e=>{const row=e.target.closest("[data-bp]");if(!row||!BPICK)return;
      const i=BPICK.sel.indexOf(row.dataset.bp);
      if(i>=0)BPICK.sel.splice(i,1);
      else if(BPICK.sel.length<BPICK.max)BPICK.sel.push(row.dataset.bp);
      else if(BPICK.max===1)BPICK.sel=[row.dataset.bp]; /* one slot: the click replaces it */
      else{$("#bpcount").textContent="At most "+BPICK.max+": untick one first.";return}
      bridgeRows()});
    document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("#bridgepick").hidden)bridgeClose()});
  }
  bridgeUpd();
}
document.addEventListener("click",e=>{const b=e.target.closest("[data-bridge-to]");if(!b)return;const bar=b.closest("[data-bridge]");if(bar)bridgeSend(bar.dataset.bridge,b.dataset.bridgeTo)});

/* ---------- router ---------- */
const VW={library:"#libview",sim:"#simview",compare:"#compview",calibrate:"#calview",oss:"#ossview",docs:"#docsview",validate:"#valview",account:"#accview",admin:"#adminview",verify:"#verifyview",reset:"#resetview"},GATE=["sim","compare","calibrate","validate","docs","account","admin"];
function seoMeta(c){const t=document.querySelector("title"),d=document.querySelector('meta[name="description"]'),ld=document.getElementById("ld-json");
if(c){const name=c.n+" · openBatteryFlux",desc=`${c.brand} ${c.model} ${c.form} battery cell, ${c.Ah} Ah, ${c.s} chemistry.`;
if(t)t.textContent=name;if(d)d.setAttribute("content",desc);
if(ld)ld.textContent=JSON.stringify({"@context":"https://schema.org","@type":"Product",name,brand:{"@type":"Brand",name:c.brand},description:desc,category:"Battery cell",additionalProperty:[{"@type":"PropertyValue",name:"Capacity",value:c.Ah,unitCode:"AMH"}]});
}else{if(t)t.textContent="openBatteryFlux";if(d)d.setAttribute("content","Simulate any cell from its datasheet. Free, open source and customizable.");if(ld)ld.textContent=""}}
async function route(){document.querySelector(".nav").classList.remove("open");$("#mnu").setAttribute("aria-expanded","false");let h=(location.hash||"#/").split("/"),v=h[1]||"";
const user=await getUser();heroAuth();seoMeta(null);/* The tool name has to be read before v is reset, otherwise the gate row is
sent with no tool and the server drops it. */if(GATE.includes(v)&&!user){const gateTool={sim:"simulate",compare:"compare",calibrate:"calibrate",validate:"validate"}[v];OBFAccount.remember(location.hash);history.replaceState(null,"","#/");h=["#",""];v="";setTimeout(()=>openAuth("signup"),60);if(gateTool)OBFAccount.activity("gate",gateTool);}
const wasHome=!$("#home").hidden;Object.values(VW).forEach(s=>$(s).hidden=true);const tg=VW[v];
if(tg){$(tg).hidden=false;$(tg).classList.remove("view-enter");void $(tg).offsetWidth;$(tg).classList.add("view-enter")}
$("#home").hidden=!!tg;if(!tg&&!wasHome&&window.__replayHome)window.__replayHome();
document.querySelectorAll(".links a").forEach(a=>a.removeAttribute("aria-current"));const na=document.querySelector(`.links a[href="#/${v}"]`);if(na)na.setAttribute("aria-current","page");
if(tg&&["sim","compare","calibrate","validate"].includes(v)&&!OBFAccount.mayUseTools()){OBFAccount.showVerifyWall(tg);rpAll();trayUpd();window.scrollTo(0,0);return}
OBFAccount.hideVerifyWall();
if(v==="sim"){const a=h[2]||"";if(/^p\d$/.test(a)&&SP[+a[1]])applyPre(+a[1]);else if(CELLS[a]){SM.cells=[a,CELLS[h[3]]?h[3]:"",CELLS[h[4]]?h[4]:""];SM.vlo=[null,null,null];SM.vhi=[null,null,null];seoMeta(CELLS[a])}else if(!/^p\d$/.test(a)){SM.cells=["","",""];SM.vlo=[null,null,null];SM.vhi=[null,null,null]};simInit();simUI();simRender(true);window.scrollTo(0,0)}
else if(v==="library"){libRender();window.scrollTo(0,0)}
else if(v==="compare"){if(!cmpBuilt)cmpBuild();CS.ids=(CMP.length?[...CMP,"","","",""].slice(0,COMPARE_MAX):["","","",""]);cmpSync();cmpRun();window.scrollTo(0,0)}
else if(v==="calibrate"){calInit();window.scrollTo(0,0)}else if(v==="oss"){window.scrollTo(0,0)}else if(v==="validate"){valInit();valUI();valDirty();window.scrollTo(0,0)}else if(v==="docs"){docsInit();const t=h[2]&&document.getElementById("d-"+h[2]);setTimeout(()=>t?t.scrollIntoView():window.scrollTo(0,0),60)}
else if(v==="verify"){OBFAccount.renderVerify(h[2]||"");window.scrollTo(0,0)}else if(v==="reset"){OBFAccount.renderReset(h[2]||"");window.scrollTo(0,0)}else if(v==="account"){OBFAccount.renderAccount();window.scrollTo(0,0)}else if(v==="admin"){OBFAccount.renderAdmin();window.scrollTo(0,0)}
else{const el=h[1]&&document.getElementById(h[1]);el?el.scrollIntoView({behavior:"smooth"}):window.scrollTo(0,0)}
{const trk={sim:"simulate",compare:"compare",calibrate:"calibrate",validate:"validate",library:"library"};if(trk[v])OBFAccount.track(trk[v])}
rpAll();trayUpd()}
/* documentation links open in their own tab, and reuse that tab when it is already open */
const DOCTAB="obf-docs";
document.addEventListener("click",e=>{const a=e.target.closest('a[href^="#/docs"]');if(!a||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
if(!$("#docsview").hidden)return; /* already reading the docs: navigate in place */
e.preventDefault();let w=null;try{w=window.open(new URL(a.getAttribute("href"),location.href).href,DOCTAB)}catch(_){}
if(!w){location.hash=a.getAttribute("href");return} /* popup blocked: fall back to this tab */
try{w.focus()}catch(_){}});
/* fire one visit per browser tab session */
OBFAccount.visit();
renderAuth();
const authBox=document.getElementById("authbox");if(authBox)authBox.innerHTML=OBFAccount.renderAuthBox();
if("IntersectionObserver" in window){const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target)}}),{threshold:.12,rootMargin:"0px 0px -40px"});document.querySelectorAll(".rv").forEach(e=>io.observe(e))}else document.querySelectorAll(".rv").forEach(e=>e.classList.add("in"));
/* ---------- documentation page ---------- */
const bvR=(I,R0c,T)=>{const x=96485*Math.abs(I)*R0c/(2*8.314*(T+273.15));return x<1e-6?1:Math.asinh(x)/x};
function docPK(c,m,rct,C,T){const RS0=rcSet(c,m),I0=C*c.Ah,k=Math.exp(c.B*(1/(T+273.15)-1/298.15)),o={t:[],v:[],I:[],vk:[[],[],[]],ir:[[],[],[]]};let soc=.8,vk=[0,0,0];
for(let n=0;n<=420;n++){const Ii=n<120?I0:0,R0=c.r0*k*socF(soc),RS=RS0.map((a,j)=>[a[0]*k*(rct&&j===0?bvg(Ii,a[0]*k,T):1),a[1]]);o.t.push(n);o.I.push(Ii);o.v.push(ocv(c,soc)-Ii*R0-vk[0]-vk[1]-vk[2]);RS.forEach((a,j)=>{o.vk[j].push(vk[j]);o.ir[j].push(vk[j]/a[0])});soc-=Ii/(c.Ah*3600);RS.forEach((a,j)=>vk[j]+=(Ii*a[0]-vk[j])*(1-Math.exp(-1/a[1])))}return o}
const docPulse=(c,m,r,C)=>docPK(c,m,r,C,25);
function docStair(c,m,rct,T,peak){const RS0=rcSet(c,m),amps=[.1,.25,.5,.75,1].map(x=>x*peak),k=Math.exp(c.B*(1/(T+273.15)-1/298.15)),t=[],v=[],R=[];let soc=.8,vk=[0,0,0],n=0;
amps.forEach(a=>{const I0=a*c.Ah,ov=ocv(c,soc);for(let s=0;s<120;s++,n++){const Ii=s<30?I0:0,R0=c.r0*k*socF(soc),RS=RS0.map((b,j)=>[b[0]*k*(rct&&j===0?bvg(Ii,b[0]*k,T):1),b[1]]);t.push(n);v.push(ocv(c,soc)-Ii*R0-vk[0]-vk[1]-vk[2]);if(s===29)R.push((ov-v[v.length-1])/I0*1e3);soc-=Ii/(c.Ah*3600);RS.forEach((b,j)=>vk[j]+=(Ii*b[0]-vk[j])*(1-Math.exp(-1/b[1])))}});return{t,v,R,amps}}
function docVal(seed){const c=CELLS[DEF],tr={r0:c.r0*1.4,rc:[[c.r1*.54,c.tau*.28],[c.r1*.72,c.tau*2.7]],Q:c.Ah,B:c.B,ecm:"2RC"};let sd=seed;const rnd=()=>(sd=(sd*16807)%2147483647)/2147483647;
const mkp=(lv,per)=>{const t=[],I=[];for(let k=0;k<900;k++){t.push(k*2);I.push(lv[Math.floor(k/per)%lv.length]*c.Ah)}return{t,i:I,T:null,soc0:.9}},A=mkp([0,1,2,0,1.5,0,2.5,0],30),B=mkp([0,3,0,.5,2,0,1,0,4,0],25);[A,B].forEach(d=>d.v=predict(c,tr,d).map(x=>x+(rnd()-.5)*.008));
return["R","1RC","2RC","3RC"].map(m=>{const n=RCS[m].length,rc0=rcSet(c,m),e=a=>Math.exp(clp(a,-1.6,1.6)),mk=x=>({r0:c.r0*e(x[0]),rc:rc0.map((b,j)=>[b[0]*e(x[1+2*j]),b[1]*e(x[2+2*j])]),Q:c.Ah,B:c.B,ecm:m}),cost=x=>met(predict(c,mk(x),A),A.v).rmse,z=Array(1+2*n).fill(0);let r=nm(cost,z,z.map(()=>.35),200);r=nm(cost,r.x,z.map(()=>.1),200);const p=mk(r.x);return{m,tr:met(predict(c,p,A),A.v).rmse*1e3,va:met(predict(c,p,B),B.v).rmse*1e3}})}
const DOCIT=[0,1,2,4,6,8,12,16,22,30,45,70,110,200,350];
function docFit(){const c=CELLS[DEF],tr={r0:c.r0*1.4,rc:[[c.r1*1.25,c.tau*1.5]],Q:c.Ah*.95,B:c.B,ecm:"1RC"},t=[],I=[],lv=[0,1,2,0,1.5,0,2.5,0];let sd=5;const rnd=()=>(sd=(sd*16807)%2147483647)/2147483647;for(let k=0;k<900;k++){t.push(k*2);I.push(lv[Math.floor(k/30)%8]*c.Ah)}
const d={t,i:I,T:null,soc0:.9};d.v=predict(c,tr,d).map(x=>x+(rnd()-.5)*.004);const e=a=>Math.exp(clp(a,-1.6,1.6)),mk=x=>({r0:c.r0*e(x[0]),rc:[[c.r1*e(x[1]),c.tau*e(x[2])]],Q:c.Ah*e(x[3]),B:c.B,ecm:"1RC"}),cost=x=>met(predict(c,mk(x),d),d.v).rmse;
return{d,tr,c,snaps:DOCIT.map(it=>{const x=it?nm(cost,[0,0,0,0],[.35,.35,.35,.35],it).x:[0,0,0,0];return{x:x.map(e),v:predict(c,mk(x),d),r:cost(x)}})}}
let docsB=false;
function docsInit(){if(docsB)return;docsB=true;const C0=CELLS[DEF],o=(i,f)=>{$("#"+i+"o").textContent=f($("#"+i).value)},bind=(ids,fn)=>ids.forEach(i=>{rp($("#"+i));$("#"+i).addEventListener("input",()=>{rp($("#"+i));fn()})});
const play=(id,sl,fn)=>{const b=$("#"+id);let on=false;b.onclick=()=>{on=!on;b.textContent=on?"❚❚ Pause":"▶ Play";if(!on)return;const el=$("#"+sl),a=+el.min,z=+el.max,t0=performance.now()-(+el.value-a)/(z-a)*5000;const st=ts=>{if(!on||$("#docsview").hidden){on=false;b.textContent="▶ Play";return}const u=((ts-t0)/5000)%2,p=u<1?u:2-u;el.value=a+(z-a)*p;rp(el);fn();requestAnimationFrame(st)};requestAnimationFrame(st)}};
const dot=(el,x,y)=>{const g=el._g,sv=el.querySelector("svg");if(g&&sv)sv.insertAdjacentHTML("beforeend",`<circle cx="${g.X(x)}" cy="${g.panels[0].Y(y)}" r="6" fill="#fff" stroke="var(--acc)" stroke-width="3"/>`)};
$("#dch").innerHTML="<thead><tr><th>Chemistry</th><th>V nom (V)</th><th>Window (V)</th><th>r_k (Ω·Ah)</th><th>r₁ᵣ</th><th>τ (s)</th><th>B (K)</th><th>T range (°C)</th></tr></thead><tbody>"+Object.keys(CH).map(k=>{const h=CH[k];return`<tr><td>${CHN[k]}</td><td>${h.V}</td><td>${h.Vmin} to ${h.Vmax}</td><td>${h.rk}</td><td>${h.r1r}</td><td>${h.tau}</td><td>${h.B}</td><td>${h.dsT[0]} to ${h.dsT[1]}</td></tr>`}).join("")+"</tbody>";
const pu=["Sustained high-power drive on two energy cells at 95 % SOH: heating and the voltage sag at the end of discharge.","Commute at −10 °C and 90 % SOH, NMC against LFP: how resistance and confidence change outside the datasheet temperature range.","Short 4 C pulses on power cells: RC relaxation between pulses, and what happens above the datasheet C-rate.","2 C charge from 10 % SOC at 15 °C, LFP against LTO: the voltage limit and the charge resistance.","5 W constant power on three chemistries: the current rises as the voltage falls.","Staircase of rising C-rate with rests: rate capability of an energy cell against a power cell."];
$("#dsp").innerHTML="<thead><tr><th>Demo scenario</th><th>Load</th><th>Conditions</th><th>What it shows</th></tr></thead><tbody>"+SP.map((p,i)=>{const q=p[1];return`<tr><td><b>${p[0]}</b></td><td>${SCN[q.sc]||q.sc}, ${q.dir>0?"discharge":"charge"}, ${q.mean}${q.peak!==q.mean?" to "+q.peak:""} ${q.unit==="C"?"C":q.unit}</td><td>${q.T} °C, SOH ${q.soh} %, SOC₀ ${q.soc0} %</td><td>${pu[i]}</td></tr>`}).join("")+"</tbody>";
/* F1 */const f1=()=>{const C=+$("#f1C").value,T=+$("#f1T").value,h=+$("#f1H").value;o("f1C",v=>(+v).toFixed(1)+" C");o("f1T",v=>v+" °C");o("f1H",v=>v+" %");const q=sim(C0,{mode:"discharge",C,T,soh:h,soc0:100}),bw=q.cf.map(x=>(1-x)*.25),mn=Math.min(...q.cf);
plot($("#f1p"),{series:[{name:"Voltage",x:q.q,y:q.v,col:"var(--acc-d)",w:3.5,fmt:v=>v.toFixed(3)+" V",ext:q.cf.map(x=>x<.9?1:0),band:[q.v.map((v,i)=>v-bw[i]),q.v.map((v,i)=>v+bw[i])]}],xl:"Capacity (Ah)",yl:"Voltage (V)",H:260,nolegend:true,fx:v=>v.toFixed(2)+" Ah",ymin:2.4,ymax:4.4,al:"Discharge curve with confidence band"});
$("#f1r").innerHTML=`Minimum confidence <b>${(mn*100).toFixed(0)} %</b> · ${mn<.9?"extrapolating beyond the datasheet":"inside the datasheet"} · datasheet range ${f1c(C0.dsC[0])} to ${f1c(C0.dsC[1])} C, ${C0.dsT[0]} to ${C0.dsT[1]} °C`};bind(["f1C","f1T","f1H"],f1);play("f1P","f1C",f1);f1();
/* F2: animated equivalent circuit */let m2="2RC",F2D=null;
const zz=(x,y,L)=>{const u=(L-16)/6,p=[[x,y],[x+8,y]];for(let i=0;i<6;i++)p.push([x+8+u*(i+.5),y+(i%2?9:-9)]);p.push([x+L-8,y],[x+L,y]);return p.map((q,i)=>(i?"L":"M")+q[0].toFixed(1)+" "+q[1].toFixed(1)).join("")};
function ecmDraw(n,ct){const ink=c=>`stroke="${c||"var(--ink)"}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"`,fl=(id,d,c)=>`<path id="${id}" class="fl${id[1]==="s"?" fs":""}" d="${d}" fill="none" stroke="${c||"var(--warn)"}" stroke-width="5.5" stroke-linecap="round" stroke-dasharray="0.1 14" opacity="0"/>`,tx=(x,y,t,c,id)=>`<text${id?` id="${id}"`:""} class="ft ${c||"i"}" x="${x}" y="${y}" text-anchor="middle" style="font-size:12px">${t}</text>`;
let w=`<path ${ink()} d="M46 64V96M46 124V170H600"/><path ${ink()} d="M30 96H62M38 103H54M30 117H62M38 124H54"/>`+tx(46,88,"+","a")+tx(22,114,"OCV","a")+`<path ${ink()} d="M46 64H92${zz(92,64,70).replace("M","L")}H${n?190:600}"/>`+tx(127,46,"R₀"),f=fl("fs0",`M46 64H92${zz(92,64,70).replace("M","L")}H${n?190:600}`)+fl("frt","M600 170H46V124");
for(let j=0;j<n;j++){const bx=190+j*130,ex=bx+110,nx=j<n-1?bx+130:600,cc=ct&&j===0,lab=cc?"R<tspan font-size='9' dy='3'>ct</tspan>":"R"+"₁₂₃"[j];
w+=`<path ${ink()} d="M${bx} 64V36H${bx+8}"/><path ${ink(cc?"var(--warn)":"")} d="${zz(bx+8,36,94)}"/><path ${ink()} d="M${bx+102} 36H${ex}V64H${nx}M${bx} 64V92H${bx+49}M${bx+61} 92H${ex}V64"/><path ${ink()} d="M${bx+49} 80V104M${bx+61} 80V104"/><rect id="fc${j}" x="${bx+50.5}" y="81" width="9" height="22" fill="var(--acc)" opacity="0"/>`+tx(bx+55,20,lab,cc?"w":"i").replace("<text","<text")+tx(bx+55,126,"C"+"₁₂₃"[j])+tx(bx+55,146,"V"+"₁₂₃"[j]+" = 0 mV","a","fv"+j);
f+=fl("fu"+j,`M${bx} 64V36H${bx+8}${zz(bx+8,36,94).replace("M","L")}H${ex}V64`,cc?"var(--warn)":"var(--acc)")+fl("fl"+j,`M${bx} 64V92H${ex}V64`,"var(--acc)");if(j<n-1)f+=fl("fs"+(j+1),`M${ex} 64H${nx}`)}
if(n)f+=fl("fs"+n,`M${190+(n-1)*130+110} 64H600`);
w+=`<circle cx="600" cy="64" r="5" fill="var(--panel)" stroke="var(--ink)" stroke-width="2"/><circle cx="600" cy="170" r="5" fill="var(--panel)" stroke="var(--ink)" stroke-width="2"/><path d="M628 76V158" stroke="var(--mut)" stroke-width="1.5" marker-start="url(#ar)" marker-end="url(#ar)"/>`+`<text class="ft a" x="640" y="118" style="font-size:12px">V</text><text id="fvt" class="ft a" x="640" y="136" style="font-size:12px"></text>`+tx(46,20,"","a","fi");
return `<svg viewBox="0 0 735 190" role="img" aria-label="Equivalent circuit with animated current: OCV source, R0 and ${n} RC pair${n===1?"":"s"}"><defs><marker id="ar" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto-start-reverse"><path d="M0 0L6 3L0 6z" fill="var(--mut)"/></marker></defs>${w}${f}</svg>`}
const f2=()=>{const C=+$("#f2C").value,T=+$("#f2T").value,ct=$("#f2c").checked&&m2!=="R";o("f2C",v=>(+v).toFixed(1)+" C");o("f2T",v=>v+" °C");document.querySelectorAll("#f2m button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.m===m2));
F2D=docPK(C0,m2,ct,C,T);F2D.n=RCS[m2].length;F2D.mx=F2D.vk.map(a=>Math.max(1e-6,...a));$("#f2s").innerHTML=ecmDraw(F2D.n,ct);
const col={R:"var(--mut)","1RC":"var(--s1)","2RC":"var(--s2)","3RC":"var(--s3)"};plot($("#f2p"),{series:["R","1RC","2RC","3RC"].map(m=>{const r=docPK(C0,m,ct&&m!=="R",C,T);return{name:m==="R"?"Resistance only":m,x:r.t,y:r.v,col:col[m],w:m===m2?3.6:1.4,fmt:v=>v.toFixed(3)+" V"}}),xl:"Time (s)",yl:"Voltage (V)",H:230,fx:v=>v.toFixed(0)+" s",al:"Pulse response by model"});
const g=$("#f2p")._g;if(g)$("#f2p").querySelector("svg").insertAdjacentHTML("beforeend",`<line id="f2cur" x1="0" x2="0" y1="${g.T0}" y2="${g.H-g.B}" stroke="var(--warn)" stroke-width="2" stroke-dasharray="4 4"/>`)};
{let ph={},last=0,vis=true;const frame=n=>{const D=F2D,N=D.t.length-1,I=D.I[n],Im=Math.max(1e-9,D.I[0]),dt=Math.min(.05,last||.016);
const mv=(id,i)=>{const e=document.getElementById(id);if(!e)return;const a=Math.abs(i)/Im;ph[id]=(ph[id]||0)+Math.sign(i)*(a<2e-3?0:Math.min(1,Math.sqrt(a)))*120*dt;e.setAttribute("stroke-dashoffset",(-ph[id]).toFixed(1));e.setAttribute("opacity",Math.min(1,a*10).toFixed(2))};
document.querySelectorAll("#f2s .fs").forEach(e=>mv(e.id,I));mv("frt",I);for(let j=0;j<D.n;j++){mv("fu"+j,D.ir[j][n]);mv("fl"+j,I-D.ir[j][n]);const fc=document.getElementById("fc"+j),fv=document.getElementById("fv"+j);if(fc)fc.setAttribute("opacity",Math.min(1,Math.abs(D.vk[j][n])/D.mx[j]*.85).toFixed(2));if(fv)fv.textContent="V"+"₁₂₃"[j]+" = "+(D.vk[j][n]*1e3).toFixed(0)+" mV"}
const fi=document.getElementById("fi"),ft=document.getElementById("fvt");if(fi)fi.textContent=I>0?"I = "+I.toFixed(1)+" A  (pulse)":"I = 0  (rest)";if(ft)ft.textContent=D.v[n].toFixed(3)+" V";const L=$("#f2cur"),g=$("#f2p")._g;if(L&&g){const x=g.X(D.t[n]);L.setAttribute("x1",x);L.setAttribute("x2",x)}};
if("IntersectionObserver"in window)new IntersectionObserver(es=>{vis=es[0].isIntersecting}).observe($("#f2s"));
const tick=ts=>{requestAnimationFrame(tick);if(!F2D||!vis||document.hidden||$("#docsview").hidden)return;last=(ts-(tick.t||ts))/1000;tick.t=ts;frame(Math.min(F2D.t.length-1,Math.floor(((ts/1000/12)%1)*(F2D.t.length-1))))};
$("#f2m").onclick=e=>{if(e.target.dataset.m){m2=e.target.dataset.m;f2()}};$("#f2c").onchange=f2;bind(["f2C","f2T"],f2);f2();if(RM)frame(100);else requestAnimationFrame(tick)}
/* F0: OCV */const f0=a=>plot($("#f0p"),{series:Object.keys(CH).map((k,i)=>({name:CHN[k],x:[...Array(101).keys()],y:CH[k].ocv,col:`var(--c-${k})`,w:3,fmt:v=>v.toFixed(3)+" V"})),xl:"State of charge (%)",yl:"OCV (V)",H:470,fx:v=>v.toFixed(0)+" % SOC",anim:a,al:"OCV curves"});$("#f0P").onclick=()=>f0(true);f0(false);
/* F8: pulse train */const f8=()=>{const T=+$("#f8T").value,pk=+$("#f8C").value;o("f8C",v=>(+v).toFixed(1)+" C");o("f8T",v=>v+" °C");const a=docStair(C0,"3RC",false,T,pk),b=docStair(C0,"3RC",true,T,pk);
plot($("#f8p"),{series:[{name:"Linear R_ct",x:a.t,y:a.v,col:"var(--mut)",w:2.2,fmt:v=>v.toFixed(3)+" V"},{name:"Butler–Volmer R_ct",x:b.t,y:b.v,col:"var(--acc-d)",w:3,fmt:v=>v.toFixed(3)+" V"}],xl:"Time (s)",yl:"Voltage (V)",H:230,fx:v=>v.toFixed(0)+" s",al:"Pulse train with and without Butler–Volmer"});
plot($("#f8r"),{series:[{name:"Linear R_ct",x:a.amps,y:a.R,col:"var(--mut)",w:2.4,fmt:v=>v.toFixed(2)+" mΩ"},{name:"Butler–Volmer R_ct",x:b.amps,y:b.R,col:"var(--acc-d)",w:3,fmt:v=>v.toFixed(2)+" mΩ"}],xl:"Pulse amplitude (C)",yl:"Apparent resistance (mΩ)",H:200,fx:v=>v.toFixed(1)+" C",al:"Apparent pulse resistance against amplitude"});
$("#f8o").innerHTML=`At ${pk.toFixed(1)} C the apparent resistance is ${a.R[4].toFixed(1)} mΩ with a linear R<sub>ct</sub> and <b>${b.R[4].toFixed(1)} mΩ</b> with Butler–Volmer (${(100*(1-b.R[4]/a.R[4])).toFixed(0)} % lower).`};bind(["f8C","f8T"],f8);play("f8P","f8C",f8);f8();
/* F9: why validate */let f9s=7;const f9=()=>{const r=docVal(f9s);plot($("#f9p"),{series:[{name:"Training error",x:[0,1,2,3],y:r.map(z=>z.tr),col:"var(--acc-d)",w:3,fmt:v=>v.toFixed(1)+" mV"},{name:"Validation error",x:[0,1,2,3],y:r.map(z=>z.va),col:"var(--warn)",w:3,fmt:v=>v.toFixed(1)+" mV"}],xl:"RC branches (0 = resistance only)",yl:"RMSE (mV)",H:220,fx:v=>v.toFixed(0)+" RC",al:"Training and validation error by model"});$("#f9r").innerHTML=r.map(z=>`${z.m==="R"?"R only":z.m}: <b>${z.tr.toFixed(1)}</b> → <b>${z.va.toFixed(1)}</b> mV`).join(" · ")+" (training → validation)"};$("#f9P").onclick=()=>{f9s=f9s*7+3;f9()};setTimeout(f9,60);
/* F3 */const f3=()=>{const T=+$("#f3T").value,h=+$("#f3H").value;o("f3T",v=>v+" °C");o("f3H",v=>v+" %");const S=[...Array(101).keys()],r=(T,h)=>S.map(s=>C0.r0*Math.exp(C0.B*(1/(T+273.15)-1/298.15))/h*socF(s/100)*1e3);plot($("#f3p"),{series:[{name:"25 °C, new",x:S,y:r(25,1),col:"var(--mut)",w:2,fmt:v=>v.toFixed(1)+" mΩ"},{name:"Selected",x:S,y:r(T,h/100),col:"var(--acc-d)",w:3.5,fmt:v=>v.toFixed(1)+" mΩ"}],xl:"State of charge (%)",yl:"R₀ (mΩ)",H:240,fx:v=>v.toFixed(0)+" % SOC",al:"R0 against SOC"})};bind(["f3T","f3H"],f3);f3();
/* F4 */const f4=()=>{const R0c=+$("#f4R").value/1e3,T=+$("#f4T").value,M=+$("#f4M").value,In=Math.min(+$("#f4I").value,M);$("#f4I").max=M;rp($("#f4I"));o("f4R",v=>v+" mΩ");o("f4T",v=>v+" °C");o("f4M",v=>v+" A");o("f4I",v=>Math.min(+v,M).toFixed(1)+" A");const Tk=T+273.15,I0=8.314*Tk/(96485*R0c),I=[...Array(81).keys()].map(i=>i/80*M),eta=i=>2*8.314*Tk/96485*Math.asinh(i/(2*I0))*1e3;
plot($("#f4a"),{series:[{name:"R_ct / R_ct,0",x:I,y:I.map(i=>bvR(i,R0c,T)*100),col:"var(--acc-d)",w:3.5,fmt:v=>v.toFixed(0)+" %"}],xl:"Current (A)",yl:"R_ct / R_ct,0 (%)",H:200,nolegend:true,ymin:0,ymax:105,fx:v=>v.toFixed(1)+" A",al:"Charge-transfer resistance against current"});dot($("#f4a"),In,bvR(In,R0c,T)*100);
plot($("#f4b"),{series:[{name:"Butler–Volmer",x:I,y:I.map(eta),col:"var(--acc-d)",w:3.5,fmt:v=>v.toFixed(1)+" mV"},{name:"Linear resistor",x:I,y:I.map(i=>R0c*i*1e3),col:"var(--mut)",w:2,fmt:v=>v.toFixed(1)+" mV"}],xl:"Current (A)",yl:"Overpotential (mV)",H:200,fx:v=>v.toFixed(1)+" A",al:"Overpotential against current"});dot($("#f4b"),In,eta(In));
$("#f4r").innerHTML=`I₀ = ${I0.toFixed(1)} A · at ${In.toFixed(1)} A: R<sub>ct</sub> = <b>${(R0c*bvR(In,R0c,T)*1e3).toFixed(2)} mΩ</b> (${(bvR(In,R0c,T)*100).toFixed(0)} % of R<sub>ct,0</sub>), η = ${eta(In).toFixed(1)} mV against ${(R0c*In*1e3).toFixed(1)} mV for a linear resistor`};bind(["f4R","f4T","f4M","f4I"],f4);play("f4P","f4I",f4);f4();
/* F6 */const f6=a=>{plot($("#f6p"),{series:[1,2,4].map((C,i)=>{const q=sim(C0,{mode:"discharge",C,T:25,soh:100,soc0:100});return{name:C+" C",x:q.t.map(x=>x/60),y:q.T,col:["var(--s1)","var(--s2)","var(--s3)"][i],w:3,fmt:v=>v.toFixed(1)+" °C"}}),xl:"Time (min)",yl:"Cell temperature (°C)",H:230,fx:v=>v.toFixed(1)+" min",anim:a,al:"Self-heating"})};$("#f6P").onclick=()=>f6(true);$("#f6P").textContent="↻ Replay";f6(false);
/* F7 (computed on first view, a few hundred ms) */let F7=null;const f7=()=>{if(!F7)F7=docFit();const k=+$("#f7i").value,S=F7.snaps[k],{d,tr}=F7;o("f7i",v=>"step "+DOCIT[+v]);const tm=d.t.map(x=>x/60);
plot($("#f7p"),{series:[{name:"Measured",x:tm,y:d.v,col:"var(--mut)",w:1.6,fmt:v=>v.toFixed(3)+" V"},{name:"Model",x:tm,y:S.v,col:"var(--acc-d)",w:3,fmt:v=>v.toFixed(3)+" V"}],xl:"Time (min)",yl:"Voltage (V)",H:230,fx:v=>v.toFixed(1)+" min",al:"Measured and fitted voltage"});
plot($("#f7c"),{series:[{name:"RMSE",x:DOCIT,y:F7.snaps.map(z=>z.r*1e3),col:"var(--warn)",w:3,fmt:v=>v.toFixed(1)+" mV"}],xl:"Optimiser iterations",yl:"RMSE (mV)",H:170,nolegend:true,fx:v=>v.toFixed(0),al:"Fit error against iterations"});dot($("#f7c"),DOCIT[k],S.r*1e3);
$("#f7r").innerHTML=`RMSE <b>${(S.r*1e3).toFixed(1)} mV</b> · R₀ ×${S.x[0].toFixed(2)} (truth ×1.40) · R₁ ×${S.x[1].toFixed(2)} (×1.25) · τ ×${S.x[2].toFixed(2)} (×1.50) · Q ×${S.x[3].toFixed(2)} (×0.95)`};bind(["f7i"],f7);play("f7P","f7i",()=>{const e=$("#f7i");e.value=Math.round(e.value);rp(e);f7()});setTimeout(f7,30);rpAll();
if("IntersectionObserver"in window){const L=[...document.querySelectorAll("#dtoc a")],io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting)L.forEach(a=>a.toggleAttribute("aria-current",a.getAttribute("href")==="#/docs/"+e.target.id.slice(2)))}),{rootMargin:"-30% 0px -60% 0px"});document.querySelectorAll(".dsec").forEach(x=>io.observe(x))}}
/* ---------- validate page ---------- */
let VPR=[],VKi=0,vOn=false,vdn=0,vKF=null,VRAN=false,VLAST=null;

const vst=e=>{const n=e.length,a=e.map(Math.abs).sort((x,y)=>x-y);let s=0,q=0;for(const x of e){s+=x;q+=x*x}return{n,bias:s/n,rmse:Math.sqrt(q/n),mae:a.reduce((x,y)=>x+y,0)/n,max:a[n-1],p95:a[Math.floor(.95*(n-1))]}};
const vbin=(x,e,ed)=>{const o=[];for(let b=0;b<ed.length-1;b++){let q=0,n=0;for(let k=0;k<x.length;k++)if(x[k]>=ed[b]&&x[k]<ed[b+1]){q+=e[k]*e[k];n++}if(n>=5)o.push([(ed[b]+ed[b+1])/2,Math.sqrt(q/n)])}return o};
function valPlace(){$("#vres").innerHTML='<div class="card pnl" style="color:var(--mut)">Add up to three validation profiles, then press “Run validation”. Results appear here: voltage and temperature errors, error by SOC and by C-rate, a verdict, and the BMS-ready export.</div>'}
function valDirty(){$("#vrun").disabled=!VPR.length;if(!VPR.length){VRAN=false;$("#vstale").hidden=true;valPlace()}else if(VRAN)$("#vstale").hidden=false}
function valExportF(){const M=valModel();if(M.cal)return Object.assign({},KF,{val:VLAST});const c=M.c,id=VCELL;return{id,ecm:M.ecm,rct:M.rct,c,p1:M.p,ds:[],m1:null,Tr:c.dsT,Ir:[-c.dsC[1]*c.Ah,c.dsC[1]*c.Ah],val:VLAST}}
function exportCard(pf){return `<div class="card pnl"><h2>BMS-ready export</h2><p class="note" style="font-size:13px;color:var(--mut);margin:0 0 8px">Export the model you just validated. The JSON includes the validation errors. <a class="docl" href="#/docs/export">Formats</a></p><div class="seg" id="${pf}ex"><button type="button" data-ex="json" aria-pressed="true">JSON</button><button type="button" data-ex="c">C header</button><button type="button" data-ex="py">Python</button><button type="button" data-ex="lut">R–T–SOC table (CSV)</button></div><textarea class="ex" id="${pf}xt" readonly aria-label="Export"></textarea><div class="seg"><button type="button" class="bp" id="${pf}cp">Copy to clipboard</button><button type="button" id="${pf}dl">Download file</button></div><span id="${pf}cm" style="font-size:13px"></span></div>`}
function exportWire(pf,get){let K="json";const show=k=>{K=k;$("#"+pf+"xt").value=exportText(k,get());document.querySelectorAll("#"+pf+"ex button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.ex===k))};show("json");$("#"+pf+"ex").onclick=e=>{if(e.target.dataset.ex)show(e.target.dataset.ex)};
$("#"+pf+"cp").onclick=()=>{$("#"+pf+"cm").textContent=copyTxt($("#"+pf+"xt").value)?"Copied.":"Select the text and press Ctrl/Cmd+C."};$("#"+pf+"dl").onclick=()=>{const ext={json:"json",c:"h",py:"py",lut:"csv"}[K]||"txt";download("obf-"+get().id+"."+ext,$("#"+pf+"xt").value,"text/plain;charset=utf-8");$("#"+pf+"cm").textContent="File downloaded."}}
document.addEventListener("click",e=>{const a=e.target.closest('a.lnk[href="#"]');if(a)e.preventDefault()});
function valModel(){if($("#vsc").checked&&KF)return{c:KF.c,p:KF.p1,b:KF.p0,ecm:KF.ecm,rct:KF.rct,cal:true};const c=CELLS[VCELL],m=$("#vm").value,rc=rcSet(c,m),rct=$("#vct").checked&&rc.length>0;return{c,p:{r0:c.r0,rc,Q:c.Ah,B:c.B,ecm:m,rct},b:null,ecm:m,rct,cal:false}}
function valUI(){if(KF!==vKF){vKF=KF;if(KF&&!$("#vsl").checked)$("#vsc").checked=true}if(!KF)$("#vsl").checked=true;else if(!$("#vsc").checked&&!$("#vsl").checked)$("#vsc").checked=true;$("#vsc").disabled=!KF;$("#vlib").hidden=$("#vsc").checked;
$("#vcal").innerHTML=KF?`${KF.c.n} · ${KF.ecm==="R"?"resistance only":KF.ecm+(KF.rct?" + R<sub>ct</sub>":"")} · fitted on ${KF.ds.length} profile${KF.ds.length>1?"s":""}, RMSE ${(KF.m1.rmse*1e3).toFixed(1)} mV`:'No calibrated model yet. <a href="#/calibrate">Calibrate one</a> or validate a library cell.';valInfo()}
function valInfo(){const mm=a=>a.reduce((r,x)=>[Math.min(r[0],x),Math.max(r[1],x)],[Infinity,-Infinity]);$("#vinfo").innerHTML=VPR.map((d,j)=>{const i=mm(d.i),t=d.T?mm(d.T):null;return `<div class="prow"><div class="pt"><b title="${esc(d.name)}">${esc(d.name)}</b><button type="button" class="rm" data-rm="${j}" aria-label="Remove ${esc(d.name)}">✕</button></div><small>${d.t.length} samples · ${((d.t[d.t.length-1]-d.t[0])/60).toFixed(0)} min · I ${i[0].toFixed(1)} to ${i[1].toFixed(1)} A · ${t?"T "+t[0].toFixed(0)+" to "+t[1].toFixed(0)+" °C":"no temperature"}</small><label class="cb1"><input type="checkbox" class="vneg" data-j="${j}" ${d.neg?"checked":""}><span>Charge current is positive</span></label><label class="so">SOC₀ %<input class="vs0" data-j="${j}" placeholder="auto" value="${d.soc0u||""}" inputmode="decimal"></label></div>`}).join("")}
function valAdd(txt,name){try{if(VPR.length>=3)throw new Error("Maximum 3 validation profiles: remove one first.");const d=parseCSV(txt);d.name=name;VPR.push(d);$("#verr").textContent="";valInfo();valDirty()}catch(e){$("#verr").textContent=name+": "+e.message}}
function valDemo(){if(VPR.length>=3){$("#verr").textContent="Maximum 3 validation profiles: remove one first.";return}const M=valModel(),c=M.c,tr={r0:c.r0*1.4,rc:[[c.r1*.54,c.tau*.28],[c.r1*.72,c.tau*2.7]],Q:c.Ah*.95,B:c.B,ecm:"2RC"},nn=vdn++;let sd=101+17*nn;const rnd=()=>(sd=(sd*16807)%2147483647)/2147483647;
const n=2400,dt=2,t=[],I=[];let cur=0;for(let k=0;k<n;k++){t.push(k*dt);if(k<60)cur=0;else if(k%15===0)cur=(rnd()<.2?-.4:rnd()*1.8)*c.Ah*(rnd()<.25?0:1);I.push(cur)}const tot=I.reduce((q,x)=>q+x*dt,0),sc=.6*tr.Q*3600/tot;for(let k=0;k<n;k++)I[k]*=sc;
const Ta=[20,8,30][nn%3],r=predictT(c,tr,{t,i:I,soc0:.9},Ta,1.2);VPR.push({name:"demo validation "+(nn+1)+" ("+Ta+" °C)",t,i:I.map(x=>+x.toFixed(3)),v:r.v.map(x=>+(x+(rnd()-.5)*.006).toFixed(4)),T:r.T.map(x=>+(x+(rnd()-.5)*.2).toFixed(2))});$("#verr").textContent="";valInfo();valDirty()}
async function valRun(){const out=$("#vres");if(!VPR.length){valPlace();return}
const M=valModel(),amb=$("#vamb").value.trim(),ok=fresh("val");let R;
try{R=await Solver.run("validate",{profiles:VPR,model:{c:M.c,p:M.p,b:M.b},amb})}
catch(err){console.error("Validation failed:",err);out.innerHTML='<p class="warn">The solver failed: '+esc(err.message)+'</p>';return}
if(!ok())return;valDraw(R,M)}
function valDraw(R,M){const out=$("#vres"),mm=a=>a.reduce((r,x)=>[Math.min(r[0],x),Math.max(r[1],x)],[Infinity,-Infinity]);
const cat=a=>[].concat(...a),S=vst(cat(R.map(r=>r.em))),Sb=M.b?vst(cat(R.map(r=>r.eb))):null,hasT=R.some(r=>r.tm),ST=hasT?vst(cat(R.filter(r=>r.et).map(r=>r.et))):null,f1=x=>x.toFixed(1);
VLAST={profiles:R.length,rmse_mV:+S.rmse.toFixed(3),mae_mV:+S.mae.toFixed(3),max_mV:+S.max.toFixed(3),bias_mV:+S.bias.toFixed(3),p95_mV:+S.p95.toFixed(3),temperature_rmse_K:hasT?+ST.rmse.toFixed(3):null};const calR=M.cal?KF.m1.rmse*1e3:null,ratio=calR?S.rmse/calR:null;
const K=[["Voltage RMSE",f1(S.rmse)+" mV"],["MAE",f1(S.mae)+" mV"],["Max error",f1(S.max)+" mV"],["Bias",(S.bias>=0?"+":"")+f1(S.bias)+" mV"],["95th percentile",f1(S.p95)+" mV"]];if(hasT)K.push(["Temperature RMSE",ST.rmse.toFixed(2)+" K"]);if(M.cal)K.push(["Calibration RMSE",f1(calR)+" mV"],["Validation / calibration",ratio.toFixed(1)+"×"]);
const verdict=!M.cal?"Library parameters only, so there is no calibration error to compare with. Calibrate the model on your own data, then validate it here.":ratio<1.5?"<b>The model generalises.</b> The validation error is within 1.5× the calibration error.":ratio<3?"<b>Use with caution.</b> The validation error is 1.5 to 3× the calibration error: the model may be tuned to its calibration profiles.":"<b>The model does not generalise to these profiles.</b> The validation error is more than 3× the calibration error: add more varied calibration profiles or a simpler model.";
const W=[];R.forEach(r=>{const w=[],Ir=mm(r.d.i.map(Math.abs));if(M.cal){if(r.P.T){const t=mm(r.P.T);if(t[0]<KF.Tr[0]-5||t[1]>KF.Tr[1]+5)w.push("temperature "+t[0].toFixed(0)+" to "+t[1].toFixed(0)+" °C is outside the calibration range ("+KF.Tr[0].toFixed(0)+" to "+KF.Tr[1].toFixed(0)+" °C)")}if(Ir[1]>1.2*Math.max(Math.abs(KF.Ir[0]),Math.abs(KF.Ir[1])))w.push("peak current "+Ir[1].toFixed(1)+" A exceeds the calibration range")}else{if(Ir[1]/M.c.Ah>M.c.dsC[1])w.push("peak "+(Ir[1]/M.c.Ah).toFixed(1)+" C is above the datasheet maximum of "+M.c.dsC[1]+" C");if(r.P.T){const t=mm(r.P.T);if(t[0]<M.c.dsT[0]||t[1]>M.c.dsT[1])w.push("temperature is outside the datasheet range")}}if(w.length)W.push(`<b>${esc(r.P.name)}</b>: ${w.join("; ")}`)});
const tb=R.map(r=>{const a=vst(r.em),b=r.eb?vst(r.eb):null,t=r.et?vst(r.et):null;return `<tr><td>${esc(r.P.name)}</td><td>${a.n}</td><td>${f1(a.rmse)}</td><td>${f1(a.mae)}</td><td>${f1(a.max)}</td><td>${(a.bias>=0?"+":"")+f1(a.bias)}</td>${M.b?`<td>${f1(b.rmse)}</td>`:""}<td>${t?t.rmse.toFixed(2)+" K":"n/a"}</td></tr>`}).join("");
VKi=Math.min(VKi,R.length-1);const J=R[VKi],st=Math.max(1,Math.ceil(J.d.t.length/1400)),dw=a=>a.filter((_,i)=>i%st===0),tm=dw(J.d.t.map(x=>x/60));
const SEL=R.length>1?`<select id="vsel" aria-label="Profile shown">${R.map((r,j)=>`<option value="${j}"${j===VKi?" selected":""}>${esc(r.P.name)}</option>`).join("")}</select>`:"";
const card=(id,t,x)=>`<div class="card pnl"><div class="phd"><h2>${t}</h2>${x||""}<button type="button" class="dlb" data-dl="${id}" data-t="${t}">Download image</button></div><div id="${id}"></div></div>`;
out.innerHTML=`<div class="kpis">${K.map(k=>`<div class="kpi"><small>${k[0]}</small><b>${k[1]}</b></div>`).join("")}</div><div class="card pnl" style="margin-top:12px">${verdict}<p class="note" style="font-size:12px;color:var(--mut);margin:8px 0 0">Thresholds are rules of thumb, not statistical limits. <a class="docl" href="#/docs/validate">How errors are computed</a></p></div>${W.length?`<div class="card pnl warn" style="margin-top:12px"><h2>Outside the fitted range</h2>${W.map(x=>"<p style='margin:4px 0'>"+x+"</p>").join("")}<p class="note" style="font-size:12px;color:var(--mut);margin:6px 0 0">Errors here include extrapolation.</p></div>`:""}
<div class="card pnl tbl" style="margin-top:12px"><div class="phd"><h2>Errors by profile</h2></div><table><thead><tr><th>Profile</th><th>Samples</th><th>RMSE (mV)</th><th>MAE (mV)</th><th>Max (mV)</th><th>Bias (mV)</th>${M.b?"<th>Library RMSE (mV)</th>":""}<th>Temp. RMSE</th></tr></thead><tbody>${tb}</tbody></table></div>
${card("vp1","Voltage: measured vs model",SEL)}${card("vp2","Voltage error (mV)")}${card("vp3","Error by state of charge")}${card("vp4","Error by C-rate")}${hasT?card("vp5","Cell temperature: measured vs thermal model"):""}${exportCard("vx")}`;
const ln=(n,x,y,c,w,f,dash)=>({name:n,x,y,col:c,w,fmt:f,dash});
plot($("#vp1"),{series:[ln("Measured",tm,dw(J.d.v),"var(--mut)",1.8,v=>v.toFixed(3)+" V"),...(J.vb?[ln("Library parameters",tm,dw(J.vb),"var(--warn)",2,v=>v.toFixed(3)+" V","6 5")]:[]),ln(M.cal?"Calibrated":"Model",tm,dw(J.vm),"var(--acc-d)",2.6,v=>v.toFixed(3)+" V")],xl:"Time (min)",yl:"Voltage (V)",H:300,fx:v=>v.toFixed(1)+" min",al:"Measured and predicted voltage"});
plot($("#vp2"),{series:[...(J.eb?[ln("Library parameters",tm,dw(J.eb),"var(--warn)",1.8,v=>v.toFixed(1)+" mV","6 5")]:[]),ln(M.cal?"Calibrated":"Model",tm,dw(J.em),"var(--acc-d)",2.4,v=>v.toFixed(1)+" mV")],xl:"Time (min)",yl:"Error, model − measured (mV)",H:240,fx:v=>v.toFixed(1)+" min",al:"Voltage error"});
const bp=(id,xs,ed,xl,fx)=>{const a=vbin(cat(R.map(r=>xs(r))),cat(R.map(r=>r.em)),ed),b=M.b?vbin(cat(R.map(r=>xs(r))),cat(R.map(r=>r.eb)),ed):null;if(a.length<2){$("#"+id).innerHTML='<p class="note" style="color:var(--mut)">Not enough spread in the data to bin the error.</p>';return}plot($("#"+id),{series:[...(b&&b.length>1?[ln("Library parameters",b.map(q=>q[0]),b.map(q=>q[1]),"var(--warn)",1.8,v=>v.toFixed(1)+" mV","6 5")]:[]),ln(M.cal?"Calibrated":"Model",a.map(q=>q[0]),a.map(q=>q[1]),"var(--acc-d)",2.8,v=>v.toFixed(1)+" mV")],xl,yl:"RMSE (mV)",H:210,fx,al:xl})};
bp("vp3",r=>r.soc.map(x=>x*100),[...Array(10).keys()].map(i=>i*10).concat([100.01]),"State of charge (%)",v=>v.toFixed(0)+" % SOC");
bp("vp4",r=>r.cr,[0,.25,.5,1,2,4,100],"C-rate (|I| / Q)",v=>v.toFixed(2)+" C");
if(hasT&&$("#vp5")&&J.tm)plot($("#vp5"),{series:[ln("Measured",tm,dw(J.P.T),"var(--mut)",1.8,v=>v.toFixed(1)+" °C"),ln("Thermal model",tm,dw(J.tm),"var(--warn)",2.6,v=>v.toFixed(1)+" °C")],xl:"Time (min)",yl:"Cell temperature (°C)",H:230,fx:v=>v.toFixed(1)+" min",al:"Cell temperature"});
$("#vsel")&&($("#vsel").onchange=e=>{VKi=+e.target.value;valRun()});exportWire("vx",valExportF);VRAN=true;$("#vstale").hidden=true}
function valInit(){if(vOn)return;vOn=true;$("#vc").textContent=CELLS[VCELL].n;$("#vc").onclick=()=>openCellPicker("v",0);const vh=$("#vch");if(vh)vh.onclick=()=>openCellPicker("v",0);
const rd=f=>{const r=new FileReader();r.onload=()=>valAdd(String(r.result),f.name);r.readAsText(f)},d=$("#vdrop");d.addEventListener("dragover",e=>{e.preventDefault();d.classList.add("on")});d.addEventListener("dragleave",()=>d.classList.remove("on"));d.addEventListener("drop",e=>{e.preventDefault();d.classList.remove("on");[...e.dataTransfer.files].forEach(rd)});$("#vf").onchange=e=>{[...e.target.files].forEach(rd);e.target.value=""};
$("#vdemo").onclick=valDemo;$("#vtpl").onclick=()=>{const ok=copyTxt("time_s,current_A,voltage_V,temp_C\n0,0.0,4.102,24.8\n1,2.5,4.071,24.8\n2,2.5,4.066,24.9\n");$("#verr").innerHTML=ok?'<span class="ok">Template copied.</span>':"Template: time_s,current_A,voltage_V,temp_C rows."};$("#vrun").onclick=valRun;
["vsc","vsl","vc","vm","vct"].forEach(i=>$("#"+i).addEventListener("change",()=>{$("#vlib").hidden=$("#vsc").checked;valDirty()}));$("#vamb").addEventListener("input",valDirty);
$("#vinfo").addEventListener("input",e=>{const j=e.target.dataset.j;if(j!==undefined){VPR[+j].soc0u=e.target.value;valDirty()}});$("#vinfo").addEventListener("change",e=>{if(e.target.classList.contains("vneg")){VPR[+e.target.dataset.j].neg=e.target.checked;valDirty()}});$("#vinfo").addEventListener("click",e=>{const b=e.target.closest("[data-rm]");if(b){VPR.splice(+b.dataset.rm,1);valInfo();valDirty()}});valPlace()}
/* ---------- chart image download ---------- */
function dlImg(el,title){const sv=el&&el.querySelector("svg");if(!sv)return;const rs=getComputedStyle(document.documentElement),bg=rs.getPropertyValue("--bg").trim()||"#fff",ink=rs.getPropertyValue("--ink").trim()||"#000",mut=rs.getPropertyValue("--mut").trim()||"#666";
const cl=sv.cloneNode(true),P=["fill","fill-opacity","stroke","stroke-width","stroke-dasharray","stroke-linecap","stroke-linejoin","stroke-opacity","opacity","font-family","font-size","font-weight","text-anchor","visibility","display","stop-color","stop-opacity"],a=[sv,...sv.querySelectorAll("*")],b=[cl,...cl.querySelectorAll("*")];
a.forEach((o,i)=>{const c=getComputedStyle(o);b[i].setAttribute("style",P.map(p=>p+":"+c.getPropertyValue(p)).join(";"));b[i].removeAttribute("class")});
const r=sv.getBoundingClientRect(),W=r.width,H=r.height,pad=16,sc=2,lg=el.parentElement.querySelector(".pleg"),it=lg?[...lg.children].map(n=>{const i=n.querySelector("i");return{t:n.textContent.trim(),c:i?getComputedStyle(i).backgroundColor:null}}):[],lh=it.length?Math.ceil(it.length/4)*20+6:0;
cl.setAttribute("width",W);cl.setAttribute("height",H);cl.setAttribute("xmlns","http://www.w3.org/2000/svg");
const img=new Image();img.onload=()=>{const cv=document.createElement("canvas"),CH=pad*2+30+H+lh+18;cv.width=(W+2*pad)*sc;cv.height=CH*sc;const x=cv.getContext("2d");x.scale(sc,sc);x.fillStyle=bg;x.fillRect(0,0,W+2*pad,CH);
x.fillStyle=ink;x.font="700 16px system-ui,sans-serif";x.fillText(title,pad,pad+14);x.drawImage(img,pad,pad+30,W,H);
let lx=pad,ly=pad+30+H+18;x.font="12px system-ui,sans-serif";it.forEach(q=>{const w=x.measureText(q.t).width+(q.c?16:0)+18;if(lx+w>W+pad){lx=pad;ly+=20}if(q.c){x.fillStyle=q.c;x.beginPath();x.arc(lx+5,ly-4,5,0,6.283);x.fill()}x.fillStyle=mut;x.fillText(q.t,lx+(q.c?16:0),ly);lx+=w});
x.fillStyle=mut;x.font="11px system-ui,sans-serif";x.textAlign="right";x.fillText("openBatteryFlux · "+new Date().toISOString().slice(0,10),W+pad,CH-8);
cv.toBlob(bl=>{const l=document.createElement("a");l.href=URL.createObjectURL(bl);l.download=title.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")+".png";l.click();setTimeout(()=>URL.revokeObjectURL(l.href),1e3)})};
img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(new XMLSerializer().serializeToString(cl))}
document.addEventListener("click",e=>{const b=e.target.closest("[data-dl]");if(b)dlImg(document.getElementById(b.dataset.dl),b.dataset.dl==="cchart"?"Compare cells: "+CY[CS.y][1]:b.dataset.t)});
/* ---------- ECM selectors ---------- */
function ecmSync(){document.querySelectorAll("#secm button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.m===SM.ecm));document.querySelectorAll("#kecm button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.m===KECM));$("#secmn").textContent=ECMN[SM.ecm]+(RCS[SM.ecm].length>1?" Branch values are a fixed split of the library R₁ and τ unless you applied a calibration.":"");$("#kecmn").textContent=ECMN[KECM]+(KECM==="R"?" No RC parameters to fit.":" Each branch gets its own R and τ.");$("#f1").disabled=KECM==="R";{const n=RCS[KECM].length,sb="₁₂₃",ct=$("#krct").checked;$("#f1l").innerHTML=n?Array.from({length:n},(_,j)=>ct&&!j?"R<sub>ct</sub>, τ<sub>ct</sub>":"R"+sb[j]+", τ"+sb[j]).join(" · "):"No RC branches"}$("#rctrow").hidden=SM.ecm==="R";$("#usect").checked=!!SM.rct;$("#krctrow").hidden=KECM==="R"}
{const gb=(l,a)=>`<div class="grp"><small>${l}</small><div class="seg">${a.map(m=>`<button type="button" data-m="${m[0]}">${m[1]}</button>`).join("")}</div></div>`,b=gb("Static",[["R","Resistance only"]])+gb("Dynamic",[["1RC","1RC"],["2RC","2RC"],["3RC","3RC"]]);$("#secm").innerHTML=b;$("#kecm").innerHTML=b;
$("#secm").onclick=e=>{const m=e.target.dataset.m;if(m){SM.ecm=m;simUI();simRender(true)}};$("#usect").onchange=e=>{SM.rct=e.target.checked;simUI();simRender(true)};$("#krct").onchange=()=>{ecmSync();$("#kst").innerHTML=KDS.length&&KF?'<span class="ok">Model changed: run the calibration again.</span>':""};
$("#kecm").onclick=e=>{const m=e.target.dataset.m;if(m){KECM=m;ecmSync();$("#kst").innerHTML=KDS.length&&KF?'<span class="ok">Model changed: run the calibration again.</span>':""}};ecmSync()}
if(RM)document.querySelectorAll(".bento svg,.pri svg,#ossview svg,#docsview svg,#valview svg").forEach(v=>{v.querySelectorAll(".pk").forEach(g=>g.remove());v.querySelectorAll("clipPath rect[data-w]").forEach(r=>r.setAttribute("width",r.dataset.w));v.querySelectorAll(".sc").forEach(l=>l.remove());v.querySelectorAll("animate,animateTransform").forEach(a=>a.remove())});
bridgeInit();
await OBF.ready();
await route();addEventListener("hashchange",route);
OBF.ready();
}catch(err){console.error(err);OBF.bootError(err)}
})();
