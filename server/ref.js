// Reference data and pure helpers shared by the server and the browser (served at /shared/ref.js).
// No Node imports here.

export const AIRPORTS = [
["KTEB","Teterboro","NJ",40.850,-74.061,"America/New_York"],["KHPN","Westchester County","NY",41.067,-73.708,"America/New_York"],["KMMU","Morristown","NJ",40.799,-74.415,"America/New_York"],
["KFRG","Republic, Farmingdale","NY",40.729,-73.413,"America/New_York"],["KISP","Long Island MacArthur","NY",40.795,-73.100,"America/New_York"],["KJFK","New York JFK","NY",40.640,-73.779,"America/New_York"],
["KEWR","Newark Liberty","NJ",40.692,-74.169,"America/New_York"],["KFOK","Gabreski, Westhampton","NY",40.844,-72.632,"America/New_York"],["KHTO","East Hampton","NY",40.960,-72.252,"America/New_York"],
["KBDL","Bradley, Hartford","CT",41.939,-72.683,"America/New_York"],["KBED","Hanscom Field, Bedford","MA",42.470,-71.289,"America/New_York"],["KBOS","Boston Logan","MA",42.364,-71.005,"America/New_York"],
["KACK","Nantucket","MA",41.253,-70.060,"America/New_York"],["KMVY","Martha's Vineyard","MA",41.393,-70.615,"America/New_York"],["KHYA","Hyannis","MA",41.669,-70.280,"America/New_York"],
["KPVD","Providence","RI",41.724,-71.428,"America/New_York"],["KPHL","Philadelphia Intl","PA",39.872,-75.241,"America/New_York"],["KPNE","Northeast Philadelphia","PA",40.082,-75.011,"America/New_York"],
["KBWI","Baltimore/Washington","MD",39.176,-76.668,"America/New_York"],["KIAD","Washington Dulles","VA",38.947,-77.460,"America/New_York"],["KDCA","Reagan National","VA",38.852,-77.038,"America/New_York"],
["KJYO","Leesburg Executive","VA",39.078,-77.558,"America/New_York"],["KCLT","Charlotte Douglas","NC",35.214,-80.943,"America/New_York"],["KRDU","Raleigh-Durham","NC",35.878,-78.787,"America/New_York"],
["KCHS","Charleston","SC",32.899,-80.041,"America/New_York"],["KSAV","Savannah/Hilton Head","GA",32.127,-81.202,"America/New_York"],["KHXD","Hilton Head Island","SC",32.224,-80.697,"America/New_York"],
["KPDK","Peachtree-DeKalb, Atlanta","GA",33.876,-84.302,"America/New_York"],["KATL","Atlanta Hartsfield","GA",33.637,-84.428,"America/New_York"],["KCGF","Cuyahoga County, Cleveland","OH",41.565,-81.486,"America/New_York"],
["KLUK","Lunken, Cincinnati","OH",39.103,-84.419,"America/New_York"],["KPBI","Palm Beach Intl","FL",26.683,-80.096,"America/New_York"],["KBCT","Boca Raton","FL",26.378,-80.108,"America/New_York"],
["KFXE","Fort Lauderdale Exec","FL",26.197,-80.171,"America/New_York"],["KFLL","Fort Lauderdale Intl","FL",26.072,-80.153,"America/New_York"],["KOPF","Miami-Opa Locka Exec","FL",25.907,-80.278,"America/New_York"],
["KMIA","Miami Intl","FL",25.795,-80.290,"America/New_York"],["KTMB","Miami Executive","FL",25.648,-80.433,"America/New_York"],["KAPF","Naples","FL",26.152,-81.775,"America/New_York"],
["KRSW","Southwest Florida, Fort Myers","FL",26.536,-81.755,"America/New_York"],["KTPA","Tampa Intl","FL",27.976,-82.533,"America/New_York"],["KSRQ","Sarasota-Bradenton","FL",27.395,-82.554,"America/New_York"],
["KORL","Orlando Executive","FL",28.545,-81.333,"America/New_York"],["KMCO","Orlando Intl","FL",28.429,-81.309,"America/New_York"],["KJAX","Jacksonville","FL",30.494,-81.688,"America/New_York"],
["KEYW","Key West","FL",24.556,-81.760,"America/New_York"],["KSUA","Witham Field, Stuart","FL",27.182,-80.221,"America/New_York"],["KVRB","Vero Beach","FL",27.656,-80.418,"America/New_York"],
["KDTW","Detroit Metro","MI",42.212,-83.353,"America/Detroit"],["KPTK","Oakland County, Pontiac","MI",42.665,-83.420,"America/Detroit"],
["KBNA","Nashville","TN",36.124,-86.678,"America/Chicago"],["KPWK","Chicago Executive","IL",42.114,-87.902,"America/Chicago"],["KMDW","Chicago Midway","IL",41.786,-87.752,"America/Chicago"],
["KORD","Chicago O'Hare","IL",41.978,-87.905,"America/Chicago"],["KDPA","DuPage","IL",41.907,-88.248,"America/Chicago"],["KMSP","Minneapolis-St Paul","MN",44.882,-93.222,"America/Chicago"],
["KFCM","Flying Cloud","MN",44.827,-93.457,"America/Chicago"],["KSUS","Spirit of St. Louis","MO",38.662,-90.652,"America/Chicago"],["KMKC","Kansas City Downtown","MO",39.123,-94.593,"America/Chicago"],
["KDAL","Dallas Love Field","TX",32.847,-96.852,"America/Chicago"],["KADS","Addison","TX",32.969,-96.836,"America/Chicago"],["KDFW","Dallas/Fort Worth","TX",32.897,-97.038,"America/Chicago"],
["KHOU","Houston Hobby","TX",29.645,-95.279,"America/Chicago"],["KIAH","Houston Bush","TX",29.984,-95.341,"America/Chicago"],["KSGR","Sugar Land","TX",29.622,-95.657,"America/Chicago"],
["KAUS","Austin-Bergstrom","TX",30.194,-97.670,"America/Chicago"],["KSAT","San Antonio","TX",29.534,-98.470,"America/Chicago"],["KMSY","New Orleans","LA",29.993,-90.258,"America/Chicago"],
["KAPA","Centennial, Denver","CO",39.570,-104.849,"America/Denver"],["KBJC","Rocky Mountain Metro","CO",39.909,-105.117,"America/Denver"],["KDEN","Denver Intl","CO",39.862,-104.673,"America/Denver"],
["KASE","Aspen-Pitkin County","CO",39.223,-106.869,"America/Denver"],["KEGE","Eagle County (Vail)","CO",39.643,-106.918,"America/Denver"],["KTEX","Telluride","CO",37.954,-107.909,"America/Denver"],
["KMTJ","Montrose","CO",38.510,-107.894,"America/Denver"],["KJAC","Jackson Hole","WY",43.607,-110.738,"America/Denver"],["KBZN","Bozeman Yellowstone","MT",45.778,-111.153,"America/Denver"],
["KSLC","Salt Lake City","UT",40.789,-111.978,"America/Denver"],["KSAF","Santa Fe","NM",35.617,-106.089,"America/Denver"],["KSUN","Friedman Memorial, Sun Valley","ID",43.504,-114.296,"America/Boise"],
["KSDL","Scottsdale","AZ",33.623,-111.911,"America/Phoenix"],["KPHX","Phoenix Sky Harbor","AZ",33.434,-112.012,"America/Phoenix"],
["KLAS","Harry Reid, Las Vegas","NV",36.080,-115.152,"America/Los_Angeles"],["KHND","Henderson Executive","NV",35.973,-115.134,"America/Los_Angeles"],["KRNO","Reno-Tahoe","NV",39.499,-119.768,"America/Los_Angeles"],
["KVNY","Van Nuys","CA",34.210,-118.490,"America/Los_Angeles"],["KSMO","Santa Monica","CA",34.016,-118.451,"America/Los_Angeles"],["KBUR","Hollywood Burbank","CA",34.201,-118.359,"America/Los_Angeles"],
["KLAX","Los Angeles Intl","CA",33.942,-118.408,"America/Los_Angeles"],["KSNA","John Wayne, Orange County","CA",33.676,-117.868,"America/Los_Angeles"],["KCRQ","McClellan-Palomar, Carlsbad","CA",33.128,-117.280,"America/Los_Angeles"],
["KSAN","San Diego","CA",32.734,-117.190,"America/Los_Angeles"],["KPSP","Palm Springs","CA",33.830,-116.507,"America/Los_Angeles"],["KTRM","Jacqueline Cochran, Thermal","CA",33.627,-116.160,"America/Los_Angeles"],
["KSBA","Santa Barbara","CA",34.426,-119.840,"America/Los_Angeles"],["KMRY","Monterey","CA",36.587,-121.843,"America/Los_Angeles"],["KSJC","San Jose","CA",37.363,-121.929,"America/Los_Angeles"],
["KOAK","Oakland","CA",37.721,-122.221,"America/Los_Angeles"],["KSFO","San Francisco","CA",37.619,-122.375,"America/Los_Angeles"],["KAPC","Napa County","CA",38.213,-122.281,"America/Los_Angeles"],
["KTRK","Truckee-Tahoe","CA",39.320,-120.140,"America/Los_Angeles"],["KPDX","Portland","OR",45.589,-122.597,"America/Los_Angeles"],["KBFI","Boeing Field, Seattle","WA",47.530,-122.302,"America/Los_Angeles"],
["KSEA","Seattle-Tacoma","WA",47.450,-122.309,"America/Los_Angeles"],["PHNL","Honolulu","HI",21.319,-157.922,"Pacific/Honolulu"],["PHOG","Kahului, Maui","HI",20.899,-156.430,"Pacific/Honolulu"],
["CYYZ","Toronto Pearson","ON",43.677,-79.631,"America/Toronto"],["CYUL","Montréal-Trudeau","QC",45.470,-73.741,"America/Toronto"],["CYVR","Vancouver","BC",49.194,-123.184,"America/Vancouver"],
["TXKF","Bermuda","BM",32.364,-64.679,"Atlantic/Bermuda"],["MYNN","Lynden Pindling, Nassau","BS",25.039,-77.466,"America/Nassau"],["MYEH","North Eleuthera","BS",25.475,-76.683,"America/Nassau"],
["MYAM","Marsh Harbour, Abaco","BS",26.511,-77.084,"America/Nassau"],["MWCR","Grand Cayman","KY",19.293,-81.358,"America/Cayman"],["MKJS","Montego Bay","JM",18.504,-77.913,"America/Jamaica"],
["MDPC","Punta Cana","DO",18.567,-68.363,"America/Santo_Domingo"],["TIST","St. Thomas","VI",18.337,-64.973,"America/St_Thomas"],["TNCM","Princess Juliana, St. Maarten","SX",18.041,-63.109,"America/Lower_Princes"],
["TFFJ","St. Barthélemy","BL",17.904,-62.844,"America/St_Barthelemy"],["TBPB","Grantley Adams, Barbados","BB",13.075,-59.493,"America/Barbados"],["MMUN","Cancún","MX",21.037,-86.877,"America/Cancun"],
["MMSD","Los Cabos","MX",23.152,-109.721,"America/Mazatlan"],["EGLF","Farnborough","UK",51.276,-0.776,"Europe/London"],["LFPB","Paris Le Bourget","FR",48.969,2.441,"Europe/Paris"],
["LFMN","Nice Côte d'Azur","FR",43.658,7.216,"Europe/Paris"],["LSGG","Geneva","CH",46.238,6.109,"Europe/Zurich"]
].map(([id,name,reg,lat,lon,tz])=>({id,name,reg,lat,lon,tz}));
export const AP = Object.fromEntries(AIRPORTS.map(a=>[a.id,a]));

export const CLASSES = [
 {key:"turbo",label:"Turboprop",types:["King Air 350","Pilatus PC-12"],seats:8,kt:290,rate:3600,range:1500},
 {key:"light",label:"Light jet",types:["Phenom 300E","Citation CJ4","Learjet 70"],seats:6,kt:420,rate:5800,range:1900},
 {key:"mid",label:"Midsize",types:["Citation XLS+","Hawker 900XP","Learjet 75"],seats:8,kt:430,rate:7200,range:2000},
 {key:"smid",label:"Super-midsize",types:["Challenger 350","Citation Longitude","Praetor 600"],seats:9,kt:460,rate:9600,range:3300},
 {key:"heavy",label:"Heavy",types:["Gulfstream G450","Falcon 900LX","Challenger 650"],seats:13,kt:470,rate:13200,range:4100},
 {key:"ulr",label:"Ultra-long range",types:["Gulfstream G650","Global 6000","Falcon 8X"],seats:14,kt:490,rate:17500,range:6400}
];
export const CL = Object.fromEntries(CLASSES.map(c=>[c.key,c]));

export function nm(a,b){const r=Math.PI/180,dLat=(b.lat-a.lat)*r,dLon=(b.lon-a.lon)*r;const h=Math.sin(dLat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLon/2)**2;return 3440.1*2*Math.asin(Math.sqrt(h))}
export const mi=(a,b)=>nm(a,b)*1.15078;
export const blockMin=(dist,c)=>Math.round(dist/c.kt*60+22);
// One-way retail bills the return positioning, hence ×1.5 on hourly cost.
export const retailFor=(dist,c)=>Math.round(((dist/c.kt)+0.37)*c.rate*1.5/100)*100;
export const driveMin=m=>Math.round(m/36*60+8);
export const legDist=l=>nm(AP[l.o],AP[l.d]);
export const legBlock=l=>blockMin(legDist(l),CL[l.cls]||CLASSES[2]);
export const legRetail=l=>retailFor(legDist(l),CL[l.cls]||CLASSES[2]);

const tzCache={};
export function tzOffsetMin(tz,ms){
  const f=tzCache[tz]||(tzCache[tz]=new Intl.DateTimeFormat("en-US",{timeZone:tz,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}));
  const p=Object.fromEntries(f.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));
  return (Date.UTC(+p.year,+p.month-1,+p.day,+p.hour%24,+p.minute,+p.second)-ms)/60000;
}
/** "2026-10-11T10:30" wall-clock time in tz -> epoch ms */
export function localToUtc(str,tz){
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(str||"");if(!m)return NaN;
  const guess=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5]);let utc=guess-tzOffsetMin(tz,guess)*60000;
  return guess-tzOffsetMin(tz,utc)*60000;
}
export function utcToLocalStr(ms,tz){return new Date(ms+tzOffsetMin(tz,ms)*60000).toISOString().slice(0,16)}
export function fmtAt(ms,tz){
  try{return new Intl.DateTimeFormat("en-US",{timeZone:tz,weekday:"short",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23",timeZoneName:"short"}).format(new Date(ms)).replace(/,(?=[^,]*\d{2}:\d{2})/," ·")}
  catch{return new Date(ms).toUTCString()}
}
export const fmtDur=m=>Math.floor(m/60)+"h "+String(m%60).padStart(2,"0")+"m";
export const usd=n=>"$"+Math.round(n).toLocaleString("en-US");
export const apLabel=id=>AP[id]?`${id} · ${AP[id].name}, ${AP[id].reg}`:"";
export function parseAp(v){v=String(v||"").trim();if(!v)return null;const id=v.slice(0,4).toUpperCase();if(AP[id])return id;
  const q=v.toLowerCase();const hit=AIRPORTS.find(a=>(a.name+" "+a.reg).toLowerCase().includes(q));return hit?hit.id:null}
