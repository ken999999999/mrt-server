// server.js － TRTC API Proxy（不需要 CAR_ID_LIST 版）

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const xml2js = require('xml2js');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// 捷運 API 帳密（Render 的 Environment 裡要設定）
const MRT_USER = process.env.MRT_USER;
const MRT_PASS = process.env.MRT_PASS;

// ---- 官方網址 ----
// 列車位置（文湖線 / 板南線）
const TRAININFO_ENDPOINT =
  'https://mobileapp.metro.taipei/TRTCTraininfo/TrainTimeControl.asmx';

// 高運量車廂擁擠度
const CARWEIGHT_ENDPOINT =
  'https://api.metro.taipei/metroapi/CarWeight.asmx';

// 列車到站資訊
const TRACKINFO_ENDPOINT =
  'https://api.metro.taipei/metroapi/TrackInfo.asmx';

// 啟動時印一下設定
console.log('========================================');
console.log('🚆 MRT proxy starting...');
console.log('PORT =', PORT);
console.log('MRT_USER set:', !!MRT_USER);
console.log('MRT_PASS set:', !!MRT_PASS);
console.log('========================================');

const xmlParser = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: false,
  tagNameProcessors: [xml2js.processors.stripPrefix],
});

// 判斷字串是不是 JSON（有些 API 會在 XML 前面塞 JSON）
function looksLikeJson(str) {
  if (typeof str !== 'string') return false;
  const s = str.trim();
  return (
    (s.startsWith('{') && s.endsWith('}')) ||
    (s.startsWith('[') && s.endsWith(']'))
  );
}

// 共用：解析 TRTC 回傳（前面可能有 JSON，後面是 SOAP XML）
async function parseSoapResponse(rawData, responseNameHint) {
  const bodyStr = typeof rawData === 'string' ? rawData : String(rawData);

  // 被擋或導錯頁時常會回 HTML
  if (
    bodyStr.trim().startsWith('<!DOCTYPE html') ||
    bodyStr.includes('<html')
  ) {
    console.error(
      '❌ HTML returned instead of SOAP/XML. First 200 chars:'
    );
    console.error(bodyStr.slice(0, 200));
    throw new Error(
      'TRTC API returned HTML (maybe IP restricted or bad credentials)'
    );
  }

  // 嘗試抓前面的 JSON（如果有）
  let jsonPart = null;
  const jsonStart = bodyStr.indexOf('{');
  const jsonEnd = bodyStr.indexOf('}</');
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    const jsonText = bodyStr.slice(jsonStart, jsonEnd + 1);
    try {
      jsonPart = JSON.parse(jsonText);
    } catch (e) {
      console.warn('⚠️ Failed to parse leading JSON:', e.message);
    }
  }

  // 抓 XML 部分
  const xmlStart = bodyStr.indexOf('<?xml');
  if (xmlStart === -1) {
    console.error('❌ No XML found in response. First 200 chars:');
    console.error(bodyStr.slice(0, 200));
    throw new Error('No XML found in TRTC API response');
  }
  const xmlText = bodyStr.slice(xmlStart);

  let parsedXml;
  try {
    parsedXml = await xmlParser.parseStringPromise(xmlText);
  } catch (e) {
    console.error('❌ Failed to parse XML:', e.message);
    throw new Error('Failed to parse XML from TRTC API');
  }

  const envelope = parsedXml.Envelope;
  const body = envelope && envelope.Body;
  if (!body) {
    throw new Error('SOAP response has no Body');
  }

  let soapNode = body;

  // 盡量往 *xxxResponse* 那個節點抓
  if (responseNameHint) {
    const hintLower = responseNameHint.toLowerCase();
    const key = Object.keys(body).find((k) =>
      k.toLowerCase().includes(hintLower)
    );
    if (key) soapNode = body[key];
  }

  return {
    raw: bodyStr,
    json: jsonPart,
    soap: soapNode,
  };
}

/* =======================
 *  呼叫各個 TRTC API
 * ======================= */

// 1. 列車位置（GetTrainInfo，給 /api/train/:carId 用）
//    這支「一定有成功」的紀錄，所以保留 SOAPAction
async function callGetTrainInfo(carId) {
  if (!MRT_USER || !MRT_PASS) {
    throw new Error('MRT_USER / MRT_PASS not set');
  }

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetTrainInfo xmlns="http://tempuri.org/">
      <carID>${carId}</carID>
      <username>${MRT_USER}</username>
      <password>${MRT_PASS}</password>
    </GetTrainInfo>
  </soap:Body>
</soap:Envelope>`;

  const res = await axios.post(TRAININFO_ENDPOINT, soapBody, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: 'http://tempuri.org/GetTrainInfo',
    },
    timeout: 10000,
  });

  return parseSoapResponse(res.data, 'GetTrainInfoResponse');
}

// 2. 高運量車廂擁擠度（getCarWeightByInfoEx）
//    這支照官方文件，只送 Content-Type，不送 SOAPAction
async function callCarWeightEx() {
  if (!MRT_USER || !MRT_PASS) {
    throw new Error('MRT_USER / MRT_PASS not set');
  }

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getCarWeightByInfoEx xmlns="http://tempuri.org/">
      <userName>${MRT_USER}</userName>
      <passWord>${MRT_PASS}</passWord>
    </getCarWeightByInfoEx>
  </soap:Body>
</soap:Envelope>`;

  const res = await axios.post(CARWEIGHT_ENDPOINT, soapBody, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
    },
    timeout: 10000,
  });

  return parseSoapResponse(res.data, 'getCarWeightByInfoExResponse');
}

// 3. 列車到站資訊（getTrackInfo）
async function callTrackInfo() {
  if (!MRT_USER || !MRT_PASS) {
    throw new Error('MRT_USER / MRT_PASS not set');
  }

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <getTrackInfo xmlns="http://tempuri.org/">
      <userName>${MRT_USER}</userName>
      <passWord>${MRT_PASS}</passWord>
    </getTrackInfo>
  </soap:Body>
</soap:Envelope>`;

  const res = await axios.post(TRACKINFO_ENDPOINT, soapBody, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
    },
    timeout: 10000,
  });

  return parseSoapResponse(res.data, 'getTrackInfoResponse');
}

/* =======================
 *  把 SOAP 轉成陣列
 * ======================= */

function extractItemsFromSoap(soap) {
  if (!soap) return [];

  if (looksLikeJson(soap)) {
    try {
      const parsed = JSON.parse(soap);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  if (typeof soap === 'object') {
    if (Array.isArray(soap)) return soap;

    for (const k of Object.keys(soap)) {
      const v = soap[k];
      if (!v) continue;
      if (Array.isArray(v)) return v;
      if (typeof v === 'string' && looksLikeJson(v)) {
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          continue;
        }
      }
    }
  }

  return [];
}

// 判斷到站資料是否屬於指定車站
function matchStation(item, stationId) {
  if (!item || !stationId) return false;
  const sid = stationId.toString().toUpperCase();
  const keys = [
    'SID',
    'StationID',
    'StationId',
    'StationNo',
    'StationCode',
    'StnNo',
    'StnId',
    'StnID',
    'StaCode',
  ];
  return keys.some((k) => {
    const v = item[k];
    if (!v) return false;
    return String(v).toUpperCase() === sid;
  });
}

// 判斷擁擠度資料是否屬於指定列車
function matchTrainForCrowd(item, trainId) {
  if (!item || !trainId) return false;
  const tid = String(trainId).toUpperCase();
  const keys = ['TrainID', 'TrainId', 'TrainNo', 'CarID', 'CarId'];
  return keys.some((k) => {
    const v = item[k];
    if (!v) return false;
    return String(v).toUpperCase() === tid;
  });
}

/* =======================
 *  全域快取
 * ======================= */

let globalCache = {
  success: false,
  lastUpdate: null,
  trackInfo: null,
  trackItems: [],
  carWeight: null,
  carWeightItems: [],
  message: 'initializing',
};

async function refreshAll() {
  if (!MRT_USER || !MRT_PASS) {
    globalCache = {
      success: false,
      lastUpdate: new Date().toISOString(),
      trackInfo: null,
      trackItems: [],
      carWeight: null,
      carWeightItems: [],
      message: 'MRT_USER / MRT_PASS not set',
    };
    console.error('❌ MRT_USER / MRT_PASS not set');
    return;
  }

  console.log('🔄 Refreshing TRTC data...');

  try {
    const [trackRes, weightRes] = await Promise.all([
      callTrackInfo().catch((e) => ({ error: e.message })),
      callCarWeightEx().catch((e) => ({ error: e.message })),
    ]);

    globalCache = {
      success: true,
      lastUpdate: new Date().toISOString(),
      trackInfo: trackRes && !trackRes.error ? trackRes.soap : null,
      trackItems:
        trackRes && !trackRes.error
          ? extractItemsFromSoap(trackRes.soap)
          : [],
      carWeight: weightRes && !weightRes.error ? weightRes.soap : null,
      carWeightItems:
        weightRes && !weightRes.error
          ? extractItemsFromSoap(weightRes.soap)
          : [],
      message: null,
    };

    if (trackRes && trackRes.error) {
      console.error('⚠️ callTrackInfo error:', trackRes.error);
    }
    if (weightRes && weightRes.error) {
      console.error('⚠️ callCarWeightEx error:', weightRes.error);
    }

    console.log('✅ Refresh done.');
  } catch (e) {
    console.error('❌ refreshAll threw error:', e);
    globalCache = {
      success: false,
      lastUpdate: new Date().toISOString(),
      trackInfo: null,
      trackItems: [],
      carWeight: null,
      carWeightItems: [],
      message: e.message,
    };
  }
}

// 啟動時先更新一次，之後每 30 秒更新
refreshAll();
setInterval(refreshAll, 30000);

/* =======================
 *  路由
 * ======================= */

// 簡單健康檢查
app.get('/', (req, res) => {
  res.send(
    `MRT proxy running. lastUpdate=${globalCache.lastUpdate}, trackItems=${globalCache.trackItems.length}`
  );
});

// 原始到站資訊（debug 用）
app.get('/api/raw/track-info', (req, res) => {
  res.json({
    success: !!globalCache.trackInfo,
    lastUpdate: globalCache.lastUpdate,
    soap: globalCache.trackInfo,
    itemsPreview: globalCache.trackItems.slice(0, 5),
  });
});

// 原始擁擠度（debug 用）
app.get('/api/raw/car-weight', (req, res) => {
  res.json({
    success: !!globalCache.carWeight,
    lastUpdate: globalCache.lastUpdate,
    soap: globalCache.carWeight,
    itemsPreview: globalCache.carWeightItems.slice(0, 5),
  });
});

// 以「車站」為主：/api/station/BL12
app.get('/api/station/:stationId', (req, res) => {
  const stationId = req.params.stationId;
  const allItems = globalCache.trackItems || [];
  const byStation = allItems.filter((it) => matchStation(it, stationId));

  const crowdItems = globalCache.carWeightItems || [];

  const enriched = byStation.map((it) => {
    const candidateTrainKeys = [
      'TrainID',
      'TrainId',
      'TrainNo',
      'CarID',
      'CarId',
    ];
    let trainId = null;
    for (const k of candidateTrainKeys) {
      if (it[k]) {
        trainId = it[k];
        break;
      }
    }

    let crowd = null;
    if (trainId) {
      crowd = crowdItems.filter((cw) =>
        matchTrainForCrowd(cw, trainId)
      );
    }

    return {
      stationId,
      raw: it, // 原始到站資料（裡面會有倒數、目的地等欄位）
      trainId,
      crowd, // 這班車對到的擁擠度資料（可能多筆，代表不同車廂）
    };
  });

  res.json({
    success: true,
    stationId,
    lastUpdate: globalCache.lastUpdate,
    count: enriched.length,
    trains: enriched,
    note:
      '欄位名稱目前先用猜的（SID, StationID, TrainID 等），請先看 /api/raw/track-info /api/raw/car-weight 的欄位，再視需要調整 matchStation / matchTrainForCrowd。',
  });
});

// 單次查某一個車號的位置（如果你前端要用）
app.get('/api/train/:carId', async (req, res) => {
  const carId = req.params.carId;
  try {
    const info = await callGetTrainInfo(carId);
    res.json({
      success: true,
      carId,
      apiTrainInfoJson: info.json || null,
      apiTrainInfoSoap: info.soap || null,
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      carId,
      message: e.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 MRT server listening on port ${PORT}`);
});