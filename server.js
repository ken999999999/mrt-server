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
    console.log("✅ Token 取得成功");
    return true;
  } catch (e) { 
      console.error("❌ Token 失敗:", e.message);
      return false; 
  }
}

async function fetchTimetable() {
  if (!authToken) await getAuthToken();
  try {
    console.log("📥 下載靜態時刻表...");
    const res = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/StationTimeTable/TRTC', {
      headers: { 'Authorization': `Bearer ${authToken}` },
      params: { '$top': 5000, '$format': 'JSON' }
    });
    if (res.data) {
        staticTimetable = res.data;
        globalCache.timetableCount = staticTimetable.length;
        console.log(`✅ 時刻表下載完成: ${staticTimetable.length} 站`);
    }
  } catch (e) { console.error('❌ 時刻表下載失敗:', e.message); }
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
      console.error('❌ LiveBoard 失敗:', e.message);
      if(e.response?.status === 401) { authToken = null; await getAuthToken(); }
  }
}

function calculateData() {
  const now = new Date();
  const twTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (3600000 * 8));
  const currentSeconds = twTime.getHours() * 3600 + twTime.getMinutes() * 60 + twTime.getSeconds();

  let finalData = [];

  // A. LiveBoard 處理 (改為回傳秒數)
  liveBoardData.forEach(item => {
     // 這裡不再除以 60，直接保留秒數
     // 為了實現「提早 30 秒」，我們把這裡的時間「減去 30 秒」
     // 這樣前端顯示 0 秒時，實際上車子還有 30 秒才到
     const originalSeconds = Number(item.EstimateTime) || 0;
     const adjustedSeconds = Math.max(0, originalSeconds - 30);

     let lineNo = item.LineNO || item.LineNo;
     if (!lineNo && item.StationID) {
         lineNo = item.StationID.match(/^([A-Z]+)/)?.[1] || 'Unknown';
     }

     finalData.push({
       stationID: item.StationID,
       stationName: item.StationName.Zh_tw,
       destination: item.DestinationStationName.Zh_tw,
       lineNo: lineNo,
       time: adjustedSeconds, // 這是秒數！
       crowdLevel: 'LOW',
       type: 'live'
     });
  });

  // B. 時刻表補位 (同樣改為秒數計算)
  if (staticTimetable.length > 0) {
      staticTimetable.forEach(st => {
         if (!st.Timetables) return;
         
         let lineNo = st.LineNO || st.LineNo;
         if (!lineNo && st.StationID) {
             lineNo = st.StationID.match(/^([A-Z]+)/)?.[1] || 'Unknown';
         }

         st.Timetables.forEach(t => {
            const [h, m] = t.ArrivalTime.split(':').map(Number);
            const trainSeconds = h * 3600 + m * 60; // 轉成當天總秒數
            
            // 邏輯：比現在晚，且在未來 3600 秒 (1小時) 內
            if (trainSeconds > currentSeconds && trainSeconds <= currentSeconds + 3600) {
               const diffSeconds = Math.max(0, (trainSeconds - currentSeconds) - 30); // 同樣減去 30 秒

               // 去重：誤差範圍放寬到 240 秒 (4分鐘)
               const isDup = finalData.some(d => 
                 d.stationID === st.StationID && 
                 d.destination === st.DestinationStationName.Zh_tw &&
                 Math.abs(d.time - diffSeconds) < 240 
               );
               
               if (!isDup) {
                 finalData.push({
                   stationID: st.StationID,
                   stationName: st.StationName.Zh_tw,
                   destination: st.DestinationStationName.Zh_tw,
                   lineNo: lineNo,
                   time: diffSeconds, // 這是秒數！
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
  globalCache.message = "資料更新正常";
}

fetchTimetable().then(() => {
    fetchLiveBoard().then(calculateData);
});

setInterval(fetchTimetable, 3600000); 
setInterval(fetchLiveBoard, 60000);   
setInterval(calculateData, 10000);    

app.get('/', (req, res) => res.send(`TDX Hybrid Server (Seconds Mode). Data: ${globalCache.data.length}`));
app.get('/api/trains', (req, res) => res.json({ success: true, updatedAt: globalCache.lastUpdated, data: globalCache.data }));

app.listen(PORT, () => console.log(`Server running on ${PORT}`));