import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend, ReferenceLine } from "recharts";
import { SearchableSelect } from "../baseball/SharedComponents.jsx";

function useWindowWidth() {
  const [w, setW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1024));
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
}

const BIN_COLORS={"0-10":"#08306B","10-25":"#2171B5","25-45":"#6BAED6","45-55":"#D9D9D9","55-75":"#FC9272","75-90":"#FB6A4A","90-100":"#CB181D"};
const pctToBin=p=>{if(p==null||!isFinite(p))return"NA";if(p>=90)return"90-100";if(p>=75)return"75-90";if(p>=55)return"55-75";if(p>=45)return"45-55";if(p>=25)return"25-45";if(p>=10)return"10-25";return"0-10"};
const binColor=p=>BIN_COLORS[pctToBin(p)]||"#444";
const textOnBin=p=>{if(p==null)return"#aaa";return(p<25||p>=75)?"#fff":"#111"};
const LOGO_FALLBACK=a=>{const m={"L.A":"LAK","N.J":"NJD","S.J":"SJS","T.B":"TBL"};const nhl=m[a]||a;return`/nhl-assets/logos/nhl/svg/${nhl}_light.svg`};
const FLAG=c=>c?`/flag-assets/w80/${c.toLowerCase()}.png`:null;

const NST_TO_NHL={"L.A":"LAK","N.J":"NJD","S.J":"SJS","T.B":"TBL"};

const NHL_TEAM_PRIMARY={
  ANA:"#F47A38",BOS:"#FFB81C",BUF:"#003087",CAR:"#CC0000",
  CBJ:"#002654",CGY:"#C8102E",CHI:"#CF0A2C",COL:"#6F263D",
  DAL:"#006847",DET:"#CE1126",EDM:"#FF4C00",FLA:"#041E42",
  LAK:"#111111",MIN:"#154734",MTL:"#AF1E2D",NJD:"#CE1126",
  NSH:"#FFB81C",NYI:"#003087",NYR:"#0038A8",OTT:"#E31837",
  PHI:"#F74902",PIT:"#FCB514",SEA:"#001628",SJS:"#006D75",
  STL:"#002F87",TBL:"#002868",TOR:"#00205B",UTA:"#71B2C9",
  VAN:"#00205B",VGK:"#B4975A",WPG:"#041E42",WSH:"#C8102E",
  // NST abbreviations
  "L.A":"#111111","N.J":"#CE1126","S.J":"#006D75","T.B":"#002868",
};

function nhlHexLuminance(hex){
  return[hex.slice(1,3),hex.slice(3,5),hex.slice(5,7)].reduce((sum,h,i)=>{
    const c=parseInt(h,16)/255;
    const lin=c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);
    return sum+lin*[0.2126,0.7152,0.0722][i];
  },0);
}

function useLogos(){
  const[map,setMap]=useState({});
  useEffect(()=>{
    fetch('/logos.json')
      .then(r=>{if(!r.ok)throw new Error('no file');return r.json()})
      .then(d=>{
        // Convert full URLs to proxy URLs
        const m={};
        for(const[k,v] of Object.entries(d)){
          m[k]=v.replace("https://assets.nhle.com/","/nhl-assets/");
        }
        setMap(m);
      })
      .catch(()=>{
        // Fallback: build from known abbreviations
        const m={};
        const all=["ANA","BOS","BUF","CAR","CBJ","CGY","CHI","COL","DAL","DET","EDM","FLA","LAK","MIN","MTL","NJD","NSH","NYI","NYR","OTT","PHI","PIT","SEA","SJS","STL","TBL","TOR","UTA","VAN","VGK","WPG","WSH"];
        all.forEach(t=>{m[t]=`/nhl-assets/logos/nhl/svg/${t}_light.svg`});
        Object.entries(NST_TO_NHL).forEach(([nst,nhl])=>{m[nst]=`/nhl-assets/logos/nhl/svg/${nhl}_light.svg`});
        setMap(m);
      });
  },[]);
  return map;
}
const HEADSHOT_PREFIX="/nhl-assets/";

const ALL_TEAMS=["ANA","BOS","BUF","CAR","CBJ","CGY","CHI","COL","DAL","DET","EDM","FLA","LAK","MIN","MTL","NJD","NSH","NYI","NYR","OTT","PHI","PIT","SEA","SJS","STL","TBL","TOR","UTA","VAN","VGK","WPG","WSH"];

function useHeadshots(){
  const[map,setMap]=useState({});
  useEffect(()=>{
    fetch('/headshots.json')
      .then(r=>{if(!r.ok)throw new Error('no file');return r.json()})
      .then(d=>{
        // Convert full NHL URLs to proxy URLs
        const m={};
        for(const[k,v] of Object.entries(d)){
          m[k]=v.replace("https://assets.nhle.com/","/nhl-assets/");
        }
        setMap(m);
      })
      .catch(()=>{
        // Fallback: fetch from NHL API
        const m={};
        Promise.allSettled(ALL_TEAMS.map(t=>
          fetch(`/nhl-api/v1/roster/${t}/current`).then(r=>r.json()).then(d=>{
            ["forwards","defensemen","goalies"].forEach(pos=>{
              (d[pos]||[]).forEach(p=>{
                const fn=p.firstName?.default||"";
                const ln=p.lastName?.default||"";
                const name=`${fn} ${ln}`.trim();
                if(name&&p.headshot)m[name]=p.headshot.replace("https://assets.nhle.com/","/nhl-assets/");
              });
            });
          }).catch(()=>{})
        )).then(()=>{if(Object.keys(m).length>0)setMap({...m})});
      });
  },[]);
  return map;
}

function PercentileBar({label,pctile,isOverall,weight}){
  const w=pctile!=null?Math.max(2,pctile):0;
  return(
    <div style={{display:"flex",alignItems:"center",marginBottom:isOverall?12:5,gap:8,width:"100%"}}>
      <div style={{width:115,textAlign:"right",fontSize:isOverall?13:12,fontWeight:isOverall?800:500,color:isOverall?"#f8fafc":"#e2e8f0",flexShrink:0,whiteSpace:"nowrap"}}>{label}{weight===0&&pctile==null?" (N/A)":""}</div>
      <div style={{flex:1,position:"relative",height:isOverall?28:22,background:"#0f172a",borderRadius:4,border:isOverall?"2px solid #f59e0b":"1px solid #1e3a5f",overflow:"hidden"}}>
        <div style={{width:`${w}%`,height:"100%",background:binColor(pctile),borderRadius:3,transition:"width 0.6s cubic-bezier(0.25,0.46,0.45,0.94)"}}/>
      </div>
      <div style={{width:32,textAlign:"right",fontSize:isOverall?14:12,fontWeight:isOverall?800:600,color:pctile!=null?"#f8fafc":"#64748b",fontFamily:"'DM Mono',monospace",flexShrink:0}}>{pctile!=null?Math.round(pctile):"—"}</div>
    </div>
  );
}

function PlayerHeader({name,team,subtitle,olympicCountry,headshotUrl,logoSrc}){
  const nhlTeam=NST_TO_NHL[team]||team;
  const bgColor=NHL_TEAM_PRIMARY[nhlTeam]||NHL_TEAM_PRIMARY[team]||"#1e293b";
  const light=nhlHexLuminance(bgColor)>0.179;
  const textColor=light?"#111111":"#ffffff";
  const subColor=light?"rgba(0,0,0,0.6)":"rgba(255,255,255,0.72)";
  const ringColor=light?"rgba(0,0,0,0.2)":"rgba(255,255,255,0.25)";
  return(
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 20px 14px",gap:16,background:bgColor}}>
      <img crossOrigin="anonymous" src={logoSrc||LOGO_FALLBACK(team)} alt={team} style={{width:64,height:64,objectFit:"contain",filter:"drop-shadow(0 2px 8px rgba(0,0,0,0.4))"}} onError={e=>{e.target.style.display="none"}}/>
      <div style={{flex:1,textAlign:"center"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          <span style={{fontSize:22,fontWeight:800,color:textColor,letterSpacing:"-0.02em"}}>{name}</span>
          {FLAG(olympicCountry)&&<img crossOrigin="anonymous" src={FLAG(olympicCountry)} alt="" style={{height:16,border:"1px solid rgba(255,255,255,0.4)",borderRadius:2}}/>}
        </div>
        <div style={{fontSize:11,color:subColor,marginTop:4,letterSpacing:"0.06em",fontStyle:"italic",fontWeight:600,textTransform:"uppercase"}}>{subtitle}</div>
      </div>
      <div style={{width:64,height:64,borderRadius:"50%",background:ringColor,overflow:"hidden",border:`2px solid ${ringColor}`,flexShrink:0,position:"relative"}}>
        {headshotUrl&&<img crossOrigin="anonymous" src={headshotUrl} alt="" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover"}} onError={e=>{e.target.style.display="none"}}/>}
      </div>
    </div>
  );
}

function TrendChart({data,lines,colors,labels}){
  if(!data||data.length===0)return null;
  const order=["23-24","24-25","25-26"];
  const sorted=[...data].sort((a,b)=>order.indexOf(a.season)-order.indexOf(b.season));
  return(
    <div style={{padding:"8px 12px 0"}}>
      <ResponsiveContainer width="100%" height={170}>
        <LineChart data={sorted} margin={{top:8,right:16,bottom:4,left:0}}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f"/>
          <XAxis dataKey="season" tick={{fill:"#94a3b8",fontSize:11}} tickLine={false} axisLine={{stroke:"#334155"}}/>
          <YAxis domain={[0,100]} ticks={[0,25,50,75,100]} tick={{fill:"#64748b",fontSize:10}} tickLine={false} axisLine={false} width={28}/>
          {lines.map((key,i)=>(
            <Line key={key} type="monotone" dataKey={key} stroke={colors[i]} strokeWidth={2.5} dot={{r:4,fill:colors[i],stroke:"#0f172a",strokeWidth:2}}/>
          ))}
          <Legend formatter={v=>labels[lines.indexOf(v)]||v} wrapperStyle={{fontSize:10,color:"#94a3b8",paddingTop:4}}/>
          <ReferenceLine y={50} stroke="#475569" strokeDasharray="4 4"/>
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Card({player,type,trends,mode,headshots,logos}){
  const cardRef=useRef(null);
  const pname=player?(type==="goalie"?player.name:player.display_name):"";
  const saveCard=useCallback(async()=>{
    if(!cardRef.current)return;
    const imgs=[...cardRef.current.querySelectorAll("img")];
    const originals=[];
    const toDataUrl=(src,w,h)=>new Promise(resolve=>{
      const c=document.createElement("canvas");
      const s=2;c.width=w*s;c.height=h*s;
      const ctx=c.getContext("2d");
      const i=new Image();
      i.crossOrigin="anonymous";
      i.onload=()=>{
        const iw=i.naturalWidth||i.width;
        const ih=i.naturalHeight||i.height;
        const scale=Math.min(c.width/iw,c.height/ih);
        const dw=iw*scale,dh=ih*scale;
        const dx=(c.width-dw)/2,dy=(c.height-dh)/2;
        ctx.drawImage(i,dx,dy,dw,dh);
        resolve(c.toDataURL("image/png"));
      };
      i.onerror=()=>resolve(null);
      i.src=src;
    });
    await Promise.allSettled(imgs.map(async img=>{
      if(!img.src||img.src.startsWith("data:"))return;
      try{
        const rect=img.getBoundingClientRect();
        const w=rect.width||64;
        const h=rect.height||64;
        const dataUrl=await toDataUrl(img.src,w,h);
        if(dataUrl){originals.push({img,orig:img.src});img.src=dataUrl;}
      }catch(e){}
    }));
    await new Promise(r=>setTimeout(r,100));
    const html2canvas=(await import("html2canvas")).default;
    const canvas=await html2canvas(cardRef.current,{backgroundColor:"#0a0f1a",scale:2,logging:false});
    const link=document.createElement("a");
    link.download=`${pname.replace(/\s+/g,"_")}_card.png`;
    link.href=canvas.toDataURL("image/png");
    link.click();
    originals.forEach(({img,orig})=>{img.src=orig});
  },[pname]);
  if(!player)return <div style={{color:"#64748b",padding:40,textAlign:"center"}}>Select a player</div>;
  const cats=Object.entries(player.categories);
  const headshotRaw=headshots?.[pname]||null;
  const headshotUrl=headshotRaw;
  const subtitle=type==="goalie"
    ?`${player.team} | G | GP: ${player.gp} | TOI: ${player.icetime_hrs} hrs | GSAx: ${player.gsax_total>0?"+":""}${player.gsax_total} | GP Share: ${player.gp_share}%`
    :`${player.team} | ${player.position} | GP: ${player.gp} | 5v5 TOI: ${player.toi_min} min${player.oz_shift_pct!=null?` | OZ%: ${player.oz_shift_pct}%`:""}`;
  const trendData=trends?trends[pname]:null;
  const showTrend=mode==="3-Year Rolling"&&trendData&&trendData.length>0;
  return(
    <div>
      <div ref={cardRef} style={{background:"#111827",borderRadius:12,border:"1px solid #1e3a5f",overflow:"hidden",boxShadow:"0 4px 24px rgba(0,0,0,0.5)",maxWidth:600,margin:"0 auto"}}>
        <PlayerHeader name={pname} team={player.team} subtitle={subtitle} olympicCountry={player.olympic_country} headshotUrl={headshotUrl} logoSrc={logos?.[player.team]}/>
        <div style={{padding:"8px 12px 4px"}}>
          <PercentileBar label="Impact" pctile={player.overall_pctile} isOverall={true}/>
          <div style={{height:4}}/>
          {cats.map(([name,cat])=><PercentileBar key={name} label={name} pctile={cat.pctile} weight={cat.weight} isOverall={false}/>)}
        </div>
        {showTrend&&<TrendChart data={trendData}
          lines={type==="goalie"?["hd_gsax","md_gsax","ld_gsax"]:["offense","defense","overall"]}
          colors={type==="goalie"?["#f59e0b","#94a3b8","#3b82f6"]:["#f59e0b","#3b82f6","#f8fafc"]}
          labels={type==="goalie"?["High Danger","Med Danger","Low Danger"]:["5v5 Offense","5v5 Defense","Overall"]}/>}
        <div style={{padding:"6px 16px 10px",display:"flex",justifyContent:"space-between",fontSize:10,color:"#64748b"}}>
          <span>{mode==="3-Year Rolling"?"3-Year Rolling Weighted":mode} | {type==="goalie"?"All goalies":`${player.pos_group} only`}</span>
          <span style={{fontStyle:"italic"}}>PastTheEyeTest | NST + EH</span>
        </div>
      </div>
      <div style={{maxWidth:600,margin:"8px auto 0",textAlign:"right"}}>
        <button onClick={saveCard} style={{padding:"6px 16px",fontSize:11,fontWeight:600,background:"#0f172a",color:"#94a3b8",border:"1px solid #1e3a5f",borderRadius:6,cursor:"pointer",transition:"all 0.15s"}}
          onMouseEnter={e=>{e.target.style.background="#f59e0b";e.target.style.color="#0f172a";e.target.style.borderColor="#f59e0b"}}
          onMouseLeave={e=>{e.target.style.background="#0f172a";e.target.style.color="#94a3b8";e.target.style.borderColor="#1e3a5f"}}>
          Save as PNG
        </button>
      </div>
    </div>
  );
}

function WeightTable({player,type}){
  if(!player)return null;
  const cats=Object.entries(player.categories);
  const tdS={padding:"5px 8px",fontSize:11,borderBottom:"1px solid #1e3a5f"};
  return(
    <div style={{marginTop:16,maxWidth:600,margin:"16px auto 0"}}>
      <div style={{fontSize:13,fontWeight:700,color:"#94a3b8",marginBottom:8}}>Weight Breakdown</div>
      <table style={{width:"100%",borderCollapse:"collapse",background:"#0f172a",borderRadius:8,overflow:"hidden"}}>
        <thead><tr>
          <th style={{textAlign:"left",padding:"6px 8px",borderBottom:"2px solid #334155",color:"#64748b",fontSize:11}}>Category</th>
          <th style={{textAlign:"center",padding:"6px 8px",borderBottom:"2px solid #334155",color:"#64748b",fontSize:11}}>Pctile</th>
          {type==="goalie"&&<th style={{textAlign:"center",padding:"6px 8px",borderBottom:"2px solid #334155",color:"#64748b",fontSize:11}}>Per 60</th>}
          <th style={{textAlign:"right",padding:"6px 8px",borderBottom:"2px solid #334155",color:"#64748b",fontSize:11}}>Weight</th>
        </tr></thead>
        <tbody>
          <tr style={{background:"#1e293b"}}>
            <td style={{...tdS,fontWeight:700,color:"#f8fafc"}}>IMPACT SCORE</td>
            <td style={{...tdS,textAlign:"center",fontWeight:700,color:"#f59e0b"}}>{player.overall_pctile?.toFixed(1)}</td>
            {type==="goalie"&&<td style={{...tdS,textAlign:"center",color:"#64748b"}}>—</td>}
            <td style={{...tdS,textAlign:"right",color:"#94a3b8"}}>100%</td>
          </tr>
          {cats.map(([name,cat],i)=>{
            const rk={"5v5 GSAx":"ev5_gsax","Penalty Kill":"pk_gsax","High Danger GSAx":"hd_gsax","Med Danger GSAx":"md_gsax","Low Danger GSAx":"ld_gsax","Rebound Control":"reb"}[name];
            return(
              <tr key={name} style={{background:i%2===0?"#0f172a":"#1e293b"}}>
                <td style={{...tdS,color:"#e2e8f0"}}>{name}</td>
                <td style={{...tdS,textAlign:"center",color:cat.pctile!=null?"#f8fafc":"#475569"}}>{cat.pctile!=null?cat.pctile.toFixed(1):"N/A"}</td>
                {type==="goalie"&&<td style={{...tdS,textAlign:"center",color:"#94a3b8"}}>{rk&&player.raw_per60?.[rk]!=null?player.raw_per60[rk]:name==="Ice Time"?`${player.gp_share}%`:"—"}</td>}
                <td style={{...tdS,textAlign:"right",color:"#94a3b8"}}>{cat.weight===0?"N/A":`${(cat.weight*100).toFixed(1)}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HockeyLeaderboard({players,columns,sortDefault}){
  const[sortCol,setSortCol]=useState(sortDefault||"overall_pctile");
  const[sortDir,setSortDir]=useState("desc");
  const[search,setSearch]=useState("");
  const filtered=useMemo(()=>{
    let arr=[...players];
    if(search){const q=search.toLowerCase();arr=arr.filter(p=>(p.display_name||p.name).toLowerCase().includes(q)||p.team.toLowerCase().includes(q))}
    arr.sort((a,b)=>{
      let av,bv;
      if(sortCol==="name"){av=(a.display_name||a.name);bv=(b.display_name||b.name)}
      else if(sortCol==="team"){av=a.team;bv=b.team}
      else if(sortCol==="gp"){av=a.gp;bv=b.gp}
      else if(sortCol==="toi_min"){av=a.toi_min;bv=b.toi_min}
      else if(sortCol==="overall_pctile"){av=a.overall_pctile;bv=b.overall_pctile}
      else{av=a.categories[sortCol]?.pctile;bv=b.categories[sortCol]?.pctile}
      if(av==null)return 1;if(bv==null)return-1;
      if(typeof av==="string")return sortDir==="asc"?av.localeCompare(bv):bv.localeCompare(av);
      return sortDir==="asc"?av-bv:bv-av;
    });
    return arr;
  },[players,sortCol,sortDir,search]);
  const toggle=col=>{if(sortCol===col)setSortDir(d=>d==="asc"?"desc":"asc");else{setSortCol(col);setSortDir("desc")}};
  const thS={padding:"8px 6px",textAlign:"center",cursor:"pointer",fontSize:10,fontWeight:700,color:"#94a3b8",borderBottom:"2px solid #334155",whiteSpace:"nowrap",userSelect:"none",position:"sticky",top:0,background:"#111827",zIndex:2};
  const tdS={padding:"5px 6px",textAlign:"center",fontSize:11,borderBottom:"1px solid #1e3a5f",whiteSpace:"nowrap"};
  return(
    <div>
      <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search player or team..."
        style={{width:"100%",maxWidth:300,padding:"8px 12px",background:"#0f172a",border:"1px solid #1e3a5f",borderRadius:6,color:"#f8fafc",fontSize:13,marginBottom:12,outline:"none"}}/>
      <div style={{overflowX:"auto",borderRadius:8,border:"1px solid #1e3a5f",maxHeight:"70vh",overflowY:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",background:"#0f172a"}}>
          <thead><tr>{columns.map(c=><th key={c.key} onClick={()=>toggle(c.key)} style={thS}>{c.label} {sortCol===c.key?(sortDir==="desc"?"▾":"▴"):""}</th>)}</tr></thead>
          <tbody>{filtered.map((p,i)=>(
            <tr key={i} style={{background:i%2===0?"#0f172a":"#1e293b"}}>
              {columns.map(c=>{
                let val,st={...tdS};
                if(c.key==="name"){val=p.display_name||p.name;st.textAlign="left";st.fontWeight=600;st.color="#f8fafc";st.position="sticky";st.left=0;st.background=i%2===0?"#0f172a":"#1e293b";st.zIndex=1}
                else if(c.key==="team"){val=p.team;st.color="#94a3b8"}
                else if(c.key==="position"){val=p.position;st.color="#94a3b8"}
                else if(c.key==="gp"){val=p.gp;st.color="#94a3b8"}
                else if(c.key==="toi_min"){val=p.toi_min;st.color="#94a3b8"}
                else if(c.key==="overall_pctile"){val=p.overall_pctile!=null?p.overall_pctile.toFixed(1):"—";st.background=binColor(p.overall_pctile);st.color=textOnBin(p.overall_pctile);st.fontWeight=700}
                else{const cat=p.categories[c.key];val=cat?.pctile!=null?cat.pctile.toFixed(1):"—";st.color=cat?.pctile!=null?"#e2e8f0":"#475569"}
                return <td key={c.key} style={st}>{val}</td>;
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div style={{fontSize:10,color:"#64748b",marginTop:8}}>{filtered.length} players</div>
    </div>
  );
}

const TABS=[
  {id:"skater",label:"Player Card"},
  {id:"goalie",label:"Goalie Card"},
  {id:"leaderboard",label:"Leaderboard",dropdown:[
    {id:"skater_lb",label:"Player LB"},
    {id:"goalie_lb",label:"Goalie LB"},
  ]},
];
const MODES=[{id:"rolling",label:"3-Year Rolling",file:"hockey_data_rolling.json"},{id:"2025",label:"2025-26",file:"hockey_data_2025.json"},{id:"2024",label:"2024-25",file:"hockey_data_2024.json"},{id:"2023",label:"2023-24",file:"hockey_data_2023.json"}];
const SK_COLS=[{key:"name",label:"Player"},{key:"team",label:"Tm"},{key:"position",label:"Pos"},{key:"gp",label:"GP"},{key:"toi_min",label:"TOI"},{key:"overall_pctile",label:"Overall"},{key:"5v5 Offense",label:"5v5 Off"},{key:"5v5 Defense",label:"5v5 Def"},{key:"Production",label:"Prod"},{key:"Power Play",label:"PP"},{key:"Penalty Kill",label:"PK"},{key:"Penalties",label:"Pen"},{key:"Competition",label:"Comp"},{key:"Teammates",label:"Tmts"}];
const GL_COLS=[{key:"name",label:"Goalie"},{key:"team",label:"Tm"},{key:"gp",label:"GP"},{key:"overall_pctile",label:"Overall"},{key:"5v5 GSAx",label:"5v5"},{key:"Penalty Kill",label:"PK"},{key:"High Danger GSAx",label:"HD"},{key:"Med Danger GSAx",label:"MD"},{key:"Low Danger GSAx",label:"LD"},{key:"Rebound Control",label:"Reb"},{key:"Ice Time",label:"TOI"}];

export default function HockeyApp(){
  const[data,setData]=useState(null);
  const[error,setError]=useState(null);
  const[loading,setLoading]=useState(true);
  const[tab,setTab]=useState("skater");
  const[openDropdown,setOpenDropdown]=useState(null);
  const[modeId,setModeId]=useState("rolling");
  const[selectedSkater,setSelectedSkater]=useState(null);
  const[selectedGoalie,setSelectedGoalie]=useState(null);
  const[posFilter,setPosFilter]=useState("F");
  const headshots=useHeadshots();
  const logos=useLogos();

  const curMode=MODES.find(m=>m.id===modeId)||MODES[0];

  useEffect(()=>{
    setLoading(true); setError(null);
    fetch('/'+curMode.file)
      .then(r=>{if(!r.ok)throw new Error(`HTTP ${r.status} - ${curMode.file} not found. Run: python3 hockey_pipeline.py ./data all ./output`);return r.json()})
      .then(d=>{setData(d);setLoading(false)})
      .catch(e=>{setError(e.message);setLoading(false)});
  },[curMode.file]);

  const skaters=useMemo(()=>data?.skaters||[],[data]);
  const goalies=useMemo(()=>data?.goalies||[],[data]);
  const skaterNames=useMemo(()=>skaters.map(s=>s.display_name).sort(),[skaters]);
  const goalieNames=useMemo(()=>goalies.map(g=>g.name).sort(),[goalies]);
  const filteredSkaters=useMemo(()=>posFilter?skaters.filter(s=>s.pos_group===posFilter):skaters,[skaters,posFilter]);
  const mode=data?.mode||"3-Year Rolling";

  useEffect(()=>{if(skaterNames.length>0&&(!selectedSkater||!skaterNames.includes(selectedSkater)))setSelectedSkater(skaterNames[0])},[skaterNames]);
  useEffect(()=>{if(goalieNames.length>0&&(!selectedGoalie||!goalieNames.includes(selectedGoalie)))setSelectedGoalie(goalieNames[0])},[goalieNames]);

  const curSkater=useMemo(()=>skaters.find(s=>s.display_name===selectedSkater),[skaters,selectedSkater]);
  const curGoalie=useMemo(()=>goalies.find(g=>g.name===selectedGoalie),[goalies,selectedGoalie]);

  const isLbTab=(id)=>id==="skater_lb"||id==="goalie_lb";
  const isTabActive=(id)=>id==="leaderboard"?isLbTab(tab):tab===id;

  const winWidth = useWindowWidth();
  const isMobile = winWidth < 640;

  return(
    <div style={{minHeight:"100vh",background:"#0a0f1a"}} onClick={()=>setOpenDropdown(null)}>
      <div style={{background:"#111827",borderBottom:"2px solid #f59e0b",padding:isMobile?"0 8px":"0 20px",display:"flex",alignItems:"stretch",position:"sticky",top:0,zIndex:100,boxShadow:"0 2px 12px rgba(0,0,0,0.4)",flexWrap:isMobile?"wrap":"nowrap"}}>
        {/* Left: brand (desktop only) + mode selector */}
        <div style={{display:"flex",alignItems:"stretch",gap:0,flexShrink:0}}>
          {!isMobile&&(
            <div style={{display:"flex",alignItems:"center",padding:"12px 20px 12px 0",borderRight:"1px solid #1e3a5f",marginRight:8}}>
              <div style={{fontSize:16,fontWeight:700,color:"#f8fafc",letterSpacing:"-0.02em",fontStyle:"italic"}}><span style={{color:"#3b82f6"}}>NHL</span> <span style={{color:"#f59e0b"}}>Player Cards</span></div>
            </div>
          )}
          <div style={{display:"flex",alignItems:"center",padding:isMobile?"0 6px 0 0":"0 16px",borderRight:isMobile?"none":"1px solid #1e3a5f"}}>
            <select value={modeId} onChange={e=>setModeId(e.target.value)}
              style={{padding:isMobile?"6px 10px":"8px 14px",background:"linear-gradient(135deg, #3b82f6 0%, #f59e0b 100%)",color:"#fff",border:"none",borderRadius:8,fontSize:isMobile?11:12,fontWeight:700,cursor:"pointer",outline:"none",boxShadow:"0 2px 8px rgba(0,0,0,0.2)"}}>
              {MODES.map(m=><option key={m.id} value={m.id} style={{background:"#0f172a",color:"#f8fafc"}}>{m.label}</option>)}
            </select>
          </div>
        </div>
        {/* Tabs: absolutely centered on desktop, scrollable flex on mobile */}
        <div style={isMobile?{
          display:"flex",alignItems:"stretch",overflowX:"auto",flex:1,
          msOverflowStyle:"none",scrollbarWidth:"none",
        }:{
          position:"absolute",left:"50%",transform:"translateX(-50%)",display:"flex",alignItems:"stretch",height:"100%",
        }}>
          {TABS.map(t=>(
            <div key={t.id} style={{position:"relative",display:"flex",alignItems:"stretch"}} onClick={e=>e.stopPropagation()}>
              <button
                onClick={()=>t.dropdown?setOpenDropdown(openDropdown===t.id?null:t.id):setTab(t.id)&&setOpenDropdown(null)}
                style={{padding:isMobile?"10px 10px":"16px 18px",fontSize:isMobile?11:12,fontWeight:isTabActive(t.id)?700:600,letterSpacing:"0.04em",whiteSpace:"nowrap",background:isTabActive(t.id)?"rgba(245,158,11,0.1)":"transparent",color:isTabActive(t.id)?"#f59e0b":"#94a3b8",border:"none",borderBottom:isTabActive(t.id)?"3px solid #f59e0b":"3px solid transparent",cursor:"pointer",transition:"all 0.2s",display:"flex",alignItems:"center",gap:6,fontFamily:"inherit"}}
              >
                {t.label.toUpperCase()}
                {t.dropdown&&<span style={{fontSize:8,marginLeft:2,display:"inline-block",transform:openDropdown===t.id?"rotate(180deg)":"rotate(0deg)",transition:"transform 0.2s"}}>▼</span>}
              </button>
              {t.dropdown&&openDropdown===t.id&&(
                <div style={{position:"absolute",top:"100%",left:0,background:"#1e293b",border:"1px solid #f59e0b",borderRadius:10,boxShadow:"0 12px 32px rgba(0,0,0,0.5)",minWidth:140,overflow:"hidden",zIndex:200}}>
                  {t.dropdown.map((sub,idx)=>(
                    <button key={sub.id} onClick={()=>{setTab(sub.id);setOpenDropdown(null);}}
                      style={{width:"100%",padding:"12px 18px",fontSize:13,fontWeight:tab===sub.id?700:500,color:tab===sub.id?"#f59e0b":"#cbd5e1",background:tab===sub.id?"rgba(245,158,11,0.15)":"transparent",border:"none",borderBottom:idx<t.dropdown.length-1?"1px solid #334155":"none",cursor:"pointer",textAlign:"left",fontFamily:"inherit",transition:"all 0.15s"}}
                      onMouseEnter={e=>{if(tab!==sub.id)e.target.style.background="rgba(59,130,246,0.1)"}}
                      onMouseLeave={e=>{if(tab!==sub.id)e.target.style.background="transparent"}}
                    >{sub.label}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {/* Right: player selector + position filter + stats */}
        <div style={{display:"flex",alignItems:"center",gap:isMobile?8:16,padding:isMobile?"6px 4px":"12px 0",marginLeft:isMobile?0:"auto",width:isMobile?"100%":"auto",borderTop:isMobile?"1px solid #1e3a5f":"none",flexWrap:"wrap"}}>
          {(tab==="skater"||tab==="goalie")&&(
            <SearchableSelect
              value={tab==="goalie"?selectedGoalie||"":selectedSkater||""}
              options={tab==="goalie"?goalieNames:skaterNames}
              onChange={name=>tab==="goalie"?setSelectedGoalie(name):setSelectedSkater(name)}
              placeholder={`Search ${tab==="goalie"?"goalie":"skater"}…`}
              style={{padding:"8px 12px",background:"#0f172a",border:"1px solid #1e3a5f",borderRadius:6,color:"#f8fafc",fontSize:13,minWidth:isMobile?0:200,maxWidth:isMobile?"100%":280,width:isMobile?"100%":"auto",flexShrink:1}}
            />
          )}
          {tab==="skater_lb"&&(
            <div style={{display:"flex",gap:4}}>
              {[["F","Fwd"],["D","Def"],["","All"]].map(([v,l])=>(
                <button key={v} onClick={()=>setPosFilter(v)} style={{padding:isMobile?"6px 10px":"6px 14px",fontSize:11,fontWeight:posFilter===v?700:500,background:posFilter===v?"rgba(245,158,11,0.15)":"transparent",color:posFilter===v?"#f59e0b":"#94a3b8",border:"1px solid #1e3a5f",borderRadius:6,cursor:"pointer",transition:"all 0.15s"}}>{l}</button>
              ))}
            </div>
          )}
          {!isMobile&&<div style={{fontSize:10,color:"#64748b",letterSpacing:"0.03em",borderLeft:"1px solid #1e3a5f",paddingLeft:16}}>{mode} | {skaters.length} skaters | {goalies.length} goalies</div>}
        </div>
      </div>

      {error ? (
        <div style={{color:"#f59e0b",padding:60,textAlign:"center",fontSize:14,lineHeight:1.8}}>
          Failed to load data: {error}<br/><br/>
          <span style={{color:"#94a3b8",fontSize:12}}>Run: python3 hockey_pipeline.py ./data all ./output</span>
        </div>
      ) : (!data||loading) ? (
        <div style={{color:"#64748b",padding:60,textAlign:"center",fontSize:14}}>Loading {curMode.label}...</div>
      ) : (
        <div style={{padding:isMobile?"12px 8px":24,maxWidth:tab.includes("lb")?1200:640,margin:"0 auto"}}>
          {tab==="skater"&&<><Card player={curSkater} type="skater" trends={data.skater_trends} mode={mode} headshots={headshots} logos={logos}/><WeightTable player={curSkater} type="skater"/></>}
          {tab==="goalie"&&<><Card player={curGoalie} type="goalie" trends={data.goalie_trends} mode={mode} headshots={headshots} logos={logos}/><WeightTable player={curGoalie} type="goalie"/></>}
          {tab==="skater_lb"&&<HockeyLeaderboard players={filteredSkaters} columns={SK_COLS} sortDefault="overall_pctile"/>}
          {tab==="goalie_lb"&&<HockeyLeaderboard players={goalies} columns={GL_COLS} sortDefault="overall_pctile"/>}
        </div>
      )}
    </div>
  );
}
