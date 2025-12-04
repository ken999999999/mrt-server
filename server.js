/* mrt-server/server.js */
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const xml2js = require('xml2js');
const app = express();

app.use(cors());

const PORT = process.env.PORT || 3000;

// 請設定你的官方 API 帳號密碼 (環境變數或直接填入)
const MRT_USER = process.env.MRT_USER || '你的帳號';
const MRT_PASS = process.env.MRT_PASS || '你的密碼';

// TDX 僅用於取得 "站名 <-> ID" 對照表，若無 TDX 也可運作 (會少 ID)
const TDX_CLIENT_ID = process.env.TDX_CLIENT_ID || '';
const TDX_CLIENT_SECRET = process.env.TDX_CLIENT_SECRET || '';

// 暫存資料
let globalCache = {
  success: false,
  message: "系統初始化中...",
  serverTime: null,
  data: [],
  nameToIdMap: {} // 站名轉 ID 對照表 (e.g. "台北車站" -> "BL12")
};

// 輔助：解析 XML
const parseXML = async (xml) => {
    const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true });
    try {
        return await parser.parseStringPromise(xml);
    } catch (e) {
        return null;
    }
};

// 1. 取得 TDX 站名對照表 (為了把官方中文站名轉成 ID)
async function fetchStationMapping() {
    if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) return;
    try {
        // 取得 Token
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', TDX_CLIENT_ID);
        params.append('client_secret', TDX_CLIENT_SECRET);
        const tokenRes = await axios.post('https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', params);
        const token = tokenRes.data.access_token;

        // 取得車站資料
        const res = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/Station/TRTC', {
            headers: { 'Authorization': `Bearer ${token}` },
            params: { '$format': 'JSON' }
        });
        
        if (res.data) {
            res.data.forEach(st => {
                // 建立對照: "忠孝復興" -> "BL15" (若有轉乘，可能會被覆蓋，以後蓋前為主或保留多個)
                // 這裡簡單處理，Mapping 中文名到 StationID
                globalCache.nameToIdMap[st.StationName.Zh_tw] = st.StationID;
            });
            console.log(`✅ 車站對照表更新: ${Object.keys(globalCache.nameToIdMap).length} 筆`);
        }
    } catch (e) { console.error("TDX Mapping Error:", e.message); }
}

// 2. 官方 API: 列車到站資訊 (TrackInfo)
async function fetchTrackInfo() {
    const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
    <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
      <soap:Body>
        <getTrackInfo xmlns="http://tempuri.org/">
          <userName>${MRT_USER}</userName>
          <password>${MRT_PASS}</password>
        </getTrackInfo>
      </soap:Body>
    </soap:Envelope>`;

    try {
        const res = await axios.post('https://api.metro.taipei/metroapi/TrackInfo.asmx', xmlBody, {
            headers: { 'Content-Type': 'text/xml; charset=utf-8' }
        });
        const parsed = await parseXML(res.data);
        // 解析 JSON 字串 (官方 API 回傳的 XML 裡面包了一層 JSON 字串)
        // 結構: Envelope.Body.getTrackInfoResponse.getTrackInfoResult (string)
        const rawJson = parsed['soap:Envelope']['soap:Body']['getTrackInfoResponse']['getTrackInfoResult'];
        return JSON.parse(rawJson);
    } catch (e) {
        console.error("TrackInfo Error:", e.message);
        return [];
    }
}

// 3. 官方 API: 擁擠度 (高運量 + 文湖線)
async function fetchCrowdedness() {
    let crowdednessMap = {}; // Key: StationID or Name, Value: Level

    const fetchAPI = async (url, method) => {
        const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
        <soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
          <soap:Body>
            <${method} xmlns="http://tempuri.org/">
              <userName>${MRT_USER}</userName>
              <password>${MRT_PASS}</password>
            </${method}>
          </soap:Body>
        </soap:Envelope>`;
        try {
            const res = await axios.post(url, xmlBody, { headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
            const parsed = await parseXML(res.data);
            const rawJson = parsed['soap:Envelope']['soap:Body'][`${method}Response`][`${method}Result`];
            return JSON.parse(rawJson);
        } catch (e) { return []; }
    };

    // 並行取得
    const [highCap, wenhu] = await Promise.all([
        fetchAPI('https://api.metro.taipei/metroapi/CarWeight.asmx', 'getCarWeightByInfoEx'),
        fetchAPI('https://api.metro.taipei/metroapi/CarWeightBR.asmx', 'getCarWeightBRInfo')
    ]);

    // 處理擁擠度資料
    // HighCap 格式: [{"TrainNumber":"132", "StationID":"BL11", "Car1":"1", ...}] (1=舒適, 2=普通, 3=略擠, 4=擁擠)
    // 我們將擁擠度平均或取最大值，綁定到車站ID，表示「該車站目前有這班車的擁擠度」
    const process = (list) => {
        if (!list) return;
        list.forEach(train => {
            if (train.StationID) {
                // 簡單計算：取最大擁擠度
                let maxLevel = 1;
                for (let i = 1; i <= 6; i++) {
                    if (train[`Car${i}`]) maxLevel = Math.max(maxLevel, parseInt(train[`Car${i}`]) || 1);
                }
                // 轉換為 App 顯示字串
                let levelStr = 'LOW'; // 綠
                if (maxLevel === 2) levelStr = 'MEDIUM'; // 黃
                if (maxLevel === 3) levelStr = 'HIGH'; // 橘
                if (maxLevel >= 4) levelStr = 'FULL'; // 紅
                
                // 存入 Map，Key 為 StationID (e.g., "BL11")
                crowdednessMap[train.StationID] = levelStr;
            }
        });
    };

    process(highCap);
    process(wenhu);
    return crowdednessMap;
}

// 整合資料並更新 Cache
async function updateData() {
    console.log("🔄 開始更新資料...");
    const [trackInfo, crowdMap] = await Promise.all([fetchTrackInfo(), fetchCrowdedness()]);
    
    // 處理 TrackInfo
    // 格式: [{"StationName":"台北車站", "DestinationName":"南港展覽館", "CountDown":"01:28", ...}]
    
    let finalData = [];
    trackInfo.forEach(item => {
        const stationName = item.StationName.replace('站', ''); // 去掉"站"字以匹配
        const stationID = globalCache.nameToIdMap[stationName] || item.StationName;
        
        let seconds = 0;
        if (item.CountDown === '列車進站') {
            seconds = 0;
        } else if (item.CountDown.includes(':')) {
            const parts = item.CountDown.split(':');
            seconds = parseInt(parts[0]) * 60 + parseInt(parts[1]);
        } else {
            seconds = 9999; // 未知
        }

        // 判斷路線代號 (從 StationID 猜測)
        let lineNo = 'Unknown';
        if (stationID.match(/^[A-Z]+/)) {
            lineNo = stationID.match(/^[A-Z]+/)[0];
        }

        // 嘗試匹配擁擠度
        // 邏輯：如果列車「即將進站」(seconds < 30)，且該車站ID在 crowdMap 中有資料，就使用該資料
        // 注意：官方 API 擁擠度是「列車所在地」，到站資訊是「預估時間」。
        // 當列車進站時 (seconds=0)，兩者應該重合。
        let crowdLevel = 'LOW'; // 預設
        if (seconds < 40 && crowdMap[stationID]) {
            crowdLevel = crowdMap[stationID];
        }

        finalData.push({
            stationID: stationID,
            stationName: stationName,
            destination: item.DestinationName.replace('站', ''),
            lineNo: lineNo,
            time: seconds,
            crowdLevel: crowdLevel, // 加入擁擠度
            type: 'live'
        });
    });

    globalCache.data = finalData;
    globalCache.serverTime = new Date().toISOString(); // 回傳 ISO 時間
    globalCache.success = true;
    globalCache.message = "資料更新完成";
    console.log(`✅ 更新完成: ${finalData.length} 筆列車資料`);
}

// 啟動流程
fetchStationMapping().then(() => {
    updateData();
    // 設定 30 秒更新一次 (符合你的需求)
    setInterval(updateData, 30000);
});

// API路由
app.get('/', (req, res) => res.send(`Server Running. Data Count: ${globalCache.data.length}`));
app.get('/api/trains', (req, res) => {
    // 這裡我們回傳 serverTime 讓前端做校正
    res.json({
        success: globalCache.success,
        serverTime: new Date().toISOString(), // 請求當下的精確時間
        data: globalCache.data
    });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));