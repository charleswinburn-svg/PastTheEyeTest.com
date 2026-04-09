import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend, ReferenceLine } from "recharts";

const BIN_COLORS={"0-10":"#08306B","10-25":"#2171B5","25-45":"#6BAED6","45-55":"#D9D9D9","55-75":"#FC9272","75-90":"#FB6A4A","90-100":"#CB181D"};
const pctToBin=p=>{if(p==null||!isFinite(p))return"NA";if(p>=90)return"90-100";if(p>=75)return"75-90";if(p>=55)return"55-75";if(p>=45)return"45-55";if(p>=25)return"25-45";if(p>=10)return"10-25";return"0-10"};
const binColor=p=>BIN_COLORS[pctToBin(p)]||"#444";
const textOnBin=p=>{if(p==null)return"#aaa";return(p<25||p>=75)?"#fff":"#111"};
const LOGO_FALLBACK=a=>{const m={"L.A":"LAK","N.J":"NJD","S.J":"SJS","T.B":"TBL"};const nhl=m[a]||a;return`/nhl-assets/logos/nhl/svg/${nhl}_light.svg`};
const FLAG=c=>c?`/flag-assets/w80/${c.toLowerCase()}.png`:null;

const NST_TO_NHL={"L.A":"LAK","N.J":"NJD","S.J":"SJS","T.B":"TBL"};

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
    <div style={{display:"flex",alignItems:"center",marginBottom:isOverall?12:5,gap:8}}>
      <div style={{width:135,textAlign:"right",fontSize:isOverall?13:12,fontWeight:isOverall?800:500,color:isOverall?"#fff":"#bbb",flexShrink:0}}>{label}{weight===0&&pctile==null?" (N/A)":""}</div>
      <div style={{flex:1,position:"relative",height:isOverall?28:22,background:"#1e1e1e",borderRadius:4,border:isOverall?"2px solid #fff":"1px solid #2a2a2a",overflow:"hidden"}}>
        <div style={{width:`${w}%`,height:"100%",background:binColor(pctile),borderRadius:3,transition:"width 0.6s cubic-bezier(0.25,0.46,0.45,0.94)"}}/>
      </div>
      <div style={{width:36,textAlign:"right",fontSize:isOverall?14:12,fontWeight:isOverall?800:600,color:pctile!=null?"#fff":"#555",fontFamily:"'DM Mono',monospace",flexShrink:0}}>{pctile!=null?Math.round(pctile):"—"}</div>
    </div>
  );
}

function PlayerHeader({name,team,subtitle,olympicCountry,headshotUrl,logoSrc}){
  return(
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 20px 8px",gap:16}}>
      <img crossOrigin="anonymous" src={logoSrc||LOGO_FALLBACK(team)} alt={team} style={{width:64,height:64,objectFit:"contain",filter:"drop-shadow(0 2px 8px rgba(0,0,0,0.5))"}} onError={e=>{e.target.style.display="none"}}/>
      <div style={{flex:1,textAlign:"center"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
          <span style={{fontSize:22,fontWeight:800,color:"#fff",letterSpacing:"-0.02em"}}>{name}</span>
          {FLAG(olympicCountry)&&<img crossOrigin="anonymous" src={FLAG(olympicCountry)} alt="" style={{height:16,border:"1px solid #555",borderRadius:2}}/>}
        </div>
        <div style={{fontSize:11,color:"#888",marginTop:2,letterSpacing:"0.04em"}}>{subtitle}</div>
      </div>
      <div style={{width:64,height:64,borderRadius:"50%",background:"#222",overflow:"hidden",border:"2px solid #333",flexShrink:0,position:"relative"}}>
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
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a"/>
          <XAxis dataKey="season" tick={{fill:"#888",fontSize:11}} tickLine={false} axisLine={{stroke:"#333"}}/>
          <YAxis domain={[0,100]} ticks={[0,25,50,75,100]} tick={{fill:"#666",fontSize:10}} tickLine={false} axisLine={false} width={28}/>
          {lines.map((key,i)=>(
            <Line key={key} type="monotone" dataKey={key} stroke={colors[i]} strokeWidth={2.5} dot={{r:4,fill:colors[i],stroke:"#111",strokeWidth:2}}/>
          ))}
          <Legend formatter={v=>labels[lines.indexOf(v)]||v} wrapperStyle={{fontSize:10,color:"#888",paddingTop:4}}/>
          <ReferenceLine y={50} stroke="#444" strokeDasharray="4 4"/>
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
      i.onload=()=>{ctx.drawImage(i,0,0,c.width,c.height);resolve(c.toDataURL("image/png"));};
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
    const canvas=await html2canvas(cardRef.current,{backgroundColor:"#0d0d0d",scale:2,logging:false});
    const link=document.createElement("a");
    link.download=`${pname.replace(/\s+/g,"_")}_card.png`;
    link.href=canvas.toDataURL("image/png");
    link.click();
    originals.forEach(({img,orig})=>{img.src=orig});
  },[pname]);
  if(!player)return <div style={{color:"#666",padding:40,textAlign:"center"}}>Select a player</div>;
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
      <div ref={cardRef} style={{background:"#151515",borderRadius:12,border:"1px solid #2a2a2a",overflow:"hidden",boxShadow:"0 4px 24px rgba(0,0,0,0.4)",maxWidth:600,margin:"0 auto"}}>
        <PlayerHeader name={pname} team={player.team} subtitle={subtitle} olympicCountry={player.olympic_country} headshotUrl={headshotUrl} logoSrc={logos?.[player.team]}/>
        <div style={{padding:"8px 16px 4px"}}>
          <PercentileBar label="Overall Impact" pctile={player.overall_pctile} isOverall={true}/>
          <div style={{height:4}}/>
          {cats.map(([name,cat])=><PercentileBar key={name} label={name} pctile={cat.pctile} weight={cat.weight} isOverall={false}/>)}
        </div>
        {showTrend&&<TrendChart data={trendData}
          lines={type==="goalie"?["hd_gsax","md_gsax","ld_gsax"]:["offense","defense","overall"]}
          colors={type==="goalie"?["#DC2626","#999","#2563EB"]:["#FC9272","#6BAED6","#fff"]}
          labels={type==="goalie"?["High Danger","Med Danger","Low Danger"]:["5v5 Offense","5v5 Defense","Overall"]}/>}
        <div style={{padding:"6px 16px 10px",display:"flex",justifyContent:"space-between",fontSize:10,color:"#555"}}>
          <span>{mode==="3-Year Rolling"?"3-Year Rolling Weighted":mode} | {type==="goalie"?"All goalies":`${player.pos_group} only`}</span>
          <span style={{fontStyle:"italic"}}>PastTheEyeTest | NST + EH</span>
        </div>
      </div>
      <div style={{maxWidth:600,margin:"8px auto 0",textAlign:"right"}}>
        <button onClick={saveCard} style={{padding:"6px 16px",fontSize:11,fontWeight:600,background:"#1a1a1a",color:"#aaa",border:"1px solid #333",borderRadius:6,cursor:"pointer",transition:"all 0.15s"}}
          onMouseEnter={e=>{e.target.style.background="#d22d49";e.target.style.color="#fff";e.target.style.borderColor="#d22d49"}}
          onMouseLeave={e=>{e.target.style.background="#1a1a1a";e.target.style.color="#aaa";e.target.style.borderColor="#333"}}>
          Save as PNG
        </button>
      </div>
    </div>
  );
}

function WeightTable({player,type}){
  if(!player)return null;
  const cats=Object.entries(player.categories);
  const tdS={padding:"5px 8px",fontSize:11,borderBottom:"1px solid #1e1e1e"};
  return(
    <div style={{marginTop:16,maxWidth:600,margin:"16px auto 0"}}>
      <div style={{fontSize:13,fontWeight:700,color:"#aaa",marginBottom:8}}>Weight Breakdown</div>
      <table style={{width:"100%",borderCollapse:"collapse",background:"#111",borderRadius:8,overflow:"hidden"}}>
        <thead><tr>
          <th style={{textAlign:"left",padding:"6px 8px",borderBottom:"2px solid #333",color:"#888",fontSize:11}}>Category</th>
          <th style={{textAlign:"center",padding:"6px 8px",borderBottom:"2px solid #333",color:"#888",fontSize:11}}>Pctile</th>
          {type==="goalie"&&<th style={{textAlign:"center",padding:"6px 8px",borderBottom:"2px solid #333",color:"#888",fontSize:11}}>Per 60</th>}
          <th style={{textAlign:"right",padding:"6px 8px",borderBottom:"2px solid #333",color:"#888",fontSize:11}}>Weight</th>
        </tr></thead>
        <tbody>
          <tr style={{background:"#1a1a1a"}}>
            <td style={{...tdS,fontWeight:700,color:"#fff"}}>OVERALL IMPACT</td>
            <td style={{...tdS,textAlign:"center",fontWeight:700,color:"#fff"}}>{player.overall_pctile?.toFixed(1)}</td>
            {type==="goalie"&&<td style={{...tdS,textAlign:"center",color:"#666"}}>—</td>}
            <td style={{...tdS,textAlign:"right",color:"#888"}}>100%</td>
          </tr>
          {cats.map(([name,cat],i)=>{
            const rk={"5v5 GSAx":"ev5_gsax","Penalty Kill":"pk_gsax","High Danger GSAx":"hd_gsax","Med Danger GSAx":"md_gsax","Low Danger GSAx":"ld_gsax","Rebound Control":"reb"}[name];
            return(
              <tr key={name} style={{background:i%2===0?"#111":"#161616"}}>
                <td style={{...tdS,color:"#ccc"}}>{name}</td>
                <td style={{...tdS,textAlign:"center",color:cat.pctile!=null?"#ddd":"#555"}}>{cat.pctile!=null?cat.pctile.toFixed(1):"N/A"}</td>
                {type==="goalie"&&<td style={{...tdS,textAlign:"center",color:"#888"}}>{rk&&player.raw_per60?.[rk]!=null?player.raw_per60[rk]:name==="Ice Time"?`${player.gp_share}%`:"—"}</td>}
                <td style={{...tdS,textAlign:"right",color:"#888"}}>{cat.weight===0?"N/A":`${(cat.weight*100).toFixed(1)}%`}</td>
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
  const thS={padding:"8px 6px",textAlign:"center",cursor:"pointer",fontSize:10,fontWeight:700,color:"#aaa",borderBottom:"2px solid #333",whiteSpace:"nowrap",userSelect:"none",position:"sticky",top:0,background:"#151515",zIndex:2};
  const tdS={padding:"5px 6px",textAlign:"center",fontSize:11,borderBottom:"1px solid #1e1e1e",whiteSpace:"nowrap"};
  return(
    <div>
      <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search player or team..."
        style={{width:"100%",maxWidth:300,padding:"8px 12px",background:"#1a1a1a",border:"1px solid #333",borderRadius:6,color:"#ddd",fontSize:13,marginBottom:12,outline:"none"}}/>
      <div style={{overflowX:"auto",borderRadius:8,border:"1px solid #2a2a2a",maxHeight:"70vh",overflowY:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse",background:"#111"}}>
          <thead><tr>{columns.map(c=><th key={c.key} onClick={()=>toggle(c.key)} style={thS}>{c.label} {sortCol===c.key?(sortDir==="desc"?"▾":"▴"):""}</th>)}</tr></thead>
          <tbody>{filtered.map((p,i)=>(
            <tr key={i} style={{background:i%2===0?"#111":"#161616"}}>
              {columns.map(c=>{
                let val,st={...tdS};
                if(c.key==="name"){val=p.display_name||p.name;st.textAlign="left";st.fontWeight=600;st.color="#ddd";st.position="sticky";st.left=0;st.background=i%2===0?"#111":"#161616";st.zIndex=1}
                else if(c.key==="team"){val=p.team;st.color="#888"}
                else if(c.key==="position"){val=p.position;st.color="#888"}
                else if(c.key==="gp"){val=p.gp;st.color="#888"}
                else if(c.key==="toi_min"){val=p.toi_min;st.color="#888"}
                else if(c.key==="overall_pctile"){val=p.overall_pctile!=null?p.overall_pctile.toFixed(1):"—";st.background=binColor(p.overall_pctile);st.color=textOnBin(p.overall_pctile);st.fontWeight=700}
                else{const cat=p.categories[c.key];val=cat?.pctile!=null?cat.pctile.toFixed(1):"—";st.color=cat?.pctile!=null?"#ccc":"#555"}
                return <td key={c.key} style={st}>{val}</td>;
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div style={{fontSize:10,color:"#555",marginTop:8}}>{filtered.length} players</div>
    </div>
  );
}

const TABS=[{id:"skater",label:"Player Card"},{id:"goalie",label:"Goalie Card"},{id:"skater_lb",label:"Leaderboard"},{id:"goalie_lb",label:"Goalie LB"}];
const MODES=[{id:"rolling",label:"3-Year Rolling",file:"hockey_data_rolling.json"},{id:"2025",label:"2025-26",file:"hockey_data_2025.json"},{id:"2024",label:"2024-25",file:"hockey_data_2024.json"},{id:"2023",label:"2023-24",file:"hockey_data_2023.json"}];
const SK_COLS=[{key:"name",label:"Player"},{key:"team",label:"Tm"},{key:"position",label:"Pos"},{key:"gp",label:"GP"},{key:"toi_min",label:"TOI"},{key:"overall_pctile",label:"Overall"},{key:"5v5 Offense",label:"5v5 Off"},{key:"5v5 Defense",label:"5v5 Def"},{key:"Production",label:"Prod"},{key:"Power Play",label:"PP"},{key:"Penalty Kill",label:"PK"},{key:"Penalties",label:"Pen"},{key:"Competition",label:"Comp"},{key:"Teammates",label:"Tmts"}];
const GL_COLS=[{key:"name",label:"Goalie"},{key:"team",label:"Tm"},{key:"gp",label:"GP"},{key:"overall_pctile",label:"Overall"},{key:"5v5 GSAx",label:"5v5"},{key:"Penalty Kill",label:"PK"},{key:"High Danger GSAx",label:"HD"},{key:"Med Danger GSAx",label:"MD"},{key:"Low Danger GSAx",label:"LD"},{key:"Rebound Control",label:"Reb"},{key:"Ice Time",label:"TOI"}];

export default function HockeyApp(){
  const[data,setData]=useState(null);
  const[error,setError]=useState(null);
  const[loading,setLoading]=useState(true);
  const[tab,setTab]=useState("skater");
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

  return(
    <div style={{minHeight:"100vh",background:"#0d0d0d"}}>
      <div style={{background:"#111",borderBottom:"1px solid #222",padding:"12px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
        <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <div style={{fontSize:18,fontWeight:800,color:"#fff",letterSpacing:"-0.03em"}}><span style={{color:"#d22d49"}}>NHL</span> Player Cards</div>
          <div style={{width:1,height:24,background:"#333"}}/>
          <select value={modeId} onChange={e=>setModeId(e.target.value)}
            style={{padding:"6px 10px",background:"#d22d49",color:"#fff",border:"none",borderRadius:6,fontSize:12,fontWeight:700,cursor:"pointer",outline:"none"}}>
            {MODES.map(m=><option key={m.id} value={m.id} style={{background:"#1a1a1a",color:"#ddd"}}>{m.label}</option>)}
          </select>
          <div style={{width:1,height:24,background:"#333"}}/>
          <div style={{display:"flex",gap:2,flexWrap:"wrap"}}>
            {TABS.map(t=>(
              <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"6px 14px",fontSize:12,fontWeight:tab===t.id?700:500,background:tab===t.id?"#333":"transparent",color:tab===t.id?"#fff":"#888",border:"none",borderRadius:6,cursor:"pointer",transition:"all 0.15s"}}>{t.label}</button>
            ))}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          {(tab==="skater"||tab==="goalie")&&(
            <select value={tab==="goalie"?selectedGoalie||"":selectedSkater||""}
              onChange={e=>tab==="goalie"?setSelectedGoalie(e.target.value):setSelectedSkater(e.target.value)}
              style={{padding:"6px 10px",background:"#1a1a1a",border:"1px solid #333",borderRadius:6,color:"#ddd",fontSize:13,outline:"none",minWidth:200,maxWidth:280}}>
              {(tab==="goalie"?goalieNames:skaterNames).map(n=><option key={n} value={n}>{n}</option>)}
            </select>
          )}
          {tab==="skater_lb"&&(
            <div style={{display:"flex",gap:4}}>
              {[["F","Forwards"],["D","Defensemen"],["","All"]].map(([v,l])=>(
                <button key={v} onClick={()=>setPosFilter(v)} style={{padding:"5px 12px",fontSize:11,fontWeight:posFilter===v?700:500,background:posFilter===v?"#333":"transparent",color:posFilter===v?"#fff":"#888",border:"1px solid #333",borderRadius:4,cursor:"pointer"}}>{l}</button>
              ))}
            </div>
          )}
          <div style={{fontSize:9,color:"#555",letterSpacing:"0.04em"}}>{mode} | {skaters.length} skaters | {goalies.length} goalies</div>
        </div>
      </div>

      {error ? (
        <div style={{color:"#d22d49",padding:60,textAlign:"center",fontSize:14,lineHeight:1.8}}>
          Failed to load data: {error}<br/><br/>
          <span style={{color:"#888",fontSize:12}}>Run: python3 hockey_pipeline.py ./data all ./output</span>
        </div>
      ) : (!data||loading) ? (
        <div style={{color:"#666",padding:60,textAlign:"center",fontSize:14}}>Loading {curMode.label}...</div>
      ) : (
        <div style={{padding:24,maxWidth:tab.includes("lb")?1200:640,margin:"0 auto"}}>
          {tab==="skater"&&<><Card player={curSkater} type="skater" trends={data.skater_trends} mode={mode} headshots={headshots} logos={logos}/><WeightTable player={curSkater} type="skater"/></>}
          {tab==="goalie"&&<><Card player={curGoalie} type="goalie" trends={data.goalie_trends} mode={mode} headshots={headshots} logos={logos}/><WeightTable player={curGoalie} type="goalie"/></>}
          {tab==="skater_lb"&&<HockeyLeaderboard players={filteredSkaters} columns={SK_COLS} sortDefault="overall_pctile"/>}
          {tab==="goalie_lb"&&<HockeyLeaderboard players={goalies} columns={GL_COLS} sortDefault="overall_pctile"/>}
        </div>
      )}
    </div>
  );
}
