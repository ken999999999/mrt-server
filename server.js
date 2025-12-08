// server.js - Taipei Metro TrackInfo + CarWeight backend (TrackInfo + CarWeightEx + CarWeightBR)

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// 在 Render / 本機 .env 設定：MRT_USER / MRT_PASS
const MRT_USER = process.env.MRT_USER;
const MRT_PASS = process.env.MRT_PASS;

if (!MRT_USER || !MRT_PASS) {
  console.warn('⚠️ MRT_USER / MRT_PASS 尚未設定，請在環境變數中設定捷運提供的帳號密碼。');
}

// TRTC endpoints
const TRACK_INFO_URL = 'https://api.metro.taipei/metroapi/TrackInfo.asmx';
const CAR_WEIGHT_EX_URL = 'https://api.metro.taipei/metroapi/CarWeight.asmx';     // getCarWeightByInfoEx（全部高運量線，不含文湖）
const CAR_WEIGHT_BR_URL = 'https://api.metro.taipei/metroapi/CarWeightBR.asmx';   // getCarWeightBRInfo（文湖線）

// 簡單的全域快取
const cache = {
  lastUpdate: null,
  trackInfo: [],
  carWeight: [],  // Ex + BR 合併後的全部擁擠度
  merged: [],
  ok: false,
};

// ====== SOAP body（依照你 Postman 成功的格式） ======
function buildTrackInfoSoap() {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <getTrackInfo xmlns="http://tempuri.org/">
      <userName>${MRT_USER}</userName>
      <passWord>${MRT_PASS}</passWord>
    </getTrackInfo>
  </soap12:Body>
</soap12:Envelope>`;
}

// 高運量（板南、淡水信義、中和新蘆、松山新店…）擁擠度
function buildCarWeightExSoap() {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <getCarWeightByInfoEx xmlns="http://tempuri.org/">
      <userName>${MRT_USER}</userName>
      <passWord>${MRT_PASS}</passWord>
    </getCarWeightByInfoEx>
  </soap12:Body>
</soap12:Envelope>`;
}

// 文湖線擁擠度
function buildCarWeightBRSoap() {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <getCarWeightBRInfo xmlns="http://tempuri.org/">
      <userName>${MRT_USER}</userName>
      <passWord>${MRT_PASS}</passWord>
    </getCarWeightBRInfo>
  </soap12:Body>
</soap12:Envelope>`;
}

// ====== 共用：從 SOAP 字串裡抓 JSON 陣列 ======
function extractJsonArrayFromSoap(raw, tagName) {
  if (typeof raw !== 'string') {
    raw = String(raw);
  }

  // 粗略檢查有沒有錯誤頁
  if (raw.includes('<title>請洽系統管理員') || raw.includes('<html')) {
    console.error(`❌ ${tagName} 收到 HTML 錯誤頁，無法解析 JSON。`);
    return [];
  }

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    console.error(`❌ ${tagName} 找不到 JSON 陣列 [ ... ]，raw 前 200 字：`, raw.slice(0, 200));
    return [];
  }

  const jsonSlice = raw.slice(start, end + 1);

  // helper: 把 parse 結果統一轉成陣列
  const normalizeParsed = (parsed) => {
    if (typeof parsed === 'string') {
      // 如果是字串，再 parse 一次
      return JSON.parse(parsed);
    }
    if (Array.isArray(parsed)) {
      return parsed;
    }
    // 其他型別就當作沒有資料
    return [];
  };

  // 第一輪：直接 parse
  try {
    const parsed = JSON.parse(jsonSlice);
    return normalizeParsed(parsed);
  } catch (e1) {
    // 第二輪：把 \" 還原成 " 再試一次（某些 API 會是這種格式）
    try {
      const unescaped = jsonSlice
        .replace(/\\"/g, '"')   // 把 \" 變回 "
        .replace(/\\\\/g, '\\'); // 把 \\ 變回 \
      const parsed2 = JSON.parse(unescaped);
      return normalizeParsed(parsed2);
    } catch (e2) {
      console.error(`❌ ${tagName} 解析 JSON 失敗 (兩次皆失敗):`, e2.message, '片段=', jsonSlice.slice(0, 200));
      return [];
    }
  }
}

// ====== 呼叫 TRTC 3 支 API ======
async function fetchTrackInfo() {
  const soapBody = buildTrackInfoSoap();
  const res = await axios.post(TRACK_INFO_URL, soapBody, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    timeout: 10000,
  });
  return extractJsonArrayFromSoap(res.data, 'TrackInfo');
}

async function fetchCarWeightEx() {
  const soapBody = buildCarWeightExSoap();
  const res = await axios.post(CAR_WEIGHT_EX_URL, soapBody, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    timeout: 10000,
  });
  return extractJsonArrayFromSoap(res.data, 'CarWeightEx');
}

async function fetchCarWeightBR() {
  const soapBody = buildCarWeightBRSoap();
  const res = await axios.post(CAR_WEIGHT_BR_URL, soapBody, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    timeout: 10000,
  });
  return extractJsonArrayFromSoap(res.data, 'CarWeightBR');
}

async function fetchCarWeightAll() {
  const [exList, brList] = await Promise.all([
    fetchCarWeightEx(),
    fetchCarWeightBR(),
  ]);

  // 給每筆加上 lineType 方便除錯 / 未來 UI 用
  exList.forEach(row => { row.lineType = 'HighCapacity'; }); // 高運量線（板南、淡水信義、松山新店、中和新蘆…）
  brList.forEach(row => { row.lineType = 'Wenhu'; });        // 文湖線 BR

  return [...exList, ...brList];
}

// 將 TrackInfo + CarWeight 合併（用 TrainNumber 當 key）
function mergeTrackAndWeight(trackList, weightList) {
  const weightByTrain = new Map();
  (weightList || []).forEach(row => {
    const num = row.TrainNumber != null ? String(row.TrainNumber).trim() : '';
    if (!num) return;
    weightByTrain.set(num, row);
  });

  return (trackList || []).map(row => {
    const num = row.TrainNumber != null ? String(row.TrainNumber).trim() : '';
    const w = weightByTrain.get(num) || null;
    return {
      trainNumber: num,
      stationName: row.StationName || null,
      destinationName: row.DestinationName || null,
      countDown: row.CountDown || null,
      nowDateTime: row.NowDateTime || null,
      rawTrack: row,
      rawCrowd: w,
    };
  });
}

// 站碼對中文站名（先幫你放一個忠孝新生，之後可以自己擴充）
const stationIdToName = {
  BL12: '忠孝新生站',
};

// CarWeight 裡的 StationID 對 stationId
function trainsByStationId(stationId, trackList, weightList) {
  const sid = stationId.toUpperCase();
  const weightRows = (weightList || []).filter(row => {
    const rowId = row.StationID != null ? String(row.StationID).toUpperCase() : '';
    return rowId === sid;
  });

  const trackByTrain = new Map();
  (trackList || []).forEach(row => {
    const num = row.TrainNumber != null ? String(row.TrainNumber).trim() : '';
    if (!num) return;
    trackByTrain.set(num, row);
  });

  return weightRows.map(row => {
    const num = row.TrainNumber != null ? String(row.TrainNumber).trim() : '';
    const t = trackByTrain.get(num) || null;
    return {
      trainNumber: num,
      stationId: row.StationID || null,
      stationName: row.StationName || null,
      destinationName: t?.DestinationName || null,
      countDown: t?.CountDown || null,
      nowDateTime: t?.NowDateTime || null,
      rawTrack: t,
      rawCrowd: row,
    };
  });
}

// ====== 定期更新快取 ======
async function updateAll() {
  if (!MRT_USER || !MRT_PASS) {
    console.error('❌ MRT_USER / MRT_PASS 尚未設定，無法呼叫 TRTC API');
    cache.ok = false;
    return;
  }

  try {
    console.log('⏳ 正在更新 TrackInfo / CarWeightEx / CarWeightBR …');

    const [trackList, weightAll] = await Promise.all([
      fetchTrackInfo(),
      fetchCarWeightAll(),
    ]);

    cache.lastUpdate = new Date().toISOString();
    cache.trackInfo = trackList;
    cache.carWeight = weightAll;
    cache.merged = mergeTrackAndWeight(trackList, weightAll);
    cache.ok = true;

    console.log(
      `✅ 更新完成：TrackInfo=${trackList.length} 筆, CarWeightAll=${weightAll.length} 筆, merged=${cache.merged.length} 筆`
    );
  } catch (e) {
    console.error('❌ 更新資料失敗:', e.message);
    cache.ok = false;
  }
}

// 啟動時先更新一次，之後每 30 秒更新
updateAll();
setInterval(updateAll, 30000);

// ====== Routes ======
app.get('/', (req, res) => {
  res.json({
    ok: cache.ok,
    message: 'TRTC API proxy running',
    lastUpdate: cache.lastUpdate,
    counts: {
      trackInfo: cache.trackInfo.length,
      carWeight: cache.carWeight.length,
      merged: cache.merged.length,
    },
  });
});

// 原始列車到站資訊
app.get('/api/raw/track-info', (req, res) => {
  res.json({
    success: cache.ok,
    lastUpdate: cache.lastUpdate,
    count: cache.trackInfo.length,
    items: cache.trackInfo,
  });
});

// 原始擁擠度資料（高運量 + 文湖線）
app.get('/api/raw/car-weight', (req, res) => {
  res.json({
    success: cache.ok,
    lastUpdate: cache.lastUpdate,
    count: cache.carWeight.length,
    items: cache.carWeight,
  });
});

// 查某一個站碼（例如 BL12：忠孝新生）
app.get('/api/station/:stationId', (req, res) => {
  const stationId = req.params.stationId.toUpperCase();
  const stationName = stationIdToName[stationId] || stationId;

  const trains = trainsByStationId(
    stationId,
    cache.trackInfo,
    cache.carWeight
  );

  res.json({
    success: cache.ok,
    stationId,
    stationName,
    lastUpdate: cache.lastUpdate,
    count: trains.length,
    trains,
    note: 'StationID 目前抓的是 CarWeight JSON 裡的 StationID 欄位。stationIdToName 只先填 BL12=忠孝新生站，之後可以自行擴充。',
  });
});

// 所有列車（合併 TrackInfo + CarWeight）
app.get('/api/trains', (req, res) => {
  res.json({
    success: cache.ok,
    lastUpdate: cache.lastUpdate,
    count: cache.merged.length,
    data: cache.merged,
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
