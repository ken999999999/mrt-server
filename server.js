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
  debugInfo: [] 
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

// --- 2. 核心功能：龜速抓取 LiveBoard ---
// 台北捷運路線代號
const LINES = ['BL', 'R', 'G', 'O', 'BR', 'Y']; 

async function fetchTDXData() {
  if (!authToken) {
    const success = await getAuthToken();
    if (!success) return;
  }

  let allData = [];
  let lineStats = [];
  
  console.log(`🐢 [${new Date().toLocaleTimeString()}] 開始龜速抓取 (每條線間隔 4 秒)...`);

  for (const lineId of LINES) {
    try {
      // 使用 LiveBoard API，因為只有這個支援 LineNo 過濾
      const response = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/LiveBoard/TRTC', {
        headers: { 
          'Authorization': `Bearer ${authToken}`,
          'Accept': 'application/json'
        },
        params: {
          '$filter': `LineNo eq '${lineId}'`, 
          '$top': 1000, // 確保該路線所有車都抓回來
          '$format': 'JSON'
        }
      });

      const data = response.data || [];
      lineStats.push({ line: lineId, count: data.length });
      
      if (Array.isArray(data)) {
        allData = allData.concat(data);
      }
      
      // [關鍵] 強制休息 4 秒！
      // 這是避免 429 最有效的方法，雖然慢，但能保證抓到每一條線
      await delay(4000);

    } catch (error) {
      console.error(`❌ 抓取 ${lineId} 失敗:`, error.message);
      lineStats.push({ line: lineId, count: 0, error: error.message });
      
      // 遇到 429 就休息久一點
      if (error.response && error.response.status === 429) {
         console.warn('⚠️ 還是太快了 (429)，冷卻 10 秒...');
         await delay(10000);
      } else if (error.response && error.response.status === 401) {
         authToken = null;
         await getAuthToken();
      } else {
         // 其他錯誤 (如 400) 也要休息，避免連鎖反應
         await delay(4000);
      }
    }
  }

  // 整合資料
  if (allData.length > 0) {
    const processedData = allData.map(item => ({
      stationID: item.StationID,
      // 處理各種可能的名稱格式
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
    globalCache.debugInfo = lineStats;
    globalCache.rawError = null;
    
    console.log(`✅ 完成！統計: ${JSON.stringify(lineStats)}`);
  } else {
    console.log('⚠️ 本次循環未抓到任何資料 (可能是深夜收班或全線失敗)');
    globalCache.message = "暫無資料 (收班或連線中)";
  }
}

// --- 3. 設定排程 ---
fetchTDXData();
// 設定為 70 秒更新一次 (因為抓一次要花 24 秒，給它足夠的喘息時間)
setInterval(fetchTDXData, 70000); 

// --- 4. 路由 ---
app.get('/', (req, res) => {
  res.send(`<h1>TDX Server (Super Safe Mode)</h1><p>Data: ${globalCache.data.length}</p><p>Stats: ${JSON.stringify(globalCache.debugInfo)}</p>`);
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
      lineStats: globalCache.debugInfo
    },
    lastError: globalCache.rawError
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});