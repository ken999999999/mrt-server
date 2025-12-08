/* mrt-server/server.js - Taipei Metro crowding + arrival backend */
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const xml2js = require('xml2js');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// ====== TRTC SOAP credentials (放在 Render 環境變數 MRT_USER / MRT_PASS) ======
const MRT_USER = process.env.MRT_USER;
const MRT_PASS = process.env.MRT_PASS;

// TRTC SOAP endpoints
const TRACK_INFO_URL = 'https://api.metro.taipei/metroapi/TrackInfo.asmx';
const CAR_WEIGHT_URL = 'https://api.metro.taipei/metroapi/CarWeight.asmx';

// Simple in-memory cache
const globalCache = {
  lastUpdate: null,
  trackInfo: [],
  carWeight: [],
  success: false,
  data: []  // merged trains list for /api/trains
};

// xml2js parser (stripPrefix: 把 soap: 前綴拿掉)
const xmlParser = new xml2js.Parser({
  explicitArray: false,
  tagNameProcessors: [xml2js.processors.stripPrefix]
});

// ===== SOAP body builders =====
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

function buildCarWeightSoap() {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Body>
    <getCarWeightByInfo xmlns="http://tempuri.org/">
      <userName>${MRT_USER}</userName>
      <passWord>${MRT_PASS}</passWord>
    </getCarWeightByInfo>
  </soap12:Body>
</soap12:Envelope>`;
}

// ===== Helpers =====
async function parseSoapJsonResult(xml, responseKey, resultKey) {
  try {
    const parsed = await xmlParser.parseStringPromise(xml);
    const body = parsed?.Envelope?.Body;
    if (!body) {
      console.error('❌ SOAP 沒有 Envelope/Body:', xml.slice(0, 200));
      return [];
    }
    const response = body[responseKey];
    if (!response) {
      console.error(`❌ 找不到 ${responseKey}:`, JSON.stringify(body).slice(0, 500));
      return [];
    }

    const jsonText =
      response[resultKey] ||
      // 萬一 key 名字大小寫不一樣，保守一點：找第一個字串欄位
      Object.values(response).find(v => typeof v === 'string');

    if (!jsonText || typeof jsonText !== 'string') {
      console.error(`❌ 找不到 ${resultKey} 或字串內容:`, JSON.stringify(response).slice(0, 500));
      return [];
    }

    const trimmed = jsonText.trim();
    if (!trimmed) return [];

    // 真正的 JSON 在中括號裡，保險一點抓 [ ... ] 這一段
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    const jsonSlice = (start !== -1 && end !== -1 && end > start)
      ? trimmed.slice(start, end + 1)
      : trimmed;

    try {
      const first = JSON.parse(jsonSlice);
      if (typeof first === 'string') {
        // 有些情況會是 JSON 字串，再 parse 一次
        return JSON.parse(first);
      }
      if (Array.isArray(first)) return first;
      return [];
    } catch (e) {
      console.error('❌ 解析 JSON 失敗:', e.message, 'raw=', jsonSlice.slice(0, 200));
      return [];
    }
  } catch (e) {
    console.error('❌ 解析 SOAP XML 失敗:', e.message);
    return [];
  }
}

async function fetchTrackInfo() {
  const soapBody = buildTrackInfoSoap();
  const res = await axios.post(TRACK_INFO_URL, soapBody, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    timeout: 10000
  });
  return parseSoapJsonResult(res.data, 'getTrackInfoResponse', 'getTrackInfoResult');
}

async function fetchCarWeight() {
  const soapBody = buildCarWeightSoap();
  const res = await axios.post(CAR_WEIGHT_URL, soapBody, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    timeout: 10000
  });
  return parseSoapJsonResult(res.data, 'getCarWeightByInfoResponse', 'getCarWeightByInfoResult');
}

// 將 TrackInfo + CarWeight 合併成一份列車清單
function buildMergedTrainList(trackInfo, carWeight) {
  const crowdByTrain = new Map();
  (carWeight || []).forEach(row => {
    const num = row.TrainNumber != null ? String(row.TrainNumber).trim() : '';
    if (!num) return;
    crowdByTrain.set(num, row);
  });

  return (trackInfo || []).map(row => {
    const num = row.TrainNumber != null ? String(row.TrainNumber).trim() : '';
    const crowd = crowdByTrain.get(num) || null;
    return {
      trainNumber: num,
      stationName: row.StationName || null,
      destinationName: row.DestinationName || null,
      countDown: row.CountDown || null,
      nowDateTime: row.NowDateTime || null,
      rawTrack: row,
      rawCrowd: crowd
    };
  });
}

// 測試用：先只放一個站碼，之後你可以自己補齊
const stationIdToName = {
  BL12: '忠孝新生站'
};

function normalizeStationName(name) {
  if (!name) return '';
  return String(name).replace(/站$/, '').trim();
}

async function updateData() {
  try {
    console.log('⏳ 更新 TRTC TrackInfo / CarWeight 中…');
    const [trackInfo, carWeight] = await Promise.all([
      fetchTrackInfo(),
      fetchCarWeight()
    ]);

    globalCache.lastUpdate = new Date().toISOString();
    globalCache.trackInfo = trackInfo;
    globalCache.carWeight = carWeight;
    globalCache.data = buildMergedTrainList(trackInfo, carWeight);
    globalCache.success = true;

    console.log(`✅ 更新完成：TrackInfo=${trackInfo.length} 筆, CarWeight=${carWeight.length} 筆`);
  } catch (e) {
    console.error('❌ 更新資料失敗:', e.message);
    globalCache.success = false;
  }
}

// 先跑一次，之後每 30 秒更新一次
updateData();
setInterval(updateData, 30000);

// ===== Routes =====
app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'TRTC API proxy running',
    lastUpdate: globalCache.lastUpdate,
    counts: {
      trackInfo: globalCache.trackInfo.length,
      carWeight: globalCache.carWeight.length,
      merged: globalCache.data.length
    }
  });
});

// 原始列車到站資訊（不處理，直接丟陣列）
app.get('/api/raw/track-info', (req, res) => {
  res.json({
    success: globalCache.success,
    lastUpdate: globalCache.lastUpdate,
    count: globalCache.trackInfo.length,
    itemsPreview: globalCache.trackInfo.slice(0, 50),
    items: globalCache.trackInfo
  });
});

// 原始擁擠度資料
app.get('/api/raw/car-weight', (req, res) => {
  res.json({
    success: globalCache.success,
    lastUpdate: globalCache.lastUpdate,
    count: globalCache.carWeight.length,
    itemsPreview: globalCache.carWeight.slice(0, 50),
    items: globalCache.carWeight
  });
});

// 依照站碼（例如 BL12）查該站的即時列車資訊 + 擁擠度
app.get('/api/station/:stationId', (req, res) => {
  const stationId = req.params.stationId;
  const stationName = stationIdToName[stationId] || stationId; // 找不到就直接用傳進來的字串
  const key = normalizeStationName(stationName);

  const trains = (globalCache.data || []).filter(t => {
    const name = normalizeStationName(t.stationName);
    return name && name.includes(key);
  });

  res.json({
    success: true,
    stationId,
    stationName,
    lastUpdate: globalCache.lastUpdate,
    count: trains.length,
    trains,
    note: 'stationIdToName 目前只先填 BL12=忠孝新生站，之後可以自行補齊其他站碼。'
  });
});

// 所有列車（已合併擁擠度）
app.get('/api/trains', (req, res) => {
  res.json({
    success: globalCache.success,
    serverTime: new Date().toISOString(),
    lastUpdate: globalCache.lastUpdate,
    count: globalCache.data.length,
    data: globalCache.data
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
