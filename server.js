const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

// 允許跨網域請求 (讓你的 App 可以連進來)
app.use(cors());

// --- 設定 ---
// 修改點 1: 支援雲端平台指派的 Port，如果沒有則使用 3000
const PORT = process.env.PORT || 3000;

// 重要：實際上傳到 GitHub 時，建議不要直接把 ID/Secret 寫在程式碼裡
// 最好使用 process.env.TDX_CLIENT_ID 讀取環境變數
// 但為了教學方便，我們先保留變數，稍後在 Render 後台設定
const TDX_CLIENT_ID = process.env.TDX_CLIENT_ID || 'YOUR_CLIENT_ID'; 
const TDX_CLIENT_SECRET = process.env.TDX_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';

// --- 記憶體快取 (In-Memory Cache) ---
let globalCache = {
  data: [],
  lastUpdated: null
};

// --- 1. 取得 TDX Token 的函式 ---
let authToken = null;
async function getAuthToken() {
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

// --- 2. 跟 TDX 要資料的函式 (核心邏輯) ---
async function fetchTDXData() {
  // 如果還沒設定環境變數，就不要執行，避免錯誤
  if (TDX_CLIENT_ID === 'YOUR_CLIENT_ID') {
    console.log('⚠️ 請設定 TDX Client ID 與 Secret');
    return;
  }

  if (!authToken) await getAuthToken();

  try {
    // 範例：抓取台北捷運「藍線」
    const url = 'https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/LiveBoard/TRTC?%24format=JSON';
    
    const response = await axios.get(url, {
      headers: { authorization: `Bearer ${authToken}` }
    });

    const rawData = response.data;
    
    const processedData = rawData.map(item => ({
      stationID: item.StationID,
      stationName: item.StationName.Zh_tw,
      destination: item.DestinationName.Zh_tw,
      time: item.EstimateTime, 
      crowdLevel: 'LOW' // 模擬數據
    }));

    globalCache.data = processedData;
    globalCache.lastUpdated = new Date();
    console.log(`🔄 [${new Date().toLocaleTimeString()}] 資料已更新，共 ${processedData.length} 筆`);

  } catch (error) {
    console.error('❌ 抓取 TDX 資料失敗:', error.response ? error.response.status : error.message);
    if (error.response && error.response.status === 401) {
      await getAuthToken();
    }
  }
}

// --- 3. 設定排程 ---
fetchTDXData();
setInterval(fetchTDXData, 20000);

// --- 4. API 路由 ---

// 修改點 2: 新增根目錄路由，這是給 UptimeRobot "戳" 用的
// 這樣它才知道伺服器還活著
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

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`🚀 伺服器已啟動，監聽 Port: ${PORT}`);
});