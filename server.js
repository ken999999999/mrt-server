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
  message: "系統初始化中...",
  data: [], // 這裡存放算出來的「即時」顯示資料
  rawSchedule: [], // 這裡存放下載回來的「整日時刻表」
  lastUpdated: null,
  rawError: null
};

// --- 1. 取得 Token ---
let authToken = null;

async function getAuthToken() {
  if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) {
    globalCache.message = '❌ 請在 Render 設定環境變數';
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
    console.error('❌ Token 取得失敗:', error.message);
    return false;
  }
}

// --- 2. 核心功能：下載整日時刻表 ---
// 這個函式只需要執行一次 (或每小時更新一次)
async function fetchDailyTimetable() {
  if (!authToken) {
    const success = await getAuthToken();
    if (!success) return;
  }

  try {
    console.log(`📥 [${new Date().toLocaleTimeString()}] 開始下載全線時刻表...`);
    
    // 改用 StationTimeTable (車站時刻表) API
    // 這裡我們一口氣抓 5000 筆，把所有車站的班表都拿回來
    const response = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/StationTimeTable/TRTC', {
      headers: { 'Authorization': `Bearer ${authToken}`, 'Accept': 'application/json' },
      params: { '$top': 5000, '$format': 'JSON' }
    });

    if (response.data && Array.isArray(response.data)) {
      globalCache.rawSchedule = response.data;
      console.log(`📦 時刻表下載完成！共 ${response.data.length} 個車站/方向資料`);
      
      // 下載完馬上計算一次
      calculateNextTrains();
    }
  } catch (error) {
    console.error('❌ 時刻表下載失敗:', error.message);
    globalCache.rawError = error.message;
    
    // 如果是 Token 問題就重抓
    if (error.response && error.response.status === 401) {
      authToken = null;
      await getAuthToken();
    }
  }
}

// --- 3. 核心運算：計算下一班車 (不需聯網) ---
// 這個函式會每 10 秒跑一次，純 CPU 運算，完全不消耗 API 額度
function calculateNextTrains() {
  if (globalCache.rawSchedule.length === 0) return;

  const now = new Date();
  // 取得目前時間的「分鐘數」 (例如 14:30 = 14*60 + 30 = 870)
  // 注意：需處理跨日問題 (TDX 00:00 可能算隔天)
  // 這裡為了簡化，我們用本地時間字串比對 'HH:mm'
  const currentHour = now.getHours();
  const currentMin = now.getMinutes();
  const currentTimeValue = currentHour * 60 + currentMin;

  let liveBoardData = [];

  // 遍歷每一個車站的時刻表
  globalCache.rawSchedule.forEach(station => {
    // station.Timetables 包含了該站整天的班次
    if (!station.Timetables || !Array.isArray(station.Timetables)) return;

    // 找到「第一班」時間晚於「現在」的車
    // Timetables 通常已經照時間排序好了
    const nextTrain = station.Timetables.find(t => {
        // t.ArrivalTime 格式為 "HH:mm" 或 "HH:mm:ss"
        const [h, m] = t.ArrivalTime.split(':').map(Number);
        const trainTimeValue = h * 60 + m;
        
        // 簡單邏輯：只要時間比現在晚，就是下一班
        // (這裡尚未處理半夜 00:00 跨日的情況，但在營運時間內是準的)
        return trainTimeValue > currentTimeValue;
    });

    if (nextTrain) {
      // 計算還有幾分鐘
      const [h, m] = nextTrain.ArrivalTime.split(':').map(Number);
      const trainTimeValue = h * 60 + m;
      let diffMinutes = trainTimeValue - currentTimeValue;
      
      // 為了符合前端格式，我們組裝出一樣的物件
      liveBoardData.push({
        stationID: station.StationID,
        stationName: station.StationName.Zh_tw,
        destination: station.DestinationStationName.Zh_tw,
        time: diffMinutes, // 這裡直接給分鐘數
        lineNo: station.LineNo || 'Unkown', // 時刻表有時候沒給 LineNo，沒關係
        crowdLevel: 'LOW' // 時刻表沒有擁擠度，預設 LOW
      });
    }
  });

  globalCache.data = liveBoardData;
  globalCache.lastUpdated = new Date();
  globalCache.success = true;
  globalCache.message = "時刻表運算正常";
  
  console.log(`🧮 [${new Date().toLocaleTimeString()}] 運算完成：全線即時更新 (${liveBoardData.length} 班列車)`);
}

// --- 排程設定 ---
// 1. 啟動時下載一次時刻表
fetchDailyTimetable();

// 2. 每 1 小時重新下載一次時刻表 (確保隔天或臨時變動)
setInterval(fetchDailyTimetable, 60 * 60 * 1000);

// 3. 每 10 秒「內部運算」一次倒數時間 (這不是請求 API，是內部 CPU 算)
setInterval(calculateNextTrains, 10000);


// --- 路由 ---
app.get('/', (req, res) => {
  res.send(`<h1>TDX Timetable Engine</h1><p>Calculated Trains: ${globalCache.data.length}</p>`);
});

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
    cacheStatus: {
      success: globalCache.success,
      message: globalCache.message,
      dataCount: globalCache.data.length,
      lastUpdated: globalCache.lastUpdated,
      scheduleSize: globalCache.rawSchedule.length // 顯示下載了多少個車站的班表
    },
    lastError: globalCache.rawError
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});