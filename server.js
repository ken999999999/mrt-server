require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const xml2js = require('xml2js');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// 捷運 API 帳密
const MRT_USER = process.env.MRT_USER;
const MRT_PASS = process.env.MRT_PASS;

// 可選：想額外追蹤的車號（給 GetTrainInfo 用，不給也可以）
const CAR_ID_LIST = (process.env.CAR_ID_LIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ---- 官方網址 & SOAPAction ----
const TRAININFO_ENDPOINT =
  'https://mobileapp.metro.taipei/TRTCTraininfo/TrainTimeControl.asmx';
const TRAININFO_SOAP_ACTION = 'http://tempuri.org/GetTrainInfo';

const CARWEIGHT_ENDPOINT =
  'https://api.metro.taipei/metroapi/CarWeight.asmx';
const CARWEIGHTEX_SOAP_ACTION = 'http://tempuri.org/getCarWeightByInfoEx';

const TRACKINFO_ENDPOINT =
  'https://api.metro.taipei/metroapi/TrackInfo.asmx';
const TRACKINFO_SOAP_ACTION = 'http://tempuri.org/getTrackInfo';

console.log('========================================');
console.log('🚆 MRT server starting...');
console.log('PORT =', PORT);
console.log('MRT_USER set:', !!MRT_USER);
console.log('MRT_PASS set:', !!MRT_PASS);
console.log('CAR_ID_LIST =', CAR_ID_LIST);
console.log('========================================');

const xmlParser = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: false,
  tagNameProcessors: [xml2js.processors.stripPrefix],
});

// 判斷字串是不是 JSON
function looksLikeJson(str) {
  if (typeof str !== 'string') return false;
  const s = str.trim();
  return (s.startsWith('{') && s.endsWith('}')) ||
         (s.startsWith('[') && s.endsWith(']'));
}

// 解析 TRTC 回傳（前面可能有 JSON，後面是 SOAP XML）
async function parseSoapResponse(rawData, responseNameHint) {
  const bodyStr = typeof rawData === 'string' ? rawData : String(rawData);

  // 如果是 HTML，大概是被擋或導錯頁
  if (bodyStr.trim().startsWith('<!DOCTYPE html') || bodyStr.includes('<html')) {
    console.error('❌ HTML returned instead of SOAP/XML. First 200 chars:');
    console.error(bodyStr.slice(0, 200));
    throw new Error('TRTC API returned HTML (maybe IP restricted or bad credentials)');
  }

  // 嘗試抓「前面那段 JSON」
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

// ---- 呼叫各個 API ----

// 列車位置（用 carID）
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
      SOAPAction: TRAININFO_SOAP_ACTION,
    },
    timeout: 10000,
  });

  return parseSoapResponse(res.data, 'GetTrainInfoResponse');
}

// 高運量車廂擁擠度
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
      SOAPAction: CARWEIGHTEX_SOAP_ACTION,
    },
    timeout: 10000,
  });

  return parseSoapResponse(res.data, 'getCarWeightByInfoExResponse');
}

// 列車到站資訊
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
      SOAPAction: TRACKINFO_SOAP_ACTION,
    },
    timeout: 10000,
  });

  return parseSoapResponse(res.data, 'getTrackInfoResponse');
}

// ---- 把 SOAP 統一整理成 array ----

function extractTrackItems(soap) {
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

function extractCarWeightItems(soap) {
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

// 判斷一筆到站資訊是不是指定車站
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

// 把擁擠度資料對應到指定列車
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

// ---- 全域快取 ----

let globalCache = {
  success: false,
  lastUpdate: null,
  trains: [],
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
      trains: [],
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

    const trains = [];
    for (const carId of CAR_ID_LIST) {
      try {
        const info = await callGetTrainInfo(carId);
        trains.push({
          carId,
          error: null,
          apiTrainInfoJson: info.json || null,
          apiTrainInfoSoap: info.soap || null,
        });
      } catch (e) {
        console.error(`❌ GetTrainInfo failed for carId=${carId}:`, e.message);
        trains.push({
          carId,
          error: e.message,
          apiTrainInfoJson: null,
          apiTrainInfoSoap: null,
        });
      }
    }

    globalCache = {
      success: true,
      lastUpdate: new Date().toISOString(),
      trains,
      trackInfo: trackRes && !trackRes.error ? trackRes.soap : null,
      trackItems:
        trackRes && !trackRes.error ? extractTrackItems(trackRes.soap) : [],
      carWeight: weightRes && !weightRes.error ? weightRes.soap : null,
      carWeightItems:
        weightRes && !weightRes.error ? extractCarWeightItems(weightRes.soap) : [],
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
      trains: [],
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

// ---- 路由 ----

app.get('/', (req, res) => {
  res.send(
    `MRT proxy running. lastUpdate=${globalCache.lastUpdate} items=${globalCache.trackItems.length}`
  );
});

// 原始到站資訊（debug 用，方便看欄位）
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

// 以「車站」為主的 API：/api/station/BL12
app.get('/api/station/:stationId', (req, res) => {
  const stationId = req.params.stationId;
  const allItems = globalCache.trackItems || [];
  const byStation = allItems.filter((it) => matchStation(it, stationId));

  const crowdItems = globalCache.carWeightItems || [];

  const enriched = byStation.map((it) => {
    const candidateTrainKeys = ['TrainID', 'TrainId', 'TrainNo', 'CarID', 'CarId'];
    let trainId = null;
    for (const k of candidateTrainKeys) {
      if (it[k]) {
        trainId = it[k];
        break;
      }
    }

    let crowd = null;
    if (trainId) {
      crowd = crowdItems.filter((cw) => matchTrainForCrowd(cw, trainId));
    }

    return {
      stationId,
      raw: it,       // 原始一筆到站資料（裡面會有倒數、目的地等欄位）
      trainId,
      crowd,         // 這班車對到的擁擠度資料（可能多筆，代表不同車廂）
    };
  });

  res.json({
    success: true,
    stationId,
    lastUpdate: globalCache.lastUpdate,
    count: enriched.length,
    trains: enriched,
    note:
      '欄位名稱是先用猜的（SID, StationID, TrainID 等），你可以先看 /api/raw/track-info /api/raw/car-weight 回傳的欄位，再改 matchStation / matchTrainForCrowd 讓結果更準。',
  });
});

// 直接查單一車號的位置（如果你之後要用，可選）
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

// 回傳目前快取到的車號資料（如果有設定 CAR_ID_LIST 才會有）
app.get('/api/trains', (req, res) => {
  res.json({
    success: globalCache.success,
    lastUpdate: globalCache.lastUpdate,
    carIds: CAR_ID_LIST,
    trains: globalCache.trains,
    trackItemsCount: globalCache.trackItems.length,
    carWeightItemsCount: globalCache.carWeightItems.length,
  });
});

app.listen(PORT, () => {
  console.log(`🚀 MRT server listening on port ${PORT}`);
});