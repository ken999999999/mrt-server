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
  message: "系統啟動中...",
  data: [], // 顯示給 App 的即時資料
  rawSchedule: [], // 完整的時刻表資料庫
  lastUpdated: null,
  rawError: null,
  downloadProgress: "等待開始..."
};

// --- 輔助函式：延遲 ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// --- 2. 核心功能：螞蟻搬家式下載時刻表 ---
const LINES = ['BL', 'R', 'G', 'O', 'BR', 'Y']; 

async function fetchDailyTimetable() {
  if (!authToken) {
    const success = await getAuthToken();
    if (!success) return;
  }

  console.log(`📥 [${new Date().toLocaleTimeString()}] 開始分線下載時刻表...`);
  let accumulatedData = [];
  let hasError = false;

  for (const lineId of LINES) {
    try {
      globalCache.downloadProgress = `正在下載 ${lineId} 線...`;
      console.log(`.. 下載 ${lineId} 線中`);

      const response = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/StationTimeTable/TRTC', {
        headers: { 'Authorization': `Bearer ${authToken}`, 'Accept': 'application/json' },
        params: { 
            '$filter': `LineNo eq '${lineId}'`, // 只抓這條線
            '$top': 2000, // 夠大，確保不分頁
            '$format': 'JSON' 
        }
      });

      if (response.data && Array.isArray(response.data)) {
        accumulatedData = accumulatedData.concat(response.data);
      }

      // [關鍵] 每抓完一條線，強制休息 3 秒，讓 TDX 覺得我們很友善
      await delay(3000);

    } catch (error) {
      console.error(`❌ 下載 ${lineId} 失敗:`, error.message);
      hasError = true;
      
      // 遇到 429 (被封鎖)，休息更久 (10秒) 再試下一條
      if (error.response && error.response.status === 429) {
          console.warn('⚠️ 觸發 429，進入冷卻模式 (10s)...');
          await delay(10000);
      }
      
      if (error.response && error.response.status === 401) {
          authToken = null;
          await getAuthToken();
      }
    }
  }

  if (accumulatedData.length > 0) {
    globalCache.rawSchedule = accumulatedData;
    globalCache.downloadProgress = "下載完成";
    console.log(`📦 全線時刻表下載完成！共 ${accumulatedData.length} 筆車站資料`);
    
    // 馬上計算一次
    calculateNextTrains();
  } else {
    globalCache.downloadProgress = "下載失敗，將重試";
    console.log('⚠️ 本次未能下載任何資料，稍後重試');
  }
}

// --- 3. 核心運算：計算下一班車 (純 CPU 運算) ---
function calculateNextTrains() {
  if (globalCache.rawSchedule.length === 0) return;

  const now = new Date();
  // 調整為台灣時間 (Render 伺服器通常是 UTC)
  // 簡單處理：我們直接用伺服器時間 + 8小時來計算「現在幾點」
  // 但為了避免時區混亂，我們用比較穩妥的方式：
  // 獲取當前的 UTC 時間，然後加 8 小時轉成台灣時間
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const twTime = new Date(utc + (3600000 * 8));
  
  const currentHour = twTime.getHours();
  const currentMin = twTime.getMinutes();
  const currentTimeValue = currentHour * 60 + currentMin;

  let liveBoardData = [];

  globalCache.rawSchedule.forEach(station => {
    if (!station.Timetables || !Array.isArray(station.Timetables)) return;

    // 找到下一班車
    const nextTrain = station.Timetables.find(t => {
        const [h, m] = t.ArrivalTime.split(':').map(Number);
        const trainTimeValue = h * 60 + m;
        return trainTimeValue > currentTimeValue;
    });

    if (nextTrain) {
      const [h, m] = nextTrain.ArrivalTime.split(':').map(Number);
      const trainTimeValue = h * 60 + m;
      let diffMinutes = trainTimeValue - currentTimeValue;
      
      liveBoardData.push({
        stationID: station.StationID,
        stationName: station.StationName.Zh_tw,
        destination: station.DestinationStationName.Zh_tw,
        time: diffMinutes, 
        lineNo: station.LineNo || 'Unkown', 
        crowdLevel: 'LOW' 
      });
    }
  });

  globalCache.data = liveBoardData;
  globalCache.lastUpdated = new Date(); // 更新時間
  globalCache.success = true;
  globalCache.message = "時刻表運算正常";
  
  // Log 不要太頻繁，這裡註解掉
  // console.log(`🧮 運算完成 (${liveBoardData.length} 班列車)`);
}

// --- 排程設定 ---

// 1. 啟動時執行下載
fetchDailyTimetable();

// 2. 每 4 小時重新下載一次時刻表 (因為時刻表不太會變，不需要頻繁抓)
setInterval(fetchDailyTimetable, 4 * 60 * 60 * 1000);

// 3. 每 10 秒計算一次倒數 (純 CPU)
setInterval(calculateNextTrains, 10000);


// --- 路由 ---
app.get('/', (req, res) => {
  res.send(`
    <h1>TDX Timetable Engine (Slow Fetch)</h1>
    <p>Progress: ${globalCache.downloadProgress}</p>
    <p>Calculated Trains: ${globalCache.data.length}</p>
    <p>Last Calculation: ${globalCache.lastUpdated?.toLocaleString()}</p>
  `);
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
      scheduleSize: globalCache.rawSchedule.length,
      downloadProgress: globalCache.downloadProgress
    },
    lastError: globalCache.rawError
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});