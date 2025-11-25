const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());

// --- 設定 ---
const PORT = process.env.PORT || 3000;
// 使用環境變數，如果沒有則使用空字串 (避免程式報錯，但會印出警告)
const TDX_CLIENT_ID = process.env.TDX_CLIENT_ID || ''; 
const TDX_CLIENT_SECRET = process.env.TDX_CLIENT_SECRET || '';

let globalCache = {
  data: [],
  lastUpdated: null
};

// --- 1. 取得 TDX Token ---
let authToken = null;
async function getAuthToken() {
  if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) {
    console.error('❌ 錯誤: 請在 Render 後台設定環境變數 TDX_CLIENT_ID 和 TDX_CLIENT_SECRET');
    return;
  }

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', TDX_CLIENT_ID);
    params.append('client_secret', TDX_CLIENT_SECRET);

    const response = await axios.post(
      'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
      params
    );
    authToken = response.data.access_token;
    console.log('✅ 取得新 Token 成功');
  } catch (error) {
    console.error('❌ 取得 Token 失敗:', error.message);
  }
}

// --- 2. 跟 TDX 要資料 (核心邏輯) ---
async function fetchTDXData() {
  if (!authToken) await getAuthToken();
  if (!authToken) return; // 如果還是沒有 Token，就先跳過這次更新

  try {
    const url = 'https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/LiveBoard/TRTC?%24format=JSON';
    
    const response = await axios.get(url, {
      headers: { authorization: `Bearer ${authToken}` }
    });

    const rawData = response.data;
    
    // --- 修正點：加上防呆機制 (?.) ---
    const processedData = rawData.map(item => ({
      stationID: item.StationID,
      // 使用 ?. 來讀取，如果 StationName 是 undefined，就改顯示 ID
      stationName: item.StationName?.Zh_tw || item.StationID,
      // 同樣加上 ?. 保護
      destination: item.DestinationName?.Zh_tw || '未知目的地',
      time: item.EstimateTime, 
      crowdLevel: 'LOW' 
    }));

    globalCache.data = processedData;
    globalCache.lastUpdated = new Date();
    console.log(`🔄 [${new Date().toLocaleTimeString()}] 資料已更新，共 ${processedData.length} 筆`);

  } catch (error) {
    console.error('❌ 抓取 TDX 資料失敗:', error.response ? error.response.status : error.message);
    
    // 雖然失敗，但印出詳細錯誤內容幫助除錯 (只印出第一筆資料結構，避免洗版)
    if (error.response && error.response.data && Array.isArray(error.response.data)) {
         console.log('API 回傳的第一筆資料結構:', JSON.stringify(error.response.data[0], null, 2));
    }

    if (error.response && error.response.status === 401) {
      await getAuthToken();
    }
  }
}

// --- 3. 設定排程 ---
fetchTDXData();
setInterval(fetchTDXData, 20000);

// --- 4. API 路由 ---
app.get('/', (req, res) => {
  res.send('TDX Server is Alive! 🤖');
});

app.get('/api/trains', (req, res) => {
  res.json({
    success: true,
    updatedAt: globalCache.lastUpdated,
    data: globalCache.data
  });
});

app.listen(PORT, () => {
  console.log(`🚀 伺服器已啟動，監聽 Port: ${PORT}`);
});