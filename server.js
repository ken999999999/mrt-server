const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());

// --- 環境設定 ---
const PORT = process.env.PORT || 3000;
const TDX_CLIENT_ID = process.env.TDX_CLIENT_ID || '';
const TDX_CLIENT_SECRET = process.env.TDX_CLIENT_SECRET || '';

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

// --- 2. 抓取資料 (單次超級請求) ---
async function fetchTDXData() {
  if (!authToken) {
    const success = await getAuthToken();
    if (!success) return;
  }

  try {
    console.log(`🔄 [${new Date().toLocaleTimeString()}] 發送單次請求抓取全線資料...`);

    // [戰術修正] 不再分路線抓，直接抓 TRTC (台北捷運) 全部
    // 關鍵是 $top=3000，確保不分頁，一次拿回所有車次
    const response = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/LiveBoard/TRTC', {
      headers: { 
        'Authorization': `Bearer ${authToken}`,
        'Accept': 'application/json'
      },
      params: {
        '$top': 3000,  // 一次抓 3000 筆，絕對夠涵蓋所有列車
        '$format': 'JSON'
      }
    });

    const rawData = response.data;

    if (rawData && Array.isArray(rawData)) {
        const processedData = rawData.map(item => ({
          stationID: item.StationID,
          // 根據您的截圖，StationName 是物件
          stationName: item.StationName?.Zh_tw || item.StationID || '未知',
          // 根據您的截圖，DestinationStationName 也是物件
          destination: item.DestinationStationName?.Zh_tw || item.DestinationStationID || '未知',
          time: item.EstimateTime || 0, 
          lineNo: item.LineNo,
          crowdLevel: 'LOW' 
        }));

        globalCache.data = processedData;
        globalCache.lastUpdated = new Date();
        globalCache.success = true;
        globalCache.message = "資料更新正常";
        globalCache.rawError = null;
        
        console.log(`✅ 更新成功: 抓到 ${processedData.length} 筆資料 (單次請求)`);
    } else {
        console.warn('⚠️ API 回傳格式非陣列:', rawData);
    }

  } catch (error) {
    console.error(`❌ 抓取失敗:`, error.message);
    
    // 429 處理：如果還是太快，記錄錯誤但不崩潰
    if (error.response && error.response.status === 429) {
        globalCache.rawError = { message: "429 Too Many Requests", detail: "請求過於頻繁，請稍候" };
    } else {
        globalCache.rawError = error.response ? error.response.data : error.message;
    }

    // Token 過期處理
    if (error.response && error.response.status === 401) {
      authToken = null;
      await getAuthToken();
    }
  }
}

// --- 3. 設定排程 ---
fetchTDXData();
// 設定為 60 秒更新一次，這對免費額度來說是最安全的頻率
setInterval(fetchTDXData, 60000); 

// --- 4. 路由 ---
app.get('/', (req, res) => {
  res.send(`<h1>TDX Server (Single Request Mode)</h1><p>Data Count: ${globalCache.data.length}</p>`);
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