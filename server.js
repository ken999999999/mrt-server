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

let staticTimetable = []; // 靜態時刻表
let liveBoardData = [];   // 即時看板

let authToken = null;

// 1. 取得 Token
async function getAuthToken() {
  if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) {
      console.error("❌ 請設定 Render 環境變數");
      return false;
  }
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

// 2. 抓取靜態時刻表 (每小時)
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

// 3. 抓取即時看板 (每分鐘)
async function fetchLiveBoard() {
  if (!authToken) await getAuthToken();
  try {
    // console.log("📡 抓取即時看板...");
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

// 4. 混合運算 (每 10 秒)
function calculateData() {
  const now = new Date();
  // 轉台灣時間 (UTC+8)
  const twTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (3600000 * 8));
  const currentMin = twTime.getHours() * 60 + twTime.getMinutes();

  let finalData = [];

  // A. 先放入即時資料 (LiveBoard)
  liveBoardData.forEach(item => {
     const sec = Number(item.EstimateTime) || 0;
     const min = Math.floor(sec / 60);
     // 嘗試修正路線代號
     let lineNo = item.LineNO || item.LineNo;
     if (!lineNo && item.StationID) {
         lineNo = item.StationID.match(/^([A-Z]+)/)?.[1] || 'Unknown';
     }

     finalData.push({
       stationID: item.StationID,
       stationName: item.StationName.Zh_tw,
       destination: item.DestinationStationName.Zh_tw,
       lineNo: lineNo,
       time: min,
       crowdLevel: 'LOW',
       type: 'live'
     });
  });

  // B. 補入時刻表 (未來 60 分鐘)
  if (staticTimetable.length > 0) {
      staticTimetable.forEach(st => {
         if (!st.Timetables) return;
         
         // 修正路線代號
         let lineNo = st.LineNO || st.LineNo;
         if (!lineNo && st.StationID) {
             lineNo = st.StationID.match(/^([A-Z]+)/)?.[1] || 'Unknown';
         }

         st.Timetables.forEach(t => {
            const [h, m] = t.ArrivalTime.split(':').map(Number);
            const trainMin = h * 60 + m;
            
            // 邏輯：比現在晚，且在未來 60 分鐘內
            if (trainMin > currentMin && trainMin <= currentMin + 60) {
               // 檢查是否重複 (與即時資料比對)
               // 如果該站、該方向已經有 < 5 分鐘誤差內的即時資料，就不補這班
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

// --- 排程設定 ---
// 啟動流程：先抓時刻表 -> 再抓即時 -> 計算
fetchTimetable().then(() => {
    fetchLiveBoard().then(calculateData);
});

setInterval(fetchTimetable, 3600000); // 每 1 小時更新時刻表
setInterval(fetchLiveBoard, 60000);   // 每 1 分鐘更新即時看板
setInterval(calculateData, 10000);    // 每 10 秒重新計算倒數

// --- API ---
app.get('/', (req, res) => res.send(`TDX Hybrid Server Online. Data: ${globalCache.data.length}`));

app.get('/api/trains', (req, res) => {
    res.json({
        success: globalCache.success,
        updatedAt: globalCache.lastUpdated,
        data: globalCache.data
    });
});

app.get('/api/debug', (req, res) => {
    res.json({
        config: { hasClientId: !!TDX_CLIENT_ID },
        status: {
            success: globalCache.success,
            message: globalCache.message,
            dataCount: globalCache.data.length,
            liveCount: globalCache.liveBoardCount,
            scheduleCount: globalCache.timetableCount,
            lastUpdated: globalCache.lastUpdated
        }
    });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));