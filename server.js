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
  const twTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (3600000 * 8));
  const currentSeconds = twTime.getHours() * 3600 + twTime.getMinutes() * 60 + twTime.getSeconds();

  let finalData = [];

  // A. LiveBoard (保留原始秒數，不再除以 60)
  liveBoardData.forEach(item => {
     const originalSeconds = Number(item.EstimateTime) || 0;
     
     // [關鍵] 這裡不除以 60，直接回傳秒數
     // 為了讓使用者有緩衝，我們在後端這裡 "扣掉" 0 秒 (原汁原味)，前端再去判斷
     // 如果想要「提早 30 秒」的效果，可以在這裡寫 Math.max(0, originalSeconds - 30)
     // 但建議傳回真實秒數，讓前端 UI 去決定何時顯示 "進站中"
     
     let lineNo = item.LineNO || item.LineNo;
     if (!lineNo && item.StationID) {
         lineNo = item.StationID.match(/^([A-Z]+)/)?.[1] || 'Unknown';
     }

     finalData.push({
       stationID: item.StationID,
       stationName: item.StationName.Zh_tw,
       destinatio
n: item.DestinationStationName.Zh_tw,
       lineNo: lineNo,
       time: originalSeconds, // 傳回秒數
       crowdLevel: 'LOW',
       type: 'live'
     });
  });

  // B. 時刻表補位 (轉成秒數)
  if (staticTimetable.length > 0) {
      staticTimetable.forEach(st => {
         if (!st.Timetables) return;
         
         let lineNo = st.LineNO || st.LineNo;
         if (!lineNo && st.StationID) lineNo = st.StationID.match(/^([A-Z]+)/)?.[1] || 'Unknown';

         st.Timetables.forEach(t => {
            const [h, m] = t.ArrivalTime.split(':').map(Number);
            const trainSeconds = h * 3600 + m * 60;
            
            // 未來 1 小時內的車
            if (trainSeconds > currentSeconds && trainSeconds <= currentSeconds + 3600) {
               const diff = trainSeconds - currentSeconds;
               
               // 去重：誤差 < 180秒 視為同一班
               const isDup = finalData.some(d => 
                 d.stationID === st.StationID && 
                 d.destination === st.DestinationStationName.Zh_tw &&
                 Math.abs(d.time - diff) < 180 
               );
               
               if (!isDup) {
                 finalData.push({
                   stationID: st.StationID,
                   stationName: st.StationName.Zh_tw,
                   destination: st.DestinationStationName.Zh_tw,
                   lineNo: lineNo,
                   time: diff, // 傳回秒數
                   crowdLevel: 'LOW',
                   type: 'schedule'
                 });
               }
            }
         });
      });
  }

  globalCache.data = finalData;
  globalCache.lastUpdated = new Date();
  globalCache.success = true;
  globalCache.message = "資料更新正常(秒數版)";
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