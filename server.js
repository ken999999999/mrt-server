const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());

const PORT = process.env.PORT || 3000;
const TDX_CLIENT_ID = process.env.TDX_CLIENT_ID || '';
const TDX_CLIENT_SECRET = process.env.TDX_CLIENT_SECRET || '';

let globalCache = {
  success: false,
  message: "系統初始化中...",
  data: [],
  serverTime: null, // [新增] 伺服器當下時間
  lastUpdated: null,
  liveBoardCount: 0,
  timetableCount: 0
};

let staticTimetable = [];
let liveBoardData = [];
let authToken = null;

async function getAuthToken() {
  if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) return false;
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', TDX_CLIENT_ID);
    params.append('client_secret', TDX_CLIENT_SECRET);
    const res = await axios.post('https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', params);
    authToken = res.data.access_token;
    return true;
  } catch (e) { 
      console.error("Token Error", e.message);
      return false; 
  }
}

async function fetchTimetable() {
  if (!authToken) await getAuthToken();
  try {
    const res = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/StationTimeTable/TRTC', {
      headers: { 'Authorization': `Bearer ${authToken}` },
      params: { '$top': 5000, '$format': 'JSON' }
    });
    if (res.data) {
        staticTimetable = res.data;
        globalCache.timetableCount = staticTimetable.length;
        console.log(`✅ 時刻表更新: ${staticTimetable.length} 筆`);
    }
  } catch (e) { console.error('Timetable Error', e.message); }
}

async function fetchLiveBoard() {
  if (!authToken) await getAuthToken();
  try {
    const res = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/LiveBoard/TRTC', {
      headers: { 'Authorization': `Bearer ${authToken}` },
      params: { '$top': 3000, '$format': 'JSON' }
    });
    if (res.data) {
        liveBoardData = res.data;
        globalCache.liveBoardCount = liveBoardData.length;
    }
  } catch (e) { 
      if(e.response?.status === 401) { authToken = null; await getAuthToken(); }
  }
}

function calculateData() {
  const now = new Date();
  // 轉台灣時間 (UTC+8)
  const twTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (3600000 * 8));
  const currentMin = twTime.getHours() * 60 + twTime.getMinutes();

  let finalData = [];

  // A. LiveBoard
  liveBoardData.forEach(item => {
     const sec = Number(item.EstimateTime) || 0;
     const min = Math.floor(sec / 60);
     let lineNo = item.LineNO || item.LineNo;
     if (!lineNo && item.StationID) lineNo = item.StationID.match(/^([A-Z]+)/)?.[1] || 'Unknown';

     finalData.push({
       stationID: item.StationID,
       stationName: item.StationName.Zh_tw,
       destination: item.DestinationStationName.Zh_tw,
       lineNo: lineNo,
       time: min,
       type: 'live'
     });
  });

  // B. TimeTable 補位
  if (staticTimetable.length > 0) {
      staticTimetable.forEach(st => {
         if (!st.Timetables) return;
         let lineNo = st.LineNO || st.LineNo;
         if (!lineNo && st.StationID) lineNo = st.StationID.match(/^([A-Z]+)/)?.[1] || 'Unknown';

         st.Timetables.forEach(t => {
            const [h, m] = t.ArrivalTime.split(':').map(Number);
            const trainMin = h * 60 + m;
            
            if (trainMin > currentMin && trainMin <= currentMin + 60) {
               const diff = trainMin - currentMin;
               const isDup = finalData.some(d => 
                 d.stationID === st.StationID && 
                 d.destination === st.DestinationStationName.Zh_tw &&
                 Math.abs(d.time - diff) < 5
               );
               
               if (!isDup) {
                 finalData.push({
                   stationID: st.StationID,
                   stationName: st.StationName.Zh_tw,
                   destination: st.DestinationStationName.Zh_tw,
                   lineNo: lineNo,
                   time: diff,
                   type: 'schedule'
                 });
               }
            }
         });
      });
  }

  globalCache.data = finalData;
  globalCache.serverTime = new Date().toISOString(); // [新增] 回傳 ISO 格式時間
  globalCache.lastUpdated = new Date();
  globalCache.success = true;
}

fetchTimetable().then(() => {
    fetchLiveBoard().then(calculateData);
});

setInterval(fetchTimetable, 3600000); 
setInterval(fetchLiveBoard, 60000);   
setInterval(calculateData, 10000);    

app.get('/', (req, res) => res.send(`Server OK. Data: ${globalCache.data.length}`));
app.get('/api/trains', (req, res) => res.json({ 
    success: globalCache.success, 
    serverTime: globalCache.serverTime, // 傳給前端校準
    data: globalCache.data 
}));

app.listen(PORT, () => console.log(`Server on ${PORT}`));