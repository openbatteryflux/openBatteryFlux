/* openBatteryFlux numeric core.

   One copy of the physics and the optimiser, shared by the page and by the
   worker in js/solver-worker.js. The tools send their inputs here and receive
   plain data back, so a long calibration runs off the thread that draws the
   interface.

   The formulas read upright state (SM: unit, SOH, start SOC, temperature,
   circuit model and charge transfer) because that is how the simulator was
   written. js/solver-worker.js binds its own copy per request; app.js binds
   its live SM object once, so the page and the worker compute the same thing. */
(function (root) {
  "use strict";

  /* Bound state. In the page this is the same SM object the interface mutates. */
  var SM = null, CELLS = null, CH = null, CAL = null;

  function bind(ctx) {
    if (!ctx) return;
    if (ctx.SM) SM = ctx.SM;
    if (ctx.CELLS) CELLS = ctx.CELLS;
    if (ctx.CH) CH = ctx.CH;
    if (ctx.CAL) CAL = ctx.CAL;
  }

  var clp = (x,a,b)=>Math.max(a,Math.min(b,x));

  var socF = s=>1+.6*Math.exp(-s/.08)+.35*Math.exp(-(1-s)/.03);

  var bvg = (I,R,T)=>{const x=96485*Math.abs(I)*R/(2*8.314*(T+273.15));return x<1e-6?1:Math.asinh(x)/x};

  const RCS={R:[],"1RC":[[1,1]],"2RC":[[.45,.2],[.55,1.8]],"3RC":[[.3,.1],[.4,.9],[.3,7]]};

  var rcSet = (c,m)=>c.rcC&&c.rcC.m===m?c.rcC.a:(RCS[m]||RCS["1RC"]).map(a=>[c.r1*a[0],c.tau*a[1]]);

  const VLC={nmc:{up:.3,dn:.3,fl:2,gu:.5,gd:.25},nca:{up:.3,dn:.3,fl:2,gu:.5,gd:.25},lfp:{up:.15,dn:.3,fl:1.6,gu:.25,gd:.15},lmfp:{up:.15,dn:.3,fl:1.6,gu:.25,gd:.15},na:{up:.2,dn:.3,fl:1.2,gu:.4,gd:.25},lto:{up:.2,dn:.4,fl:1,gu:.3,gd:.2},lmb:{up:.2,dn:.3,fl:2.5,gu:.4,gd:.25}};

  var ocvx = (c,s,L)=>s>1?ocv(c,1)+(s-1)/L.gH:s<0?ocv(c,0)+s/L.gL:ocv(c,s);

  var rsx = s=>s>1?1+3*(s-1):s<0?1-3*s:1;

  function ocv(c,s){const a=c.ocv,x=Math.min(1,Math.max(0,s))*(a.length-1),i=Math.min(a.length-2,Math.floor(x));return a[i]+(a[i+1]-a[i])*(x-i)}

  function conf(c,p,T){let e=0;const C=p.C,h=p.soh/100;
if(C>c.dsC[1])e+=Math.min(.45,.3*(C-c.dsC[1])/c.dsC[1]);if(C<c.dsC[0])e+=.05;
if(T<c.dsT[0])e+=Math.min(.4,.02*(c.dsT[0]-T));if(T>c.dsT[1])e+=Math.min(.4,.025*(T-c.dsT[1]));
if(h<.95)e+=Math.min(.3,.9*(.95-h));return Math.max(.1,1-e)}

  function confP(c,Cc,h,T){let e=0;if(Cc>c.dsC[1])e+=Math.min(.45,.3*(Cc-c.dsC[1])/c.dsC[1]);if(T<c.dsT[0])e+=Math.min(.4,.02*(c.dsT[0]-T));if(T>c.dsT[1])e+=Math.min(.4,.025*(T-c.dsT[1]));if(h<.95)e+=Math.min(.3,.9*(.95-h));return Math.max(.1,1-e)}

  function profStats(P){let a=0,m=-1/0,n=1/0;for(let i=0;i<P.t.length;i++){const d=(i+1<P.t.length?P.t[i+1]:P.period)-P.t[i];a+=P.u[i]*d;m=Math.max(m,P.u[i]);n=Math.min(n,P.u[i])}return{mean:a/P.period,max:m,min:n}}

  function vlLim(c,lo,hi){const k=VLC[c.ch]||VLC.nmc,loAbs=+Math.max(k.fl,c.Vmin-k.dn).toFixed(3),hiAbs=+(c.Vmax+k.up).toFixed(3);let Vmax=hi==null?c.Vmax:clp(hi,loAbs+.1,hiAbs),Vmin=lo==null?c.Vmin:clp(lo,loAbs,hiAbs-.1);Vmin=Math.min(Vmin,Vmax-.1);
return{Vmin,Vmax,loAbs,hiAbs,gH:k.gu,gL:k.gd,sMax:1+k.gu*Math.max(0,Vmax-c.Vmax),sMin:-k.gd*Math.max(0,c.Vmin-Vmin)}}

  function sim(c,p){const d=p.mode==="charge"?-1:1,I=d*p.C*c.Ah,h=p.soh/100,dt=Math.max(.5,Math.min(20,3600/Math.max(p.C,.05)/1500));
let soc=p.soc0/100,T=p.T,vk=[0,0,0],t=0,Q=0,E=0,why="time limit";const o={t:[],q:[],v:[],T:[],soc:[],P:[],cf:[]};
for(let n=0;n<300000;n++){const k=Math.exp(c.B*(1/(T+273.15)-1/298.15))/h,R0=c.r0*k*socF(soc),RS=rcSet(c,p.ecm||"1RC").map((a,j)=>[a[0]*k*(p.rct&&j===0?bvg(I,a[0]*k,T):1),a[1]]),R1=RS.reduce((s,a)=>s+a[0],0),v=ocv(c,soc)-I*R0-vk[0]-vk[1]-vk[2];
if(n>0){if(d>0&&v<=c.Vmin){why="cut-off voltage";break}if(d>0&&soc<=0){why="empty";break}if(d<0&&v>=c.Vmax){why="voltage limit";break}if(d<0&&soc>=1){why="full";break}}
o.t.push(t);o.q.push(Q);o.v.push(v);o.T.push(T);o.soc.push(soc);o.P.push(v*I*d);o.cf.push(conf(c,p,T));
const cap=c.Ah*h*(T<25?Math.max(.45,1-.008*(25-T)):1);
soc-=I*dt/(cap*3600);Q+=I*d*dt/3600;E+=v*I*d*dt/3600;RS.forEach((a,j)=>vk[j]+=(I*a[0]-vk[j])*(1-Math.exp(-dt/a[1])));
T+=(I*I*(R0+R1)-c.hA*(c.hAs||1)*(T-p.T))/(c.m*.9*(c.cthS||1))*dt;t+=dt}
o.Q=Q;o.E=E;o.why=why;return o}

  function simP(c,P,vl){const Vm=vl||vlLim(c,null,null),cus=Vm.Vmin!==c.Vmin||Vm.Vmax!==c.Vmax,vt=x=>cus?" ("+x.toFixed(2)+" V)":"",U=SM.unit,h=SM.soh/100,TM=72000,allChg=P.u.every(x=>x<=0),tot=P.reps===0?Infinity:P.period*P.reps;
let soc=SM.soc0/100,Tc=SM.T,vrc=0,vk=[0,0,0],Ip=0,Q=0,E=0,why="profile end",sg=0,pv=0,ended=false;const o={t:[],I:[],V:[],T:[],soc:[],P:[],cf:[]};
for(let n=0;n<TM;n++){const t=n;if(t>=tot){ended=true;break}const tp=t%P.period;if(tp<pv)sg=0;pv=tp;while(sg+1<P.t.length&&P.t[sg+1]<=tp)sg++;const lv=P.u[sg];
const kT=Math.exp(c.B*(1/(Tc+273.15)-1/298.15))/h,R0=c.r0*kT*socF(clp(soc,0,1))*rsx(soc),RS=rcSet(c,SM.ecm).map((a,j)=>[a[0]*kT*(SM.rct&&j===0?bvg(Ip,a[0]*kT,Tc):1),a[1]]),R1=RS.reduce((s,a)=>s+a[0],0),oc=ocvx(c,soc,Vm);vrc=vk[0]+vk[1]+vk[2];
let I=U==="C"?lv*c.Ah:lv;if(U==="W"){let v=Math.max(oc-vrc,Vm.Vmin);I=lv/v;v=oc-I*R0-vrc;I=lv/Math.max(v,Vm.Vmin*.8)}
I=Math.max(-40*c.Ah,Math.min(40*c.Ah,I));let v=oc-I*R0-vrc;
if(I>0&&(v<=Vm.Vmin||soc<=Vm.sMin)){why=soc<=Vm.sMin?"empty":"cut-off voltage"+vt(Vm.Vmin);ended=true;break}
if(I<0&&(v>=Vm.Vmax||soc>=Vm.sMax)){if(allChg){why=soc>=Vm.sMax?"full":"voltage limit"+vt(Vm.Vmax);ended=true;break}I=0;v=oc-vrc}
o.t.push(t);o.I.push(I);o.V.push(v);o.T.push(Tc);o.soc.push(soc);o.P.push(v*I);o.cf.push(Math.max(.1,confP(c,Math.abs(I)/c.Ah,h,Tc)-Math.min(.5,1.5*(Math.max(0,v-c.Vmax)+Math.max(0,c.Vmin-v)))));
const cap=c.Ah*h*(Tc<25?Math.max(.45,1-.008*(25-Tc)):1);soc-=I/(cap*3600);Q+=I/3600;E+=v*I/3600;RS.forEach((a,j)=>vk[j]+=(I*a[0]-vk[j])*(1-Math.exp(-1/a[1])));Ip=I;Tc+=(I*I*(R0+R1)-c.hA*(c.hAs||1)*(Tc-SM.T))/(c.m*.9*(c.cthS||1))}
if(!ended)why=tot===Infinity||tot>TM?"time limit":"profile end";o.Q=Q;o.E=E;o.why=why;return o}

  function predict(c,p,d){const n=d.t.length,out=new Array(n);let soc=d.soc0+(p.ds||0);const vk=[0,0,0],RB=p.rc||rcSet(p,"1RC");
for(let k=0;k<n;k++){const T=d.T?d.T[k]:25,kT=Math.exp(p.B*(1/(T+273.15)-1/298.15)),R0=p.r0*kT*socF(soc),I=d.i[k],q=p.Q*(T<25?Math.max(.45,1-.008*(25-T)):1);
out[k]=ocv(c,soc)-I*R0-vk[0]-vk[1]-vk[2];const dt=k<n-1?d.t[k+1]-d.t[k]:0;if(dt>0){soc-=I*dt/(q*3600);RB.forEach((b,j)=>{const a=Math.exp(-dt/b[1]),Rb=b[0]*kT*(p.rct&&j===0?bvg(I,b[0]*kT,T):1);vk[j]=vk[j]*a+I*Rb*(1-a)})}}return out}

  function predictT(c,p,d,Ta,hs,cs){const n=d.t.length,v=new Array(n),T=new Array(n),RB=p.rc||rcSet(p,"1RC"),vk=[0,0,0],Cth=c.m*.9*(cs||1),hA=c.hA*(hs||1);let soc=d.soc0,Tc=Ta;
for(let k=0;k<n;k++){const kT=Math.exp(p.B*(1/(Tc+273.15)-1/298.15)),R0=p.r0*kT*socF(soc),I=d.i[k],q=p.Q*(Tc<25?Math.max(.45,1-.008*(25-Tc)):1);T[k]=Tc;v[k]=ocv(c,soc)-I*R0-vk[0]-vk[1]-vk[2];const dt=k<n-1?d.t[k+1]-d.t[k]:0;
if(dt>0){soc-=I*dt/(q*3600);let Rt=R0;RB.forEach((b,j)=>{const a=Math.exp(-dt/b[1]),Rb=b[0]*kT*(p.rct&&j===0?bvg(I,b[0]*kT,Tc):1);Rt+=Rb;vk[j]=vk[j]*a+I*Rb*(1-a)});const ns=Math.max(1,Math.ceil(dt/5));for(let z=0;z<ns;z++)Tc+=(dt/ns)*(I*I*Rt-hA*(Tc-Ta))/Cth}}return{v,T}}

  function nm(f,x0,st,it){const n=x0.length;let P=[x0.slice()];for(let i=0;i<n;i++){const x=x0.slice();x[i]+=st[i];P.push(x)}let F=P.map(f);
for(let k=0;k<it;k++){const o=F.map((_,i)=>i).sort((a,b)=>F[a]-F[b]);P=o.map(i=>P[i]);F=o.map(i=>F[i]);const c=P[0].map((_,j)=>P.slice(0,n).reduce((s,p)=>s+p[j],0)/n),w=P[n],r=c.map((v,j)=>v+(v-w[j])),fr=f(r);
if(fr<F[0]){const e=c.map((v,j)=>v+2*(v-w[j])),fe=f(e);if(fe<fr){P[n]=e;F[n]=fe}else{P[n]=r;F[n]=fr}}else if(fr<F[n-1]){P[n]=r;F[n]=fr}
else{const ct=c.map((v,j)=>v+.5*(w[j]-v)),fc=f(ct);if(fc<F[n]){P[n]=ct;F[n]=fc}else{for(let i=1;i<=n;i++){P[i]=P[0].map((v,j)=>v+.5*(P[i][j]-v));F[i]=f(P[i])}}}}
const b=F.indexOf(Math.min(...F));return{x:P[b],f:F[b]}}

  function met(p,m){const mean=m.reduce((a,b)=>a+b,0)/m.length;let se=0,ae=0,mx=0,st=0;for(let i=0;i<m.length;i++){const e=p[i]-m[i];se+=e*e;ae+=Math.abs(e);mx=Math.max(mx,Math.abs(e));st+=(m[i]-mean)**2}return{rmse:Math.sqrt(se/m.length),mae:ae/m.length,max:mx,r2:1-se/st}}

  function invOcv(c,v){let a=0,b=1;for(let k=0;k<30;k++){const m=(a+b)/2;ocv(c,m)<v?a=m:b=m}return(a+b)/2}

  function rbv(c,s,T,h,pw,I){const k=Math.exp(c.B*(1/(T+273.15)-1/298.15))/h,b=rcSet(c,"3RC"),r0=c.r0*k*socF(s),rc=b[0][0]*k,x=96485*Math.abs(I)*rc/(2*8.314*(T+273.15)),g=x<1e-6?1:Math.asinh(x)/x,fr=q=>1-Math.exp(-pw/q[1]),rf=b.slice(1).reduce((a,q)=>a+q[0]*k*fr(q),0);return{R:r0+rc*g*fr(b[0])+rf,F:r0+rf}}

  function pmax(c,s,T,h,pw,chg,Tl){const o=ocv(c,s),V=chg?c.Vmax:c.Vmin;if(chg?o>=V:o<=V)return{P:0,th:false};const R=i=>rbv(c,s,T,h,pw,i).R;let lo=0,hi=Math.abs(o-V)/rbv(c,s,T,h,pw,0).F;for(let n=0;n<40;n++){const m=(lo+hi)/2;(chg?o+m*R(m)<V:o-m*R(m)>V)?lo=m:hi=m}
let cap=lo,th=false;if(Tl<100){const dT=Tl-T;if(dT<=0)return{P:0,th:true};const g=(1-Math.exp(-pw*c.hA/(c.m*.9)))/c.hA;if(lo*lo*R(lo)*g>dT){let a=0,b=lo;for(let n=0;n<30;n++){const m=(a+b)/2;(m*m*R(m)*g<=dT)?a=m:b=m}cap=a;th=true}}
if(chg)return{P:cap*(o+cap*R(cap)),th};let P=0;for(let n=1;n<=40;n++){const i=cap*n/40;P=Math.max(P,i*(o-i*R(i)))}return{P,th}}

  root.OBFSolver = {
    bind: bind,
    ocv: ocv, conf: conf, confP: confP, profStats: profStats, vlLim: vlLim,
    sim: sim, simP: simP, predict: predict, predictT: predictT,
    nm: nm, met: met, invOcv: invOcv, rcSet: rcSet, RCS: RCS,
    rbv: rbv, pmax: pmax,
    socF: socF, bvg: bvg, clp: clp
  };
})(typeof self !== "undefined" ? self : window);
