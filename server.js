const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());

// --- 環境設定 ---
const PORT = process.env.PORT || 3000;
// 這裡同樣讀取環境變數，若無則為空字串
const TDX_CLIENT_ID = process.env.TDX_CLIENT_ID || '';
const TDX_CLIENT_SECRET = process.env.TDX_CLIENT_SECRET || '';

// --- 記憶體快取 ---
let globalCache = {
  success: false,
  message: "初始化中...",
  data: [],
  lastUpdated: null,
  rawError: null // 用來存儲原始錯誤，方便除錯
};

// --- 1. 官方規範：取得 Token ---
// 必須使用 application/x-www-form-urlencoded 格式
let authToken = null;

async function getAuthToken() {
  if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) {
    const msg = '❌ 錯誤: 請在 Render 後台設定 TDX_CLIENT_ID 和 TDX_CLIENT_SECRET';
    console.error(msg);
    globalCache.message = msg;
    return false;
  }

  try {
    // 這裡使用 URLSearchParams 是符合官方規範的 Form Data 格式
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', TDX_CLIENT_ID);
    params.append('client_secret', TDX_CLIENT_SECRET);

    const response = await axios.post(
      'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    authToken = response.data.access_token;
    console.log('✅ Token 取得成功');
    return true;
  } catch (error) {
    console.error('❌ Token 取得失敗:', error.response ? error.response.data : error.message);
    globalCache.rawError = error.response ? error.response.data : error.message;
    return false;
  }
}

// --- 2. 抓取資料 (使用 StationArrival API) ---
// 這支 API 通常比 LiveBoard 更穩定
async function fetchTDXData() {
  if (!authToken) {
    const success = await getAuthToken();
    if (!success) return;
  }

  try {
    // 這是台北捷運的「進站資訊」API，資料量較豐富
    const url = 'https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/StationArrival/TRTC?%24format=JSON';
    
    const response = await axios.get(url, {
      headers: { 
        'Authorization': `Bearer ${authToken}`,
        'Accept': 'application/json'
      }
    });

    const rawData = response.data;
    
    // 如果回傳空陣列，記錄一下
    if (Array.isArray(rawData) && rawData.length === 0) {
        console.warn('⚠️ TDX 回傳了空陣列 (可能是深夜收班或參數錯誤)');
        globalCache.message = "TDX 回傳無資料 (可能是收班時間)";
    }

    // --- 資料轉換邏輯 ---
    // 我們把它轉成 App 好讀的格式
    const processedData = rawData.map(item => ({
      stationID: item.StationID,
      stationName: item.StationName?.Zh_tw,
      destination: item.DestinationName?.Zh_tw,
      // StationArrival 的時間格式可能不同，這裡做個判斷
      // 假設它回傳的是 EstimateTime (分鐘) 或 NextTrainTime (時刻)
      // 為了簡化，這裡主要抓 EstimateTime
      time: item.EstimateTime || 0, 
      crowdLevel: 'LOW' 
    }));

    globalCache.data = processedData;
    globalCache.lastUpdated = new Date();
    globalCache.success = true;
    globalCache.message = "資料更新正常";
    globalCache.rawError = null; // 清除錯誤
    
    console.log(`🔄 [${new Date().toLocaleTimeString()}] 更新成功: ${processedData.length} 筆資料`);

  } catch (error) {
    const status = error.response ? error.response.status : 'Unknown';
    console.error(`❌ 抓取資料失敗 (Status: ${status})`);
    
    // 記錄詳細錯誤供除錯用
    globalCache.rawError = error.response ? error.response.data : error.message;

    // 401 代表 Token 過期，重抓一次
    if (status === 401) {
      console.log('Token 過期，嘗試重新取得...');
      authToken = null;
      await getAuthToken();
    }
  }
}

// --- 3. 設定排程 ---
fetchTDXData();
setInterval(fetchTDXData, 20000); // 每 20 秒

// --- 4. 路由設定 ---

// 首頁
app.get('/', (req, res) => {
  res.send(`
    <h1>TDX Server Status: ${globalCache.success ? '🟢 Online' : '🔴 Error'}</h1>
    <p>Last Update: ${globalCache.lastUpdated ? globalCache.lastUpdated.toLocaleString() : 'Never'}</p>
    <p>Message: ${globalCache.message}</p>
    <p><a href="/api/debug">點此查看詳細除錯資訊 (Debug)</a></p>
  `);
});

// App 用的 API
app.get('/api/trains', (req, res) => {
  res.json({
    success: globalCache.success,
    updatedAt: globalCache.lastUpdated,
    data: globalCache.data
  });
});

// [新功能] 除錯專用 API
// 如果 App 沒畫面，用瀏覽器開這個網址，看它吐出什麼
app.get('/api/debug', (req, res) => {
  res.json({
    config: {
      hasClientId: !!TDX_CLIENT_ID, // 只顯示有沒有設定，不顯示密碼
      hasClientSecret: !!TDX_CLIENT_SECRET
    },
    cacheStatus: {
      success: globalCache.success,
      message: globalCache.message,
      dataCount: globalCache.data.length,
      lastUpdated: globalCache.lastUpdated,
    },
    // 最重要的：如果有錯，這裡會顯示 TDX 說了什麼
    lastError: globalCache.rawError
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server ready on port ${PORT}`);
});