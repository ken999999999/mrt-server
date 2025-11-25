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

// --- 2. 抓取資料 (根據截圖修正) ---
// 台北捷運所有路線代號 (根據官方文件)
// BL:板南, R:淡水信義, G:松山新店, O:中和新蘆, BR:文湖, Y:環狀
const LINES = ['BL', 'R', 'G', 'O', 'BR', 'Y']; 

async function fetchTDXData() {
  if (!authToken) {
    const success = await getAuthToken();
    if (!success) return;
  }

  try {
    // 使用 Promise.all 同時抓取所有路線，效率最高
    // 根據截圖，我們使用 LiveBoard API，並加上 $top 參數來繞過預設的 30 筆限制
    const requests = LINES.map(lineId => {
      return axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/LiveBoard/TRTC', {
        headers: { 
          'Authorization': `Bearer ${authToken}`,
          'Accept': 'application/json'
        },
        params: {
          '$filter': `LineNo eq '${lineId}'`, // 篩選路線
          '$top': 2000, // 根據截圖，必須指定 top 否則只會回傳 30 筆 (設定 2000 絕對夠)
          '$format': 'JSON'
        }
      });
    });

    const responses = await Promise.all(requests);

    // 合併資料
    let allData = [];
    responses.forEach(res => {
      if (res.data && Array.isArray(res.data)) {
        allData = allData.concat(res.data);
      }
    });

    // --- 資料轉換 (對應截圖中的 JSON 結構) ---
    const processedData = allData.map(item => ({
      stationID: item.StationID,
      // 根據截圖，StationName 是物件，裡面有 Zh_tw
      stationName: item.StationName?.Zh_tw || item.StationID || '未知站名',
      // 根據截圖，DestinationStationName 也是物件
      destination: item.DestinationStationName?.Zh_tw || item.DestinationStationID || '未知目的地', // 修正這裡，截圖顯示有 DestinationStationName
      // 截圖顯示有 EstimateTime (整數，分鐘)
      time: item.EstimateTime || 0, 
      lineNo: item.LineNo,
      // 模擬擁擠度 (因為 LiveBoard 沒有這個欄位)
      crowdLevel: 'LOW' 
    }));

    globalCache.data = processedData;
    globalCache.lastUpdated = new Date();
    globalCache.success = true;
    globalCache.message = "資料更新正常";
    globalCache.rawError = null;
    
    console.log(`🔄 [${new Date().toLocaleTimeString()}] 官方文件版更新成功: 抓到 ${processedData.length} 筆資料`);

  } catch (error) {
    const status = error.response ? error.response.status : 'Unknown';
    console.error(`❌ 抓取資料失敗 (Status: ${status})`);
    globalCache.rawError = error.response ? error.response.data : error.message;

    if (status === 401) {
      console.log('Token 過期，重試中...');
      authToken = null;
      await getAuthToken();
    }
  }
}

// --- 3. 排程 ---
fetchTDXData();
setInterval(fetchTDXData, 20000); 

// --- 4. 路由 ---
app.get('/', (req, res) => {
  res.send(`
    <h1>TDX Server (Official Docs Fixed)</h1>
    <p>Status: ${globalCache.success ? '🟢 Online' : '🔴 Error'}</p>
    <p>Data Count: ${globalCache.data.length}</p>
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