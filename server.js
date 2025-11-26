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
  data: [],
  lastUpdated: null,
  rawError: null,
  debugInfo: "無資料"
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

// --- 2. 抓取資料 ---
async function fetchTDXData() {
  if (!authToken) {
    const success = await getAuthToken();
    if (!success) return;
  }

  try {
    console.log(`🔄 [${new Date().toLocaleTimeString()}] 抓取資料中 (秒數轉分鐘修正)...`);

    const response = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/LiveBoard/TRTC', {
      headers: { 
        'Authorization': `Bearer ${authToken}`,
        'Accept': 'application/json'
      },
      params: {
        '$top': 3000, 
        '$format': 'JSON'
      }
    });

    const rawData = response.data;

    if (rawData && Array.isArray(rawData)) {
        // 統計路線 (除錯用)
        const stats = {};
        rawData.forEach(item => {
            const line = item.LineNo || 'Unknown';
            stats[line] = (stats[line] || 0) + 1;
        });
        const statsStr = JSON.stringify(stats);

        const processedData = rawData.map(item => {
          // [關鍵修正] TDX 的 EstimateTime 單位是「秒」
          // 我們把它除以 60 並無條件捨去，轉成「分鐘」
          // 例如: 50秒 -> 0分 (顯示進站中), 130秒 -> 2分
          const seconds = Number(item.EstimateTime) || 0;
          const minutes = Math.floor(seconds / 60);

          return {
            stationID: item.StationID,
            stationName: item.StationName?.Zh_tw || item.StationID || '未知',
            destination: item.DestinationStationName?.Zh_tw || item.DestinationStationID || '未知',
            time: minutes, // 這裡現在是分鐘了！
            lineNo: item.LineNo,
            crowdLevel: 'LOW' 
          };
        });

        globalCache.data = processedData;
        globalCache.lastUpdated = new Date();
        globalCache.success = true;
        globalCache.message = `更新成功 (共 ${processedData.length} 筆)`;
        globalCache.debugInfo = `路線統計: ${statsStr}`; 
        globalCache.rawError = null;
        
        console.log(`✅ 更新成功! 時間單位已修正。分佈: ${statsStr}`);
    } else {
        console.warn('⚠️ API 回傳空資料或格式錯誤');
    }

  } catch (error) {
    console.error(`❌ 抓取失敗:`, error.message);
    
    if (error.response && error.response.status === 429) {
        globalCache.rawError = { message: "429 Too Many Requests", detail: "請求過於頻繁，系統冷卻中" };
    } else {
        globalCache.rawError = error.response ? error.response.data : error.message;
    }

    if (error.response && error.response.status === 401) {
      authToken = null;
      await getAuthToken();
    }
  }
}

// --- 3. 設定排程 ---
fetchTDXData();
setInterval(fetchTDXData, 60000); 

// --- 4. 路由 ---
app.get('/', (req, res) => {
  res.send(`<h1>TDX Server (Minutes Fixed)</h1><p>Data: ${globalCache.data.length}</p><p>${globalCache.debugInfo}</p>`);
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
      debugInfo: globalCache.debugInfo
    },
    lastError: globalCache.rawError
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});