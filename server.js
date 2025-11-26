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
  const currentMin = twTime.getHours() * 60 + twTime.getMinutes();

  let finalData = [];

  // A. LiveBoard 處理
  liveBoardData.forEach(item => {
     const sec = Number(item.EstimateTime) || 0;
     const min = Math.floor(sec / 60);
     
     // [關鍵修正] 同時抓取 LineNO (大寫) 和 LineNo (小寫)
     // 如果都沒有，才嘗試從 StationID 逆推
     let lineNo = item.LineNO || item.LineNo;
     if (!lineNo && item.StationID) {
         lineNo = item.StationID.match(/^([A-Z]+)/)?.[1] || 'Unknown';
     }

     finalData.push({
       stationID: item.StationID,
       stationName: item.StationName.Zh_tw,
       destination: item.DestinationStationName.Zh_tw,
       lineNo: lineNo, // 確保這裡一定有值
       time: min,
       crowdLevel: 'LOW',
       type: 'live'
     });
  });

  // B. 時刻表補位
  if (staticTimetable.length > 0) {
      staticTimetable.forEach(st => {
         if (!st.Timetables) return;
         
         // 時刻表的欄位也可能不一樣，一樣做雙重檢查
         let lineNo = st.LineNO || st.LineNo;
         if (!lineNo && st.StationID) {
             lineNo = st.StationID.match(/^([A-Z]+)/)?.[1] || 'Unknown';
         }

         st.Timetables.forEach(t => {
            const [h, m] = t.ArrivalTime.split(':').map(Number);
            const trainMin = h * 60 + m;
            
            if (trainMin > currentMin && trainMin <= currentMin + 60) {
               const diff = trainMin - currentMin;
               const isDup = finalData.some(d => 
                 d.stationID === st.StationID && 
                 d.destination === st.DestinationStationName.Zh_tw &&
                 Math.abs(d.time - diff) < 4 
               );
               
               if (!isDup) {
                 finalData.push({
                   stationID: st.StationID,
                   stationName: st.StationName.Zh_tw,
                   destination: st.DestinationStationName.Zh_tw,
                   lineNo: lineNo, // 確保有值
                   time: diff,
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

app.get('/', (req, res) => res.send(`TDX Hybrid Server (Line Fixed). Data: ${globalCache.data.length}`));
app.get('/api/trains', (req, res) => res.json({ success: true, updatedAt: globalCache.lastUpdated, data: globalCache.data }));

app.listen(PORT, () => console.log(`Server running on ${PORT}`));