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
  message: "初始化中...",
  data: [],
  lastUpdated: null,
  rawError: null,
  debugInfo: [] // 用來記錄每一條線抓到幾筆
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
    globalCache.rawError = { message: error.message };
    return false;
  }
}

// --- 輔助函式：延遲 (避免 429) ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 2. 抓取資料 (慢速排隊模式) ---
// 台北捷運路線代號
const LINES = ['BL', 'R', 'G', 'O', 'BR', 'Y']; 

async function fetchTDXData() {
  if (!authToken) {
    const success = await getAuthToken();
    if (!success) return;
  }

  let allData = [];
  let lineStats = []; // 記錄每條線抓到的狀況
  let hasError = false;

  console.log(`🔄 [${new Date().toLocaleTimeString()}] 開始慢速抓取全線資料...`);

  for (const lineId of LINES) {
    try {
      const response = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/LiveBoard/TRTC', {
        headers: { 
          'Authorization': `Bearer ${authToken}`,
          'Accept': 'application/json'
        },
        params: {
          '$filter': `LineNo eq '${lineId}'`, 
          '$top': 1000, // 確保每條線都抓完整
          '$format': 'JSON'
        }
      });

      const count = response.data?.length || 0;
      lineStats.push({ line: lineId, count: count });
      
      if (response.data && Array.isArray(response.data)) {
        allData = allData.concat(response.data);
      }
      
      // [關鍵] 休息 1500 毫秒 (1.5秒)，這對 API 來說非常友善，不會觸發封鎖
      await delay(1500);

    } catch (error) {
      console.error(`❌ 抓取路線 ${lineId} 失敗:`, error.message);
      lineStats.push({ line: lineId, count: 0, error: error.message });
      
      // 如果遇到 429，休息久一點 (5秒)
      if (error.response && error.response.status === 429) {
         console.warn('⚠️ 觸發 429，暫停 5 秒...');
         await delay(5000);
      }
      
      if (error.response && error.response.status === 401) {
         authToken = null;
         await getAuthToken();
      }
    }
  }

  // 整合資料
  if (allData.length > 0) {
    const processedData = allData.map(item => ({
      stationID: item.StationID,
      stationName: item.StationName?.Zh_tw || item.StationID || '未知',
      destination: item.DestinationStationName?.Zh_tw || item.DestinationStationID || '未知',
      time: item.EstimateTime || 0, 
      lineNo: item.LineNo,
      crowdLevel: 'LOW' 
    }));

    globalCache.data = processedData;
    globalCache.lastUpdated = new Date();
    globalCache.success = true;
    globalCache.message = `更新成功 (共 ${processedData.length} 筆)`;
    globalCache.debugInfo = lineStats; // 存下每條線的統計
    globalCache.rawError = null;
    
    console.log(`✅ 完成！統計: ${JSON.stringify(lineStats)}`);
  } else {
    console.log('⚠️ 本次循環未抓到任何資料');
  }
}

// --- 3. 設定排程 ---
fetchTDXData();
// 設定為 60 秒更新一次，給予伺服器充足的緩衝時間
setInterval(fetchTDXData, 60000); 

// --- 4. 路由 ---
app.get('/', (req, res) => {
  res.send(`
    <h1>TDX Server (Slow Queue Mode)</h1>
    <p>Data Count: ${globalCache.data.length}</p>
    <p>Line Stats: ${JSON.stringify(globalCache.debugInfo)}</p>
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
      lastUpdated: globalCache.lastUpdated,
      lineStats: globalCache.debugInfo // 讓你在 App 診斷也能看到每條線的狀況
    },
    lastError: globalCache.rawError
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});