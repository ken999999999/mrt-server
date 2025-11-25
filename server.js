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
  rawError: null 
};

// --- 1. 取得 Token ---
let authToken = null;

async function getAuthToken() {
  if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) {
    const msg = '❌ 錯誤: 請在 Render 後台設定 TDX_CLIENT_ID 和 TDX_CLIENT_SECRET';
    console.error(msg);
    globalCache.message = msg;
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
    globalCache.rawError = error.response ? error.response.data : error.message;
    return false;
  }
}

// --- 2. 抓取資料 (修正：加上 $top=3000 參數) ---
async function fetchTDXData() {
  if (!authToken) {
    const success = await getAuthToken();
    if (!success) return;
  }

  try {
    // [關鍵修正] 根據您提供的圖片，我們加上 $top=3000 參數
    // 這會告訴 TDX 不要分頁，直接給我們最多 3000 筆資料 (足夠涵蓋全線列車)
    const url = 'https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/LiveBoard/TRTC?%24top=3000&%24format=JSON';
    
    const response = await axios.get(url, {
      headers: { 
        'Authorization': `Bearer ${authToken}`,
        'Accept': 'application/json'
      }
    });

    const rawData = response.data;

    // --- 資料轉換邏輯 ---
    const processedData = rawData.map(item => ({
      stationID: item.StationID,
      // 使用 ?. 運算子，如果沒有中文名就回傳空字串
      stationName: item.StationName?.Zh_tw || item.StationID || '未知站名',
      destination: item.DestinationName?.Zh_tw || '未知目的地',
      time: item.EstimateTime || 0, 
      crowdLevel: 'LOW' 
    }));

    globalCache.data = processedData;
    globalCache.lastUpdated = new Date();
    globalCache.success = true;
    globalCache.message = "資料更新正常";
    globalCache.rawError = null;
    
    console.log(`🔄 [${new Date().toLocaleTimeString()}] LiveBoard 更新成功: 抓到 ${processedData.length} 筆資料`);

  } catch (error) {
    const status = error.response ? error.response.status : 'Unknown';
    console.error(`❌ 抓取資料失敗 (Status: ${status})`);
    globalCache.rawError = error.response ? error.response.data : error.message;

    // 401 代表 Token 過期，重抓
    if (status === 401) {
      console.log('Token 過期，重試中...');
      authToken = null;
      await getAuthToken();
    }
  }
}

// --- 3. 設定排程 ---
fetchTDXData();
setInterval(fetchTDXData, 20000); 

// --- 4. 路由 ---
app.get('/', (req, res) => {
  res.send(`
    <h1>TDX Server (LiveBoard)</h1>
    <p>Status: ${globalCache.success ? '🟢 Online' : '🔴 Error'}</p>
    <p>Data Count: ${globalCache.data.length} (應該要大於 18)</p>
    <p>Last Update: ${globalCache.lastUpdated?.toLocaleString()}</p>
    <p><a href="/api/debug">Debug Info</a></p>
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
    },
    lastError: globalCache.rawError
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});