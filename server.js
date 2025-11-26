const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());

// --- 環境設定 ---
const PORT = process.env.PORT || 3000;
const TDX_CLIENT_ID = process.env.TDX_CLIENT_ID || '';
const TDX_CLIENT_SECRET = process.env.TDX_CLIENT_SECRET || '';

// --- 記憶體快取 ---
let globalCache = {
  success: false,
  message: "系統初始化...",
  data: [],
  lastUpdated: null,
  rawError: null,
  timetableCount: 0, // 時刻表資料量
  liveBoardCount: 0  // 即時看板資料量
};

// 靜態時刻表暫存
let staticTimetable = [];

// --- 1. 取得 Token ---
let authToken = null;

async function getAuthToken() {
  if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) {
    console.error('❌ 請在 Render 設定環境變數');
    return false;
  }
  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', TDX_CLIENT_ID);
    params.append('client_secret', TDX_CLIENT_SECRET);
    const response = await axios.post(
      'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    authToken = response.data.access_token;
    console.log('✅ Token 取得成功');
    return true;
  } catch (error) {
    console.error('Token Error:', error.message);
    return false;
  }
}

// --- 2. 下載靜態時刻表 (每日一次) ---
async function fetchStaticTimetable() {
  if (!authToken) await getAuthToken();
  try {
    console.log(`📥 [${new Date().toLocaleTimeString()}] 下載靜態時刻表...`);
    const response = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/StationTimeTable/TRTC', {
      headers: { 'Authorization': `Bearer ${authToken}`, 'Accept': 'application/json' },
      params: { '$top': 5000, '$format': 'JSON' }
    });
    if (response.data && Array.isArray(response.data)) {
      staticTimetable = response.data;
      globalCache.timetableCount = staticTimetable.length;
      console.log(`✅ 時刻表下載完成: ${staticTimetable.length} 站`);
    }
  } catch (error) {
    console.error('❌ 時刻表下載失敗:', error.message);
  }
}

// --- 3. 抓取即時看板 & 混合運算 (每分鐘) ---
async function updateData() {
  if (!authToken) {
    const success = await getAuthToken();
    if (!success) return;
  }

  let liveData = [];
  
  // (A) 抓取 LiveBoard (即時)
  try {
    const response = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/LiveBoard/TRTC', {
      headers: { 'Authorization': `Bearer ${authToken}`, 'Accept': 'application/json' },
      params: { '$top': 3000, '$format': 'JSON' }
    });
    liveData = response.data || [];
    globalCache.liveBoardCount = liveData.length;
  } catch (error) {
    console.error('LiveBoard Error:', error.message);
    if (error.response?.status === 401) { authToken = null; await getAuthToken(); }
  }

  // (B) 混合運算邏輯
  const now = new Date();
  // 轉台灣時間 (UTC+8)
  const twTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (3600000 * 8));
  const currentMinutes = twTime.getHours() * 60 + twTime.getMinutes();

  let finalData = [];

  // 1. 先處理 LiveBoard (優先級最高)
  liveData.forEach(item => {
    const lineNo = item.LineNO || item.LineNo || 'Unknown';
    
    // [秒轉分修正]
    const seconds = Number(item.EstimateTime) || 0;
    const minutes = Math.floor(seconds / 60);

    finalData.push({
      uniqueId: `LIVE-${item.StationID}-${item.DestinationStationID}`,
      stationID: item.StationID,
      stationName: item.StationName?.Zh_tw || item.StationID,
      destination: item.DestinationStationName?.Zh_tw || '未知',
      time: minutes, // 已轉為分鐘
      lineNo: lineNo,
      type: 'live', 
      crowdLevel: 'LOW'
    });
  });

  // 2. 再從時刻表補資料 (如果 LiveBoard 沒給未來的車)
  if (staticTimetable.length > 0) {
    staticTimetable.forEach(st => {
      if (!st.Timetables) return;
      
      // 找到未來 60 分鐘內的班次
      const futureTrains = st.Timetables.filter(t => {
        const [h, m] = t.ArrivalTime.split(':').map(Number);
        const trainMin = h * 60 + m;
        return trainMin > currentMinutes && trainMin <= (currentMinutes + 60);
      }).slice(0, 2); // 只取最近 2 班

      futureTrains.forEach(t => {
        const [h, m] = t.ArrivalTime.split(':').map(Number);
        const diff = (h * 60 + m) - currentMinutes;
        const lineNo = st.LineNO || st.LineNo || 'Unknown';

        // 去重：如果該站、該方向已經有 < 3 分鐘的即時資料，就不補這班
        const hasLive = finalData.some(d => 
          d.stationID === st.StationID && 
          d.destination === st.DestinationStationName.Zh_tw &&
          Math.abs(d.time - diff) < 3
        );

        if (!hasLive) {
          finalData.push({
            uniqueId: `SCH-${st.StationID}-${st.DestinationStationID}-${t.ArrivalTime}`,
            stationID: st.StationID,
            stationName: st.StationName.Zh_tw,
            destination: st.DestinationStationName.Zh_tw,
            time: diff,
            lineNo: lineNo,
            type: 'schedule',
            crowdLevel: 'LOW'
          });
        }
      });
    });
  }

  globalCache.data = finalData;
  globalCache.lastUpdated = new Date();
  globalCache.success = true;
  
  console.log(`✅ 混合更新完成: Total ${finalData.length} 筆 (Live: ${liveData.length})`);
}

// --- 排程 ---
fetchStaticTimetable().then(updateData);
setInterval(updateData, 60000); 
setInterval(fetchStaticTimetable, 6 * 60 * 60 * 1000); 

// --- API ---
app.get('/', (req, res) => res.send(`TDX Server Online. Data: ${globalCache.data.length}`));
app.get('/api/trains', (req, res) => res.json({ success: true, updatedAt: globalCache.lastUpdated, data: globalCache.data }));
app.get('/api/debug', (req, res) => res.json({ config: { hasClientId: !!TDX_CLIENT_ID }, status: globalCache }));

app.listen(PORT, () => console.log(`Server running on ${PORT}`));