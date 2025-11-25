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
    globalCache.rawError = { message: error.message, detail: "Token 獲取失敗" };
    return false;
  }
}

// --- 輔助函式：延遲 (讓伺服器喘口氣) ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 2. 抓取資料 (禮貌模式：一條一條抓) ---
const LINES = ['BL', 'R', 'G', 'O', 'BR', 'Y']; 

async function fetchTDXData() {
  if (!authToken) {
    const success = await getAuthToken();
    if (!success) return;
  }

  let allData = [];
  let hasError = false;

  console.log(`🔄 [${new Date().toLocaleTimeString()}] 開始抓取資料 (禮貌模式)...`);

  // [關鍵修改] 使用 for 迴圈 + await，確保「抓完一條才抓下一條」
  for (const lineId of LINES) {
    try {
      const response = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/LiveBoard/TRTC', {
        headers: { 
          'Authorization': `Bearer ${authToken}`,
          'Accept': 'application/json'
        },
        params: {
          '$filter': `LineNo eq '${lineId}'`, 
          '$top': 1000, // 每一條線最多抓 1000 筆，確保不分頁
          '$format': 'JSON'
        }
      });

      if (response.data && Array.isArray(response.data)) {
        allData = allData.concat(response.data);
      }
      
      // [關鍵] 每抓完一條線，休息 500 毫秒 (0.5秒)，避免觸發 429 Too Many Requests
      await delay(500);

    } catch (error) {
      console.error(`❌ 抓取路線 ${lineId} 失敗:`, error.message);
      // 如果遇到 429 (太快)，休息久一點 (3秒) 再試下一條，或者直接跳出
      if (error.response && error.response.status === 429) {
         console.warn('⚠️ 觸發 429 限流，暫停抓取...');
         globalCache.rawError = { message: "API rate limit exceeded (429)", detail: "TDX 限制請求頻率，正在降速..." };
         hasError = true;
         break; // 放棄剩下的，保留目前抓到的
      }
      // Token 過期處理
      if (error.response && error.response.status === 401) {
         authToken = null;
         await getAuthToken();
         break; // 這次先放棄，下次排程會重來
      }
    }
  }

  // 只要有抓到任何資料，就算成功 (避免因為一條線失敗就全掛)
  if (allData.length > 0) {
    const processedData = allData.map(item => ({
      stationID: item.StationID,
      stationName: item.StationName?.Zh_tw || item.StationID || '未知站名',
      // 針對文件修正欄位
      destination: item.DestinationStationName?.Zh_tw || item.DestinationStationID || '未知',
      time: item.EstimateTime || 0, 
      lineNo: item.LineNo,
      crowdLevel: 'LOW' 
    }));

    globalCache.data = processedData;
    globalCache.lastUpdated = new Date();
    globalCache.success = true;
    globalCache.message = `更新成功 (共 ${processedData.length} 筆)`;
    // 如果沒有嚴重錯誤，就清空錯誤訊息
    if (!hasError) globalCache.rawError = null;
    
    console.log(`✅ 完成！共整合 ${processedData.length} 筆資料`);
  } else if (hasError) {
    globalCache.success = false;
    globalCache.message = "API 限流或資料異常";
  }
}

// --- 3. 設定排程 ---
fetchTDXData();
// 將更新頻率放寬到 40 秒一次，進一步降低被封鎖機率
setInterval(fetchTDXData, 40000); 

// --- 4. 路由 ---
app.get('/', (req, res) => {
  res.send(`<h1>TDX Server (Sequential Mode)</h1><p>Data: ${globalCache.data.length}</p>`);
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