/* mrt-server/server.js */
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const xml2js = require('xml2js');
const app = express();

app.use(cors());

const PORT = process.env.PORT || 3000;

// ⚠️⚠️⚠️ 請務必確認這裡填入的是正確的官方 API 帳號與密碼
const MRT_USER = process.env.MRT_USER || '';
const MRT_PASS = process.env.MRT_PASS || '';

// TDX 設定 (選填)
const TDX_CLIENT_ID = process.env.TDX_CLIENT_ID || '';
const TDX_CLIENT_SECRET = process.env.TDX_CLIENT_SECRET || '';

let globalCache = {
  success: false,
  message: "系統初始化中...",
  serverTime: null,
  data: [],
  nameToIdMap: {} 
};

// 輔助：解析 XML (啟用 stripPrefix 以忽略 soap: 前綴)
const parseXML = async (xml) => {
    // stripPrefix: true 會把 <soap:Envelope> 變成 <Envelope>，方便讀取
    const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: true, stripPrefix: true });
    try {
        return await parser.parseStringPromise(xml);
    } catch (e) {
        console.error("XML Parsing Failed:", e.message);
        return null;
    }
};

// 1. 取得 TDX 站名對照表
async function fetchStationMapping() {
    if (!TDX_CLIENT_ID || !TDX_CLIENT_SECRET) {
        console.log("⚠️ 未設定 TDX 帳號，將略過車站 ID 對照");
        return;
    }
    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', TDX_CLIENT_ID);
        params.append('client_secret', TDX_CLIENT_SECRET);
        const tokenRes = await axios.post('https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', params);
        const token = tokenRes.data.access_token;

        const res = await axios.get('https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/Station/TRTC', {
            headers: { 'Authorization': `Bearer ${token}` },
            params: { '$format': 'JSON' }
        });
        
        if (res.data) {
            res.data.forEach(st => {
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
        if (!parsed || !parsed['Envelope'] || !parsed['Envelope']['Body']) {
            console.error("❌ TrackInfo 解析失敗，API 可能回傳了錯誤訊息:", res.data);
            return [];
        }

        // 注意：因為用了 stripPrefix，這裡沒有 soap: 前綴
        const responseBody = parsed['Envelope']['Body']['getTrackInfoResponse'];
        if (!responseBody) {
             // 有時候可能是 Fault
             console.error("❌ TrackInfo 回傳結構不如預期:", JSON.stringify(parsed));
             return [];
        }

        const rawJson = responseBody['getTrackInfoResult'];
        return JSON.parse(rawJson);
    } catch (e) {
        console.error("TrackInfo Error:", e.message);
        return [];
    }
}

// 3. 官方 API: 擁擠度 (高運量 + 文湖線)
async function fetchCrowdedness() {
    let crowdednessMap = {}; 

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
            
            if (!parsed || !parsed['Envelope'] || !parsed['Envelope']['Body']) return [];

            const result = parsed['Envelope']['Body'][`${method}Response`];
            if (!result) return [];

            const rawJson = result[`${method}Result`];
            return JSON.parse(rawJson);
        } catch (e) { 
            console.error(`Crowdedness API (${method}) Error:`, e.message);
            return []; 
        }
    };

    const [highCap, wenhu] = await Promise.all([
        fetchAPI('https://api.metro.taipei/metroapi/CarWeight.asmx', 'getCarWeightByInfoEx'),
        fetchAPI('https://api.metro.taipei/metroapi/CarWeightBR.asmx', 'getCarWeightBRInfo')
    ]);

    const process = (list) => {
        if (!list || !Array.isArray(list)) return;
        list.forEach(train => {
            if (train.StationID) {
                let maxLevel = 1;
                // 高運量有 Car1~Car6
                for (let i = 1; i <= 6; i++) {
                    if (train[`Car${i}`]) maxLevel = Math.max(maxLevel, parseInt(train[`Car${i}`]) || 1);
                }
                // 文湖線可能只有 Car1, Car2 (或 pair)
                
                let levelStr = 'LOW';
                if (maxLevel === 2) levelStr = 'MEDIUM';
                if (maxLevel === 3) levelStr = 'HIGH';
                if (maxLevel >= 4) levelStr = 'FULL';
                
                crowdednessMap[train.StationID] = levelStr;
            }
        });
    };

    process(highCap);
    process(wenhu);
    return crowdednessMap;
}

async function updateData() {
    console.log("🔄 開始更新資料...");
    const [trackInfo, crowdMap] = await Promise.all([fetchTrackInfo(), fetchCrowdedness()]);
    
    let finalData = [];
    if (Array.isArray(trackInfo)) {
        trackInfo.forEach(item => {
            const stationName = item.StationName.replace('站', ''); 
            const stationID = globalCache.nameToIdMap[stationName] || item.StationName;
            
            let seconds = 0;
            if (item.CountDown === '列車進站') {
                seconds = 0;
            } else if (item.CountDown && item.CountDown.includes(':')) {
                const parts = item.CountDown.split(':');
                seconds = parseInt(parts[0]) * 60 + parseInt(parts[1]);
            } else {
                seconds = 9999;
            }

            let lineNo = 'Unknown';
            if (stationID && stationID.match(/^[A-Z]+/)) {
                lineNo = stationID.match(/^[A-Z]+/)[0];
            }

            let crowdLevel = 'LOW';
            // 如果列車接近 (例如 < 60秒)，嘗試連結該站的擁擠度資料
            if (seconds < 60 && crowdMap[stationID]) {
                crowdLevel = crowdMap[stationID];
            }

            finalData.push({
                stationID: stationID,
                stationName: stationName,
                destination: item.DestinationName.replace('站', ''),
                lineNo: lineNo,
                time: seconds,
                crowdLevel: crowdLevel,
                type: 'live'
            });
        });
        
        globalCache.data = finalData;
        globalCache.serverTime = new Date().toISOString();
        globalCache.success = true;
        globalCache.message = "資料更新完成";
        console.log(`✅ 更新完成: ${finalData.length} 筆列車資料`);
    } else {
        console.log("⚠️ 更新失敗: TrackInfo 回傳非陣列資料");
    }
}

fetchStationMapping().then(() => {
    updateData();
    setInterval(updateData, 30000);
});

app.get('/', (req, res) => res.send(`Server Running. Data Count: ${globalCache.data.length}`));
app.get('/api/trains', (req, res) => {
    res.json({
        success: globalCache.success,
        serverTime: new Date().toISOString(),
        data: globalCache.data
    });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));