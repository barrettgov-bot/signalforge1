import {NextResponse} from "next/server";
import webpush from "web-push";

type FomoAlert={eventId?:string;alertType?:string;token?:string;tokenAddress?:string;chain?:string;chainId?:string|number;ts?:string;timestamp?:string};
type Market={price:number;liquidity:number;volume1h:number;change5m:number;change1h:number;buys1h:number;sells1h:number};

function store(){return{base:process.env["kv_KV_REST_API_URL"]||process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL,token:process.env["kv_KV_REST_API_TOKEN"]||process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN}}
async function redis(args:unknown[]){const{base,token}=store();if(!base||!token)return null;const r=await fetch(base,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(args)});return r.ok?r.json():null}
async function push(title:string,body:string,tag:string){const pub=process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,priv=process.env.VAPID_PRIVATE_KEY,subject=process.env.VAPID_SUBJECT;if(!pub||!priv||!subject)return;webpush.setVapidDetails(subject,pub,priv);const index=await redis(["SMEMBERS","signalforge:push:index"]);for(const subKey of Array.isArray(index?.result)?index.result:[]){const d=await redis(["GET",subKey]);if(!d?.result)continue;try{await webpush.sendNotification(JSON.parse(d.result),JSON.stringify({title,body,url:"/",tag}))}catch{}}}

export async function GET(request:Request){
 const secret=process.env.CRON_SECRET;
 if(!secret||request.headers.get("authorization")!==`Bearer ${secret}`)return NextResponse.json({ok:false,error:"unauthorized"},{status:401});
 const apiKey=process.env.FOMO_API_KEY;
 if(!apiKey)return NextResponse.json({ok:false,error:"fomo_not_configured"},{status:503});
 const sinceRaw=await redis(["GET","signalforge:fomo:last-seen"]);
 const since=sinceRaw?.result||new Date(Date.now()-10*60*1000).toISOString();
 const r=await fetch(`https://api.fomoapi.io/v2/alerts?limit=100&since=${encodeURIComponent(since)}`,{cache:"no-store",headers:{authorization:"Bearer "+apiKey}});
 if(!r.ok)return NextResponse.json({ok:false,error:"fomo_unavailable",status:r.status},{status:502});
 const d=await r.json();
 const rows:FomoAlert[]=Array.isArray(d?.alerts)?d.alerts:Array.isArray(d?.items)?d.items:[];
 const listings=rows.filter(x=>String(x.alertType||"").toLowerCase()==="listing");
 let fresh=0;
 for(const x of listings){
  const id=x.eventId||`${x.chain||x.chainId}:${x.tokenAddress}:${x.ts||x.timestamp||""}`;
  const dedupe=`signalforge:fomo:listing:${id}`;
  if((await redis(["GET",dedupe]))?.result)continue;
  await redis(["SET",dedupe,"1","EX",604800]);
  const token=String(x.token||"TOKEN").toUpperCase();
  const address=x.tokenAddress||"";
  const chain=x.chain||String(x.chainId||"unknown");
  const detectedAt=new Date().toISOString();
  const eventTime=x.ts||x.timestamp||null;
  let market:Market|null=null;
  if(address&&chain!=="unknown"){
   try{
    const q=await fetch(`https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`,{cache:"no-store"});
    if(q.ok){
     const pairs=await q.json();
     const p=Array.isArray(pairs)?pairs.sort((a:any,b:any)=>(Number(b?.liquidity?.usd)||0)-(Number(a?.liquidity?.usd)||0))[0]:null;
     if(p)market={price:Number(p.priceUsd)||0,liquidity:Number(p.liquidity?.usd)||0,volume1h:Number(p.volume?.h1)||0,change5m:Number(p.priceChange?.m5)||0,change1h:Number(p.priceChange?.h1)||0,buys1h:Number(p.txns?.h1?.buys)||0,sells1h:Number(p.txns?.h1?.sells)||0};
    }
   }catch{}
  }
  const event={eventId:id,token,address,chain,detectedAt,eventTime,source:"FOMO",status:"NEW ON FOMO",market};
  await redis(["LPUSH","signalforge:fomo:listings",JSON.stringify(event)]);
  if(address)await redis(["SADD","signalforge:fomo:active",JSON.stringify({eventId:id,token,address,chain,detectedAt,initialPrice:market?.price||0})]);
  await redis(["LTRIM","signalforge:fomo:listings",0,199]);
  const marketText=market?`liq $${Math.round(market.liquidity).toLocaleString()} · 5m ${market.change5m>=0?"+":""}${market.change5m.toFixed(1)}%`:"market data loading";
  await push(`🆕 NEW ON FOMO: $${event.token}`,`${event.chain} · ${marketText}`,`fomo-listing-${id}`);
  fresh++;
 }
 const active=await redis(["SMEMBERS","signalforge:fomo:active"]);
 for(const raw of Array.isArray(active?.result)?active.result:[]){try{const a=JSON.parse(raw) as {eventId:string;token:string;address:string;chain:string;detectedAt:string;initialPrice:number};const age=Math.floor((Date.now()-new Date(a.detectedAt).getTime())/60000);if(age>65){await redis(["SREM","signalforge:fomo:active",raw]);continue}const due=[5,15,30,60].filter(h=>age>=h);if(!due.length)continue;let horizon:number|undefined;for(const h of due){if(!(await redis(["GET",`signalforge:fomo:snapshot:${a.eventId}:${h}`]))?.result){horizon=h;break}}if(!horizon)continue;const snapKey=`signalforge:fomo:snapshot:${a.eventId}:${horizon}`;try{const q=await fetch(`https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(a.chain)}/${encodeURIComponent(a.address)}`,{cache:"no-store"});if(q.ok){const pairs=await q.json(),p=Array.isArray(pairs)?pairs.sort((x:any,y:any)=>(Number(y?.liquidity?.usd)||0)-(Number(x?.liquidity?.usd)||0))[0]:null;if(p){const price=Number(p.priceUsd)||0;if(a.initialPrice<=0&&price>0){a.initialPrice=price;await redis(["SREM","signalforge:fomo:active",raw]);await redis(["SADD","signalforge:fomo:active",JSON.stringify(a)])}const snapshot={eventId:a.eventId,token:a.token,address:a.address,chain:a.chain,horizon,ageMinutes:age,time:new Date().toISOString(),price,returnPct:a.initialPrice>0&&price>0?(price-a.initialPrice)/a.initialPrice*100:null,liquidity:Number(p.liquidity?.usd)||0,volume1h:Number(p.volume?.h1)||0,buys1h:Number(p.txns?.h1?.buys)||0,sells1h:Number(p.txns?.h1?.sells)||0};const flow=snapshot.buys1h+snapshot.sells1h>0?snapshot.buys1h/(snapshot.buys1h+snapshot.sells1h):0.5;const strength=Math.max(0,Math.min(100,Math.round((snapshot.liquidity>=50000?25:snapshot.liquidity>=20000?15:5)+(snapshot.volume1h>=50000?25:snapshot.volume1h>=10000?15:5)+(flow>=0.65?25:flow>=0.55?15:5)+((snapshot.returnPct??0)>=10?25:(snapshot.returnPct??0)>=0?15:5))));const state=strength>=75?"STRENGTHENING":strength>=50?"DEVELOPING":strength>=30?"MIXED":"WEAKENING";Object.assign(snapshot,{strength,state});await redis(["LPUSH",`signalforge:fomo:timeline:${a.eventId}`,JSON.stringify(snapshot)]);await redis(["EXPIRE",`signalforge:fomo:timeline:${a.eventId}`,604800]);await redis(["SET",snapKey,"1","EX",604800]);if(horizon===5||horizon===15||horizon===30||horizon===60){const ret=snapshot.returnPct;const meaningful=strength>=75||strength<=30||(ret!==null&&Math.abs(ret)>=15);if(meaningful){const direction=ret===null?"":` · ${ret>=0?"+":""}${ret.toFixed(1)}% since detection`;const alertKind=strength<=30||(ret!==null&&ret<=-15)?"⚠️ RISK WATCH":"🔥 MOMENTUM WATCH";await push(`${alertKind} · FOMO ${horizon}M: ${a.token}`,`${state} · strength ${strength}/100${direction} · liq ${Math.round(snapshot.liquidity).toLocaleString()} · buys/sells ${snapshot.buys1h}/${snapshot.sells1h}`,`fomo-followup-${a.eventId}-${horizon}`)}}}}}catch{}}catch{} }
 await redis(["SET","signalforge:fomo:last-seen",new Date().toISOString(),"EX",604800]);
 return NextResponse.json({ok:true,checked:rows.length,listings:listings.length,newListings:fresh,since});
}
